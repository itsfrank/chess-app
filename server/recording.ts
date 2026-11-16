import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PlayerColor, ServerEvent, Snapshot, Totals } from '../shared/protocol.ts';

export type TurnInput = Snapshot & { message: string; playerColor?: PlayerColor };
type Entry = { version: 1; seq: number; at: string; kind: string; data: unknown };
type Turn = { input: TurnInput; events: ServerEvent[] };

/**
 * Append-only JSONL log of one conversation. Writes are synchronous so a crash
 * loses nothing and entries stay in exact order.
 */
export class Recorder {
  readonly path: string;
  private seq = 0;

  constructor(directory: string, metadata: object) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${randomUUID()}.jsonl`);
    this.record('session', metadata);
  }

  record(kind: string, data: unknown) {
    const entry: Entry = { version: 1, seq: this.seq++, at: new Date().toISOString(), kind, data };
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}

/** Plays back the client events of a complete recording, turn by turn, in order. */
export class Replay {
  readonly initialLifetime: Totals;
  private readonly turns: Turn[] = [];
  private cursor = 0;

  constructor(path: string) {
    const entries: Entry[] = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    if (!entries.length || entries[0].kind !== 'session')
      throw new Error('Recording lacks session header');

    let current: Turn | undefined;
    entries.forEach((entry, index) => {
      if (entry.version !== 1 || entry.seq !== index) {
        throw new Error('Unsupported or corrupt recording sequence');
      }
      if (entry.kind === 'request') {
        if (current) throw new Error('Recording has overlapping turns');
        current = { input: entry.data as TurnInput, events: [] };
      } else if (entry.kind === 'client') {
        if (!current) throw new Error('Client event outside turn');
        current.events.push(entry.data as ServerEvent);
      } else if (entry.kind === 'turn_end') {
        if (!current) throw new Error('Turn end without request');
        if ((entry.data as { disconnected?: boolean }).disconnected) {
          throw new Error('Cannot deterministically replay a disconnected turn');
        }
        this.turns.push(current);
        current = undefined;
      }
    });
    if (current || !this.turns.length)
      throw new Error('Recording has an incomplete turn or no turns');
    const header = entries[0].data as { lifetime?: Totals };
    this.initialLifetime = header.lifetime ?? { tokens: 0, cost: 0 };
  }

  /** Returns the next turn's events if `input` matches what was recorded; otherwise throws without advancing. */
  next(input: TurnInput): ServerEvent[] {
    const turn = this.turns[this.cursor];
    if (!turn) throw new Error('Replay exhausted');
    const mismatch = (key: string) =>
      new Error(`Replay mismatch at turn ${this.cursor + 1}: ${key}`);
    for (const key of ['message', 'fen', 'moves'] as const) {
      if (JSON.stringify(input[key]) !== JSON.stringify(turn.input[key])) throw mismatch(key);
    }
    // Recordings made before playerColor existed accept any side.
    if (turn.input.playerColor !== undefined && input.playerColor !== turn.input.playerColor) {
      throw mismatch('playerColor');
    }
    this.cursor++;
    return structuredClone(turn.events);
  }
}
