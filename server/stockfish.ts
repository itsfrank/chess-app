import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';

export async function analyze(fen: string, moves: string[] = [], signal?: AbortSignal, trace?: (direction: 'in' | 'out' | 'stderr', line: string) => void) {
  const board = new Chess(fen);
  for (const move of moves) board.move(move);
  const position = board.fen();
  if (board.isGameOver()) return { fen: position, evaluation: board.isCheckmate() ? { type: 'mate', value: 0, winner: board.turn() === 'w' ? 'black' : 'white' } : { type: 'cp', value: 0 }, moves: [], depth: 0 };
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.STOCKFISH_PATH || 'stockfish', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = createInterface({ input: child.stdout });
    const lines = new Map<number, Map<number, object>>();
    const send = (command: string) => { trace?.('in', command); child.stdin.write(command + '\n'); };
    const errors = createInterface({ input: child.stderr });
    errors.on('line', line => trace?.('stderr', line));
    let settled = false;
    const finish = (error?: Error, result?: object) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      reader.close(); errors.close(); child.kill(); error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('Analysis cancelled'));
    const timer = setTimeout(() => finish(new Error('Stockfish timed out')), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', error => finish(new Error(`Cannot start Stockfish: ${error.message}`)));
    child.on('exit', () => { if (!settled) finish(new Error('Stockfish exited unexpectedly')); });
    reader.on('line', line => {
      trace?.('out', line);
      if (line === 'uciok') { send('setoption name MultiPV value 3'); send('setoption name Threads value 1'); send('setoption name Hash value 32'); send('isready'); }
      if (line === 'readyok') { send(`position fen ${position}`); send('go movetime 1500'); }
      const match = line.match(/info depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)/);
      if (match && !/lowerbound|upperbound/.test(line)) {
        const [, depth, rank, type, value, pv] = match;
        const replay = new Chess(position); const san: string[] = [];
        try { for (const uci of pv.trim().split(/\s+/).slice(0, 10)) san.push(replay.move(uci).san); } catch { return; }
        const row = { move: pv.split(' ')[0], san: san[0], evaluation: { type, value: Number(value) * (board.turn() === 'w' ? 1 : -1) }, continuation: san, depth: Number(depth) };
        if (!lines.has(Number(depth))) lines.set(Number(depth), new Map());
        lines.get(Number(depth))!.set(Number(rank), row);
      }
      if (line.startsWith('bestmove')) {
        const count = Math.min(3, board.moves().length);
        const depth = [...lines.keys()].sort((a,b) => b-a).find(d => lines.get(d)!.size === count);
        if (depth === undefined) { finish(new Error('No complete engine result')); return; }
        const rows = [...lines.get(depth)!.entries()].sort(([a],[b]) => a-b).map(([,row]) => row);
        finish(undefined, { fen: position, perspective: 'white', depth, evaluation: (rows[0] as { evaluation: object }).evaluation, moves: rows });
      }
    });
    send('uci');
  });
}
