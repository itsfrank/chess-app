import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';
import type { Analysis, Candidate } from '../shared/protocol.ts';
import { ENGINE, ENGINE_TIMEOUT_MS } from './config.ts';

export type UciTrace = (direction: 'in' | 'out' | 'stderr', line: string) => void;

const INFO = /info depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)/;
const MAX_CONTINUATION = 10;

/**
 * Parses one exact-score MultiPV `info` line into a candidate, converting the
 * engine's side-to-move score to White's perspective. Returns undefined for
 * anything else, including bound-only scores and lines with unplayable moves.
 */
export function parseInfo(
  line: string,
  fen: string,
): { rank: number; candidate: Candidate } | undefined {
  const match = line.match(INFO);
  if (!match || /lowerbound|upperbound/.test(line)) return undefined;
  const [, depth, rank, type, value, pv] = match;
  const board = new Chess(fen);
  const sign = board.turn() === 'w' ? 1 : -1;
  const uci = pv.trim().split(/\s+/);
  const continuation: string[] = [];
  try {
    for (const move of uci.slice(0, MAX_CONTINUATION)) continuation.push(board.move(move).san);
  } catch {
    return undefined;
  }
  return {
    rank: Number(rank),
    candidate: {
      move: uci[0],
      san: continuation[0],
      evaluation: { type: type as 'cp' | 'mate', value: Number(value) * sign },
      continuation,
      depth: Number(depth),
    },
  };
}

function terminalAnalysis(board: Chess): Analysis {
  const winner = board.turn() === 'w' ? 'black' : 'white';
  return {
    fen: board.fen(),
    perspective: 'white',
    depth: 0,
    evaluation: board.isCheckmate() ? { type: 'mate', value: 0, winner } : { type: 'cp', value: 0 },
    moves: [],
  };
}

/**
 * Evaluates `fen` (after optional hypothetical SAN/UCI `moves`) with a fresh
 * Stockfish process and returns the top candidates at the deepest depth for
 * which every MultiPV line completed.
 */
export async function analyze(
  fen: string,
  moves: string[] = [],
  signal?: AbortSignal,
  trace?: UciTrace,
): Promise<Analysis> {
  const board = new Chess(fen);
  for (const move of moves) board.move(move);
  if (board.isGameOver()) return terminalAnalysis(board);
  const position = board.fen();
  const expected = Math.min(ENGINE.multiPV, board.moves().length);

  return new Promise<Analysis>((resolve, reject) => {
    const child = spawn(ENGINE.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = createInterface({ input: child.stdout });
    const errors = createInterface({ input: child.stderr });
    /** depth → MultiPV rank → candidate */
    const byDepth = new Map<number, Map<number, Candidate>>();
    let settled = false;

    const send = (command: string) => {
      trace?.('in', command);
      child.stdin.write(command + '\n');
    };
    const finish = (error?: Error, result?: Analysis) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      output.close();
      errors.close();
      child.kill();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new Error('Analysis cancelled'));
    const timer = setTimeout(() => finish(new Error('Stockfish timed out')), ENGINE_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    // A dead engine surfaces through 'error'/'exit'; ignore the resulting EPIPE.
    child.stdin.on('error', () => {});
    child.on('error', error => finish(new Error(`Cannot start Stockfish: ${error.message}`)));
    child.on('exit', () => finish(new Error('Stockfish exited unexpectedly')));
    errors.on('line', line => trace?.('stderr', line));
    output.on('line', line => {
      trace?.('out', line);
      if (line === 'uciok') {
        send(`setoption name MultiPV value ${ENGINE.multiPV}`);
        send(`setoption name Threads value ${ENGINE.threads}`);
        send(`setoption name Hash value ${ENGINE.hashMB}`);
        send('isready');
      } else if (line === 'readyok') {
        send(`position fen ${position}`);
        send(`go movetime ${ENGINE.movetime}`);
      } else if (line.startsWith('bestmove')) {
        const depth = [...byDepth.keys()]
          .sort((a, b) => b - a)
          .find(d => byDepth.get(d)!.size === expected);
        if (depth === undefined) return finish(new Error('No complete engine result'));
        const candidates = [...byDepth.get(depth)!.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, candidate]) => candidate);
        finish(undefined, {
          fen: position,
          perspective: 'white',
          depth,
          evaluation: candidates[0].evaluation,
          moves: candidates,
        });
      } else {
        const info = parseInfo(line, position);
        if (!info) return;
        const depth = info.candidate.depth;
        if (!byDepth.has(depth)) byDepth.set(depth, new Map());
        byDepth.get(depth)!.set(info.rank, info.candidate);
      }
    });
    send('uci');
  });
}
