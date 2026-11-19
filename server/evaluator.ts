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

/**
 * Fixed-depth evaluations for many positions: one long-lived Stockfish
 * process, one search at a time, and results kept on disk so a repertoire is
 * only ever searched once per position.
 */
export class Evaluator {
  private cache = new Map<string, PositionEval>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly depth: number;
  private readonly multiPV: number;

  /** With `multiPV` 2 every result also carries the score of the engine's second choice. */
  constructor(file: string, depth: number = BATCH_ENGINE.depth, multiPV = 1) {
    this.file = file;
    this.depth = depth;
    this.multiPV = multiPV;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PositionEval>;
      this.cache = new Map(Object.entries(stored));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private cacheKey = (key: string) =>
    `${key}|${this.depth}${this.multiPV > 1 ? `|pv${this.multiPV}` : ''}`;

  /** The stored evaluation of a position, if it has been searched. */
  cached(key: string): PositionEval | undefined {
    return this.cache.get(this.cacheKey(key));
  }

  /** Evaluates `fen`, searching only if there is no stored result. */
  evaluate(fen: string, signal?: AbortSignal): Promise<PositionEval> {
    const key = positionKey(fen);
    const run = this.queue.then(async () => {
      signal?.throwIfAborted();
      const known = this.cached(key);
      if (known) return known;
      const board = new Chess(fen);
      const result = board.isGameOver() ? terminalEval(board) : await this.search(fen);
      this.cache.set(this.cacheKey(key), result);
      this.saveSoon();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private engine(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(ENGINE.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    child.stdin.write(
      `uci\nsetoption name Threads value ${BATCH_ENGINE.threads}\n` +
        `setoption name Hash value ${BATCH_ENGINE.hashMB}\n` +
        `setoption name MultiPV value ${this.multiPV}\n`,
    );
    return (this.child = child);
  }

  private search(fen: string): Promise<PositionEval> {
    const child = this.engine();
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
          if (this.child === child) this.child = null;
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
      child.stdin.write(`position fen ${fen}\ngo depth ${this.depth}\n`);
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

  /** Stops the engine once the running search has finished or failed. */
  release() {
    this.child?.stdin.write('quit\n');
    this.child = null;
  }

  dispose() {
    if (this.saveTimer) this.save();
    this.child?.kill();
    this.child = null;
  }
}
