import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';

export function opponentPosition(input: unknown) {
  const body = input as { moves?: unknown; fen?: unknown; elo?: unknown; playerColor?: unknown } | null;
  if (!body || !Array.isArray(body.moves) || body.moves.length > 2000 || !body.moves.every(m => typeof m === 'string')) throw new Error('Invalid move history');
  if (!Number.isInteger(body.elo) || ![1000, 1200, 1500, 1800, 2000].includes(body.elo as number)) throw new Error('Choose a supported opponent rating');
  if (body.playerColor !== 'white' && body.playerColor !== 'black') throw new Error('Invalid player color');
  const board = new Chess();
  const moves: string[] = [];
  for (const san of body.moves) { const m = board.move(san); moves.push(m.from + m.to + (m.promotion || '')); }
  if (board.fen() !== body.fen) throw new Error('Position does not match move history');
  if (board.isGameOver()) throw new Error('The game has ended');
  if (board.turn() === (body.playerColor === 'white' ? 'w' : 'b')) throw new Error('It is your turn');
  return { board, moves, elo: body.elo as number };
}

export class MaiaOpponent {
  private child?: ChildProcessWithoutNullStreams;
  private waiting?: { accept: (line: string) => boolean; resolve: (line: string) => void; reject: (error: Error) => void };
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private ready = false;
  private lastError = '';
  private send(line: string) { this.child!.stdin.write(line + '\n'); }
  private wait(command: string, accept: (line: string) => boolean, milliseconds: number) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = undefined; this.close(); reject(new Error('Maia3 timed out. Please retry.')); }, milliseconds);
      this.waiting = { accept, resolve: line => { clearTimeout(timer); resolve(line); }, reject: error => { clearTimeout(timer); reject(error); } };
      this.send(command);
    });
  }
  private async start() {
    if (this.ready) return;
    const local = resolve('.data/maia3-spike/venv/bin/maia3-uci');
    const executable = process.env.MAIA3_PATH || (existsSync(local) ? local : 'maia3-uci');
    const cache = resolve('.data/maia3-spike/huggingface');
    const child = spawn(executable, ['--model', 'maia3-5m', '--device', 'cpu', '--no-use-amp', '--use-uci-history', '--local-files-only', '--multipv', '1'], {
      env: {
        ...process.env,
        // Avoid CPU oversubscription on shared hosts; only constrain Maia3.
        OMP_NUM_THREADS: '1',
        MKL_NUM_THREADS: '1',
        ...(existsSync(cache) && !process.env.HF_HOME ? { HF_HOME: cache } : {}),
      },
    });
    this.child = child;
    this.lastError = '';
    const reader = createInterface({ input: child.stdout });
    const errors = createInterface({ input: child.stderr });
    errors.on('line', line => { this.lastError = line.slice(0, 500); });
    reader.on('line', line => {
      const waiting = this.waiting;
      if (waiting?.accept(line)) { this.waiting = undefined; waiting.resolve(line); }
    });
    const failed = (message: string) => {
      if (this.child !== child) return;
      this.close();
      const waiting = this.waiting; this.waiting = undefined;
      waiting?.reject(new Error(message));
    };
    child.stdin.on('error', () => failed('Cannot communicate with Maia3. Please retry.'));
    child.on('error', () => failed('Maia3 is unavailable. Check MAIA3_PATH and the cached 5M model.'));
    child.on('exit', () => { reader.close(); errors.close(); failed(`Maia3 exited. ${this.lastError || 'Check the cached 5M model and retry.'}`); });
    await this.wait('uci', line => line === 'uciok', 30000);
    await this.wait('isready', line => line === 'readyok', 30000);
    this.ready = true;
  }
  async move(input: unknown, signal?: AbortSignal) {
    const position = opponentPosition(input);
    if (this.pending >= 8) throw new Error('Maia3 is busy. Please retry shortly.');
    this.pending++;
    const run = this.tail.then(async () => {
      if (signal?.aborted) throw new Error('Opponent request cancelled');
      await this.start();
      if (signal?.aborted) throw new Error('Opponent request cancelled');
      this.send(`setoption name Elo value ${position.elo}`);
      this.send('setoption name Temperature value 1');
      this.send('setoption name TopP value 1');
      this.send(`position startpos${position.moves.length ? ' moves ' + position.moves.join(' ') : ''}`);
      const line = await this.wait('go nodes 1', line => line.startsWith('bestmove '), 15000);
      if (signal?.aborted) throw new Error('Opponent request cancelled');
      const uci = line.split(/\s+/)[1];
      const move = position.board.move(uci);
      return { move: uci, san: move.san, fen: position.board.fen() };
    });
    this.tail = run.catch(() => {});
    try { return await run; } finally { this.pending--; }
  }
  close() { this.ready = false; const child = this.child; this.child = undefined; child?.kill(); }
}
export const opponent = new MaiaOpponent();
