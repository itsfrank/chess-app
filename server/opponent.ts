import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPPONENT_ELOS, type OpponentMove } from '../shared/protocol.ts';
import { MAIA_DIR } from './config.ts';
import { HttpError } from './http.ts';
import { parsePlayerColor, replaySnapshot } from './snapshot.ts';

const START_TIMEOUT_MS = 30_000;
const MOVE_TIMEOUT_MS = 15_000;
const MAX_PENDING = 8;

/** Validates an opponent request: a live game in which it is the engine's turn. */
export function opponentPosition(input: unknown) {
  const { board, uci } = replaySnapshot(input);
  const { elo, playerColor } = input as { elo?: unknown; playerColor?: unknown };
  if (!(OPPONENT_ELOS as readonly unknown[]).includes(elo)) {
    throw new HttpError(400, 'Choose a supported opponent rating');
  }
  const human = parsePlayerColor(playerColor) === 'white' ? 'w' : 'b';
  if (board.isGameOver()) throw new HttpError(400, 'The game has ended');
  if (board.turn() === human) throw new HttpError(400, 'It is your turn');
  return { board, moves: uci, elo: elo as number };
}

type Waiting = {
  accept: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

/**
 * One persistent Maia3 UCI subprocess (loading the model is slow), started on
 * first use and restarted after any failure. Requests are served one at a time.
 */
export class MaiaOpponent {
  private child?: ChildProcessWithoutNullStreams;
  private waiting?: Waiting;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private ready = false;
  private lastError = '';

  async move(input: unknown, signal?: AbortSignal): Promise<OpponentMove> {
    const position = opponentPosition(input);
    if (this.pending >= MAX_PENDING)
      throw new HttpError(503, 'Maia3 is busy. Please retry shortly.');
    this.pending++;
    const checkCancelled = () => {
      if (signal?.aborted) throw new Error('Opponent request cancelled');
    };
    const run = this.tail.then(async () => {
      checkCancelled();
      await this.start();
      checkCancelled();
      this.send(`setoption name Elo value ${position.elo}`);
      this.send('setoption name Temperature value 1');
      this.send('setoption name TopP value 1');
      this.send(
        `position startpos${position.moves.length ? ' moves ' + position.moves.join(' ') : ''}`,
      );
      const reply = await this.wait(
        'go nodes 1',
        line => line.startsWith('bestmove '),
        MOVE_TIMEOUT_MS,
      );
      checkCancelled();
      const uci = reply.split(/\s+/)[1];
      const move = position.board.move(uci);
      return { move: uci, san: move.san, fen: position.board.fen() };
    });
    this.tail = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.pending--;
    }
  }

  close() {
    this.ready = false;
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private send(line: string) {
    this.child!.stdin.write(line + '\n');
  }

  /** Sends `command` and resolves with the first output line that `accept` matches. */
  private wait(command: string, accept: (line: string) => boolean, milliseconds: number) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        this.close();
        reject(new Error('Maia3 timed out. Please retry.'));
      }, milliseconds);
      this.waiting = {
        accept,
        resolve: line => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.send(command);
    });
  }

  private async start() {
    if (this.ready) return;
    const local = join(MAIA_DIR, 'venv/bin/maia3-uci');
    const executable = process.env.MAIA3_PATH || (existsSync(local) ? local : 'maia3-uci');
    const cache = join(MAIA_DIR, 'huggingface');
    // One thread each keeps Maia3 from oversubscribing the CPU on shared hosts.
    const env: NodeJS.ProcessEnv = { ...process.env, OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
    if (!env.HF_HOME && existsSync(cache)) env.HF_HOME = cache;
    const args = ['--model', 'maia3-5m', '--device', 'cpu', '--no-use-amp', '--use-uci-history'];
    const child = spawn(executable, [...args, '--local-files-only', '--multipv', '1'], { env });
    this.child = child;
    this.lastError = '';

    const output = createInterface({ input: child.stdout });
    const errors = createInterface({ input: child.stderr });
    errors.on('line', line => {
      this.lastError = line.slice(0, 500);
    });
    output.on('line', line => {
      const waiting = this.waiting;
      if (!waiting?.accept(line)) return;
      this.waiting = undefined;
      waiting.resolve(line);
    });
    const failed = (message: string) => {
      if (this.child !== child) return;
      this.close();
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.reject(new Error(message));
    };
    child.stdin.on('error', () => failed('Cannot communicate with Maia3. Please retry.'));
    child.on('error', () =>
      failed('Maia3 is unavailable. Check MAIA3_PATH and the cached 5M model.'),
    );
    child.on('exit', () => {
      output.close();
      errors.close();
      failed(`Maia3 exited. ${this.lastError || 'Check the cached 5M model and retry.'}`);
    });

    await this.wait('uci', line => line === 'uciok', START_TIMEOUT_MS);
    await this.wait('isready', line => line === 'readyok', START_TIMEOUT_MS);
    this.ready = true;
  }
}
