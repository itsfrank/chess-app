import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findConsolidations, type Finding, type Rule } from '../shared/consolidation.ts';
import { findHabits, type HabitGame, type Habits } from '../shared/habits.ts';
import {
  DEFAULT_SETTINGS,
  type GameArchivePage,
  type PlayerColor,
  type PositionEval,
  type RepertoireJob,
  type RepertoireReport,
  type RepertoireSettings,
  type RepertoireSummary,
} from '../shared/protocol.ts';
import {
  applyChanges,
  buildGraph,
  decisionCount,
  isMine,
  type Change,
  type Graph,
} from '../shared/repertoire.ts';
import { reachProbabilities } from '../shared/soundness.ts';
import {
  DEFAULT_RATINGS,
  EVAL_CACHE_FILE,
  FREQUENCY_CACHE_FILE,
  FREQUENCY_SPACING_MS,
  FREQUENCY_SPEEDS,
  HABITS,
  REPERTOIRES_DIR,
} from './config.ts';
import { listGames } from './chesscom.ts';
import { Evaluator } from './evaluator.ts';
import { errorMessage, HttpError } from './http.ts';
import { explore, ratings as ratingBuckets } from './lichess.ts';

/** What is stored per repertoire: the PGN exactly as imported, and what the user decided since. */
type Stored = {
  id: string;
  name: string;
  side: PlayerColor;
  pgn: string;
  importedAt: string;
  settings: RepertoireSettings;
  changes: Change[];
  dismissed: string[];
  /** The player's recent games as this repertoire's side, cut to their openings. */
  games?: { username: string; fetchedAt: string; list: HabitGame[] };
};

type Computed = {
  version: string;
  imported: { positions: number; decisions: number };
  graph: Graph;
  skipped: Set<string>;
  /** Where each change was made, looked up before it was applied. */
  changePaths: Map<string, string[]>;
  rules: Rule[];
  findings: Finding[];
  habits: Habits | null;
};

/** A page of a player's games, newest first, ending before `before` when given. */
export type GameLoader = (username: string, before?: number) => Promise<GameArchivePage>;

/** Share of games in which each move was played from a position, by SAN. */
export type Frequencies = Record<string, number>;
export type FrequencyLoader = (
  fen: string,
  ratings: number[],
  signal: AbortSignal,
) => Promise<Frequencies>;

const lichessFrequencies: FrequencyLoader = async (fen, ratings, signal) => {
  const result = await explore(fen, { ratings, speeds: FREQUENCY_SPEEDS }, signal);
  return Object.fromEntries(result.moves.map(move => [move.san, move.frequency ?? 0]));
};

/** A JSON object kept in memory and written back shortly after it changes. */
export class JsonCache<T> {
  private data: Record<string, T> = {};
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  get = (key: string): T | undefined => this.data[key];
  set(key: string, value: T) {
    this.data[key] = value;
    this.timer ??= setTimeout(() => this.flush(), 5000);
  }
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });
}

const RATE_LIMITED = 'Lichess rate limit reached; frequencies will continue shortly.';
const RATE_LIMIT_RETRIES = 30;

export type RepertoireOptions = {
  dir?: string;
  evaluator?: Pick<Evaluator, 'cached' | 'current' | 'evaluate' | 'release' | 'dispose'>;
  frequencyFile?: string;
  loadFrequencies?: FrequencyLoader;
  loadGames?: GameLoader;
  /** The engine depth to analyse at, asked for before every search. */
  depth?: () => number;
  /** How long to wait after the explorer reports its rate limit. */
  rateLimitWaitMs?: number;
  /** Gap between explorer requests, across all repertoires being analysed. */
  frequencySpacingMs?: number;
};

/**
 * Imported repertoires, the changes accepted on top of them, and the
 * background passes that evaluate their positions and fetch move frequencies.
 */
export class RepertoireService {
  private readonly dir: string;
  private readonly evaluator: NonNullable<RepertoireOptions['evaluator']>;
  private readonly frequencies: JsonCache<Frequencies>;
  private readonly loadFrequencies: FrequencyLoader;
  private readonly loadGames: GameLoader;
  private readonly depth: () => number;
  private readonly rateLimitWaitMs: number;
  private readonly frequencySpacingMs: number;
  private nextFrequencyAt = 0;
  private computed = new Map<string, Computed>();
  private jobs = new Map<string, { controller: AbortController; error: string | null }>();
  private errors = new Map<string, string>();

  constructor(options: RepertoireOptions = {}) {
    this.dir = options.dir ?? REPERTOIRES_DIR;
    this.depth = options.depth ?? (() => DEFAULT_SETTINGS.repertoireDepth);
    this.evaluator = options.evaluator ?? new Evaluator(EVAL_CACHE_FILE, this.depth);
    this.frequencies = new JsonCache(options.frequencyFile ?? FREQUENCY_CACHE_FILE);
    this.loadFrequencies = options.loadFrequencies ?? lichessFrequencies;
    this.loadGames = options.loadGames ?? listGames;
    this.rateLimitWaitMs = options.rateLimitWaitMs ?? 65_000;
    this.frequencySpacingMs = options.frequencySpacingMs ?? FREQUENCY_SPACING_MS;
  }

  private file = (id: string) => join(this.dir, `${id}.json`);

  private load(id: string): Stored {
    if (!/^[\w-]+$/.test(id)) throw new HttpError(404, 'Repertoire not found');
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'Repertoire not found');
      }
      throw error;
    }
  }

  private save(stored: Stored) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(stored.id), JSON.stringify(stored, null, 2));
  }

  /** The working graph and its findings, recomputed only when the accepted changes differ. */
  private compute(stored: Stored): Computed {
    const version = `${stored.changes.map(change => change.id).join(',')}|${stored.games?.fetchedAt}`;
    const known = this.computed.get(stored.id);
    if (known?.version === version) return known;
    const base = buildGraph(stored.pgn, stored.side);
    const changePaths = new Map<string, string[]>();
    let graph = base;
    const skipped = new Set<string>();
    for (const change of stored.changes) {
      changePaths.set(change.id, graph.nodes[change.key]?.path ?? []);
      const next = applyChanges(graph, [change]);
      graph = next.graph;
      next.skipped.forEach(id => skipped.add(id));
    }
    const result: Computed = {
      version,
      imported: { positions: Object.keys(base.nodes).length, decisions: decisionCount(base) },
      graph,
      skipped,
      changePaths,
      ...findConsolidations(graph),
      habits: stored.games ? findHabits(graph, stored.games.list) : null,
    };
    this.computed.set(stored.id, result);
    return result;
  }

  private summary(stored: Stored): RepertoireSummary {
    return {
      id: stored.id,
      name: stored.name,
      side: stored.side,
      importedAt: stored.importedAt,
      decisions: decisionCount(this.compute(stored).graph),
      accepted: stored.changes.length,
    };
  }

  list(): RepertoireSummary[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter(file => file.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return files
      .map(file => this.summary(this.load(file.slice(0, -5))))
      .sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }

  import(body: unknown): RepertoireReport {
    const { name, pgn, side } = (body ?? {}) as Record<string, unknown>;
    if (typeof pgn !== 'string' || !pgn.trim()) throw new HttpError(400, 'Missing PGN');
    if (side !== undefined && side !== 'white' && side !== 'black') {
      throw new HttpError(400, 'Invalid side');
    }
    let graph: Graph;
    try {
      graph = buildGraph(pgn, side);
    } catch (error) {
      throw new HttpError(400, errorMessage(error, 'Invalid PGN'));
    }
    const title =
      (typeof name === 'string' && name.trim()) ||
      pgn.match(/\[Event "([^"]+)"\]/)?.[1] ||
      'Repertoire';
    const stored: Stored = {
      id: randomUUID(),
      name: title.slice(0, 100),
      side: graph.side,
      pgn,
      importedAt: new Date().toISOString(),
      settings: { ratings: DEFAULT_RATINGS },
      changes: [],
      dismissed: [],
    };
    this.save(stored);
    return this.report(stored.id);
  }

  remove(id: string) {
    this.load(id);
    this.stop(id);
    this.computed.delete(id);
    rmSync(this.file(id));
  }

  private frequencyKey = (key: string, settings: RepertoireSettings) =>
    `${key}|${settings.ratings.join(',')}|${FREQUENCY_SPEEDS.join(',')}`;

  /** Positions the two background passes cover for the repertoire as it stands. */
  private targets(stored: Stored, computed: Computed) {
    const nodes = Object.values(computed.graph.nodes);
    const fens = new Map(nodes.map(node => [node.key, node.fen]));
    const proposals = [
      ...computed.findings,
      ...(computed.habits?.habits.map(habit => habit.finding) ?? []),
    ];
    for (const finding of proposals) fens.set(finding.after.key, finding.after.fen);
    return {
      evals: [...fens].map(([key, fen]) => ({ key, fen })),
      frequencies: nodes.filter(node => !isMine(computed.graph, node) && node.moves.length),
      frequencyKey: (key: string) => this.frequencyKey(key, stored.settings),
    };
  }

  report(id: string): RepertoireReport {
    const stored = this.load(id);
    const computed = this.compute(stored);
    const targets = this.targets(stored, computed);

    // Verdicts from a shallower search than is configured now are still shown, and counted.
    const evals: Record<string, PositionEval> = {};
    let evalStale = 0;
    for (const { key } of targets.evals) {
      const known = this.evaluator.cached(key);
      if (!known) continue;
      evals[key] = known;
      if (!this.evaluator.current(key)) evalStale++;
    }
    const frequencies: Record<string, Frequencies | undefined> = {};
    let frequencyDone = 0;
    for (const node of targets.frequencies) {
      const known = this.frequencies.get(targets.frequencyKey(node.key));
      if (known) frequencyDone++;
      frequencies[node.key] = known;
    }
    const job: RepertoireJob = {
      running: this.jobs.has(id),
      evalDone: Object.keys(evals).length,
      evalTotal: targets.evals.length,
      evalStale,
      frequencyDone,
      frequencyTotal: targets.frequencies.length,
      error: this.jobs.get(id)?.error ?? this.errors.get(id) ?? null,
    };
    return {
      ...this.summary(stored),
      settings: stored.settings,
      imported: computed.imported,
      graph: computed.graph,
      rules: computed.rules,
      findings: computed.findings,
      dismissed: stored.dismissed,
      habits:
        computed.habits && stored.games
          ? {
              ...computed.habits,
              username: stored.games.username,
              fetchedAt: stored.games.fetchedAt,
            }
          : null,
      changes: stored.changes.map(change => ({
        ...change,
        active: !computed.skipped.has(change.id),
        path: computed.changePaths.get(change.id) ?? [],
      })),
      evals,
      reach: reachProbabilities(computed.graph, frequencies),
      reachComplete: frequencyDone === targets.frequencies.length,
      job,
      engineDepth: this.depth(),
    };
  }

  /** Records the finding as a deviation from the import and applies it. */
  accept(id: string, findingId: unknown): RepertoireReport {
    const stored = this.load(id);
    const computed = this.compute(stored);
    const finding =
      computed.findings.find(item => item.id === findingId) ??
      computed.habits?.habits.find(habit => habit.finding.id === findingId)?.finding;
    if (!finding) throw new HttpError(404, 'That proposal no longer applies');
    stored.changes.push({
      id: randomUUID(),
      key: finding.key,
      from: finding.current,
      to: finding.proposed,
      plan: finding.plan,
      acceptedAt: new Date().toISOString(),
    });
    this.save(stored);
    return this.resume(id);
  }

  /**
   * Fetches the player's recent chess.com games and keeps the openings of those
   * played as this repertoire's side, to be compared with it.
   */
  async syncGames(id: string, username: unknown): Promise<RepertoireReport> {
    this.load(id);
    if (typeof username !== 'string') throw new HttpError(400, 'Enter a chess.com username');
    const list: HabitGame[] = [];
    let name = username;
    let before: number | undefined;
    for (let page = 0, seen = 0; page < HABITS.pages && seen < HABITS.games; page++) {
      const { username: spelled, games, older } = await this.loadGames(username, before);
      name = spelled;
      seen += games.length;
      // Loaded again here: the repertoire may have been changed while the pages were fetched.
      const { side } = this.load(id);
      for (const game of games) {
        if (game.playerColor !== side) continue;
        const { url, playedAt, moves } = game;
        list.push({ url, playedAt, moves: moves.slice(0, HABITS.plies) });
      }
      if (older === null) break;
      before = older;
    }
    const stored = this.load(id);
    stored.games = { username: name, fetchedAt: new Date().toISOString(), list };
    this.save(stored);
    return this.resume(id);
  }

  revert(id: string, changeId: unknown): RepertoireReport {
    const stored = this.load(id);
    if (!stored.changes.some(change => change.id === changeId)) {
      throw new HttpError(404, 'Change not found');
    }
    stored.changes = stored.changes.filter(change => change.id !== changeId);
    this.save(stored);
    return this.resume(id);
  }

  /** A changed repertoire has new positions; keep analysing if the user had started to. */
  private resume(id: string): RepertoireReport {
    const report = this.report(id);
    const { running, evalDone, evalTotal } = report.job;
    return !running && evalDone > 0 && evalDone < evalTotal ? this.analyze(id) : report;
  }

  dismiss(id: string, findingId: unknown, dismissed: unknown): RepertoireReport {
    const stored = this.load(id);
    if (typeof findingId !== 'string') throw new HttpError(400, 'Missing proposal');
    stored.dismissed = stored.dismissed.filter(item => item !== findingId);
    if (dismissed !== false) stored.dismissed.push(findingId);
    this.save(stored);
    return this.report(id);
  }

  /** Starts the engine and explorer passes, optionally with a new rating range. */
  analyze(id: string, ratings?: unknown): RepertoireReport {
    const stored = this.load(id);
    if (ratings !== undefined) {
      const chosen = Array.isArray(ratings) ? [...new Set(ratings as number[])] : [];
      if (!chosen.length || chosen.some(rating => !ratingBuckets.includes(rating))) {
        throw new HttpError(400, 'Invalid rating range');
      }
      stored.settings = { ratings: chosen.sort((a, b) => a - b) };
      this.save(stored);
    }
    this.stop(id);
    this.errors.delete(id);
    const job = { controller: new AbortController(), error: null as string | null };
    this.jobs.set(id, job);
    void this.run(stored, job).finally(() => {
      if (this.jobs.get(id) !== job) return;
      this.jobs.delete(id);
      if (job.error) this.errors.set(id, job.error);
      if (!this.jobs.size) this.evaluator.release();
      this.frequencies.flush();
    });
    return this.report(id);
  }

  stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.controller.abort();
    this.jobs.delete(id);
    if (!this.jobs.size) this.evaluator.release();
    this.frequencies.flush();
  }

  /** Holds explorer requests to a steady rate the explorer accepts. */
  private async pace(signal: AbortSignal) {
    const start = Math.max(Date.now(), this.nextFrequencyAt);
    this.nextFrequencyAt = start + this.frequencySpacingMs;
    await sleep(start - Date.now(), signal);
  }

  private async run(stored: Stored, job: { controller: AbortController; error: string | null }) {
    const { signal } = job.controller;
    const targets = this.targets(stored, this.compute(stored));
    /** Runs one pass to completion; a failure stops that pass only. */
    const pass = async (label: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        if (!signal.aborted) job.error = `${label}: ${errorMessage(error)}`;
      }
    };
    await Promise.all([
      pass('Engine', async () => {
        for (const { key, fen } of targets.evals) {
          signal.throwIfAborted();
          if (!this.evaluator.current(key)) await this.evaluator.evaluate(fen, signal);
        }
      }),
      pass('Lichess', async () => {
        for (const node of targets.frequencies) {
          signal.throwIfAborted();
          const key = targets.frequencyKey(node.key);
          if (this.frequencies.get(key)) continue;
          for (let attempt = 0; ; attempt++) {
            await this.pace(signal);
            try {
              const found = await this.loadFrequencies(node.fen, stored.settings.ratings, signal);
              this.frequencies.set(key, found);
              if (job.error === RATE_LIMITED) job.error = null;
              break;
            } catch (error) {
              const limited = /rate limit/i.test(errorMessage(error));
              if (signal.aborted || !limited || attempt >= RATE_LIMIT_RETRIES) throw error;
              // The explorer allows only short bursts; wait it out rather than give up.
              job.error = RATE_LIMITED;
              await sleep(this.rateLimitWaitMs, signal);
            }
          }
        }
      }),
    ]);
  }

  dispose() {
    for (const id of [...this.jobs.keys()]) this.stop(id);
    this.frequencies.flush();
    this.evaluator.dispose();
  }
}
