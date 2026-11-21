import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';
import type { PositionEval } from '../shared/protocol.ts';
import { positionKey } from '../shared/repertoire.ts';
import { BATCH_ENGINE, ENGINE } from './config.ts';

const INFO = /info depth (\d+) .*?score (cp|mate) (-?\d+)(.*?) pv (\S+)/;
const SAVE_DELAY_MS = 5000;

/** The last exact score reported for the engine's `rank`-th choice, as the regex match. */
function lastScore(lines: string[], rank: number) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(INFO);
    if (!match || /bound/.test(match[4])) continue;
    if (Number(lines[index].match(/ multipv (\d+) /)?.[1] ?? 1) === rank) return match;
  }
  return undefined;
}

/** The evaluation the engine reported last, from White's perspective. */
export function parseEval(lines: string[], fen: string): PositionEval | undefined {
  const board = new Chess(fen);
  const sign = board.turn() === 'w' ? 1 : -1;
  const [first, second] = [lastScore(lines, 1), lastScore(lines, 2)];
  if (!first) return undefined;
  const score = (match: RegExpMatchArray) => ({
    type: match[2] as 'cp' | 'mate',
    value: Number(match[3]) * sign,
  });
  try {
    return {
      evaluation: score(first),
      best: board.move(first[5]).san,
      depth: Number(first[1]),
      ...(second && { second: score(second) }),
    };
  } catch {
    return undefined;
  }
}

function terminalEval(board: Chess): PositionEval {
  const winner = board.turn() === 'w' ? 'black' : 'white';
  return {
    evaluation: board.isCheckmate() ? { type: 'mate', value: 0, winner } : { type: 'cp', value: 0 },
    best: null,
    depth: 0,
  };
}

type Worker = { child: ChildProcessWithoutNullStreams | null; busy: boolean };
type Job = {
  fen: string;
  key: string;
  depth: number;
  signal?: AbortSignal;
  resolve: (result: PositionEval) => void;
  reject: (error: unknown) => void;
};

/**
 * Fixed-depth evaluations for many positions: a small pool of long-lived
 * Stockfish workers searching in parallel, with results kept on disk so each
 * position is searched once per depth. The deepest result for a position is
 * the one used; it is current while it is at least as deep as the configured
 * depth.
 */
export class Evaluator {
  /** Number of positions this evaluator can search at once. */
  readonly concurrency: number;
  /** Everything stored, by position and the depth it was searched at. */
  private cache = new Map<string, PositionEval>();
  /** The deepest result of each position, with the depth it was searched at. */
  private deepest = new Map<string, { depth: number; result: PositionEval }>();
  private workers: Worker[];
  private pending: Job[] = [];
  private inFlight = new Map<string, Promise<PositionEval>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly depthOf: () => number;
  private readonly multiPV: number;

  /**
   * `depth` is asked for before every search, so it can follow a setting. With
   * `multiPV` 2 every result also carries the score of the engine's second choice.
   */
  constructor(file: string, depth: () => number, multiPV = 1, workers = BATCH_ENGINE.workers) {
    this.file = file;
    this.depthOf = depth;
    this.multiPV = multiPV;
    this.concurrency = Math.max(1, workers);
    this.workers = Array.from({ length: this.concurrency }, () => ({ child: null, busy: false }));
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PositionEval>;
      for (const [storedKey, result] of Object.entries(stored)) {
        const [key, depth, lines] = storedKey.split('|');
        if ((lines ?? '') === this.lines) this.remember(key, Number(depth), result);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Marks stored results that also carry the engine's second choice. */
  private get lines() {
    return this.multiPV > 1 ? `pv${this.multiPV}` : '';
  }

  private remember(key: string, depth: number, result: PositionEval) {
    this.cache.set(`${key}|${depth}${this.lines && `|${this.lines}`}`, result);
    // A finished game has nothing to search, so its verdict is as deep as any.
    const reached = result.best === null && result.depth === 0 ? Infinity : depth;
    if (reached >= (this.deepest.get(key)?.depth ?? -1)) {
      this.deepest.set(key, { depth: reached, result });
    }
  }

  /** The deepest stored evaluation of a position, whatever depth is configured now. */
  cached(key: string): PositionEval | undefined {
    return this.deepest.get(key)?.result;
  }

  /** Whether the position has been searched at least as deep as is configured now. */
  current(key: string): boolean {
    return (this.deepest.get(key)?.depth ?? -1) >= this.depthOf();
  }

  /** Evaluates `fen`, searching only if no stored result is deep enough. */
  evaluate(fen: string, signal?: AbortSignal): Promise<PositionEval> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Evaluation aborted'));
    const key = positionKey(fen);
    if (this.current(key)) return Promise.resolve(this.cached(key)!);
    const depth = this.depthOf();
    const board = new Chess(fen);
    if (board.isGameOver()) {
      const result = terminalEval(board);
      this.remember(key, depth, result);
      this.saveSoon();
      return Promise.resolve(result);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const flight = new Promise<PositionEval>((resolve, reject) => {
      this.pending.push({ fen, key, depth, signal, resolve, reject });
    });
    this.inFlight.set(key, flight);
    // Avoid unhandled rejection if a caller drops the handle while the pool drains.
    flight.catch(() => {});
    this.pump();
    return flight;
  }

  private pump() {
    while (this.pending.length) {
      const worker = this.workers.find(slot => !slot.busy);
      if (!worker) return;
      const job = this.pending.shift()!;
      if (job.signal?.aborted) {
        this.inFlight.delete(job.key);
        job.reject(job.signal.reason ?? new Error('Evaluation aborted'));
        continue;
      }
      if (this.current(job.key)) {
        this.inFlight.delete(job.key);
        job.resolve(this.cached(job.key)!);
        continue;
      }
      worker.busy = true;
      void this.search(worker, job.fen, job.depth)
        .then(
          result => {
            this.remember(job.key, job.depth, result);
            this.saveSoon();
            this.inFlight.delete(job.key);
            job.resolve(result);
          },
          error => {
            this.inFlight.delete(job.key);
            job.reject(error);
          },
        )
        .finally(() => {
          worker.busy = false;
          this.pump();
        });
    }
  }

  private engine(worker: Worker): ChildProcessWithoutNullStreams {
    if (worker.child) return worker.child;
    const child = spawn(ENGINE.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', () => {
      if (worker.child === child) worker.child = null;
    });
    child.stdin.write(
      `uci\nsetoption name Threads value ${BATCH_ENGINE.threads}\n` +
        `setoption name Hash value ${BATCH_ENGINE.hashMB}\n` +
        `setoption name MultiPV value ${this.multiPV}\n`,
    );
    return (worker.child = child);
  }

  private search(worker: Worker, fen: string, depth: number): Promise<PositionEval> {
    const child = this.engine(worker);
    return new Promise((resolve, reject) => {
      const output = createInterface({ input: child.stdout });
      const lines: string[] = [];
      const finish = (error?: Error, result?: PositionEval) => {
        clearTimeout(timer);
        output.close();
        child.off('exit', onExit);
        child.off('error', onError);
        if (error) {
          // A hung or broken engine is replaced on the next search.
          child.kill();
          if (worker.child === child) worker.child = null;
          reject(error);
        } else resolve(result!);
      };
      const onExit = () => finish(new Error('Stockfish exited unexpectedly'));
      const onError = (error: Error) =>
        finish(new Error(`Cannot start Stockfish: ${error.message}`));
      const timer = setTimeout(
        () => finish(new Error('Stockfish timed out')),
        BATCH_ENGINE.timeoutMs,
      );
      child.once('exit', onExit);
      child.once('error', onError);
      output.on('line', line => {
        if (line.startsWith('info depth')) lines.push(line);
        else if (line.startsWith('bestmove')) {
          const result = parseEval(lines, fen);
          if (result) finish(undefined, result);
          else finish(new Error('No engine result'));
        }
      });
      child.stdin.write(`position fen ${fen}\ngo depth ${depth}\n`);
    });
  }

  private saveSoon() {
    this.saveTimer ??= setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.cache)));
  }

  /** Stops idle engines once the running searches have finished or failed. */
  release() {
    for (const worker of this.workers) {
      if (!worker.busy && worker.child) {
        worker.child.stdin.write('quit\n');
        worker.child = null;
      }
    }
  }

  dispose() {
    if (this.saveTimer) this.save();
    for (const job of this.pending.splice(0)) {
      this.inFlight.delete(job.key);
      job.reject(new Error('Evaluator disposed'));
    }
    for (const worker of this.workers) {
      worker.child?.kill();
      worker.child = null;
      worker.busy = false;
    }
  }
}
