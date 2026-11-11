import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export type TurnInput = { message: string; fen: string; moves: string[]; playerColor?: 'white' | 'black' };
type Entry = { version: 1; seq: number; at: string; kind: string; data: any };
export class Recorder {
  readonly path: string;
  private seq = 0;
  constructor(directory: string, metadata: object) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${randomUUID()}.jsonl`);
    this.record('session', metadata);
  }
  record(kind: string, data: unknown) {
    appendFileSync(this.path, JSON.stringify({ version: 1, seq: this.seq++, at: new Date().toISOString(), kind, data }) + '\n', { mode: 0o600 });
  }
}
export class Replay {
  private turns: { input: TurnInput; events: object[] }[] = [];
  private cursor = 0;
  readonly initialLifetime: object;
  constructor(path: string) {
    const entries: Entry[] = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (!entries.length || entries[0].kind !== 'session') throw new Error('Recording lacks session header');
    let current: { input: TurnInput; events: object[] } | undefined;
    entries.forEach((entry, index) => {
      if (entry.version !== 1 || entry.seq !== index) throw new Error('Unsupported or corrupt recording sequence');
      if (entry.kind === 'request') {
        if (current) throw new Error('Recording has overlapping turns');
        current = { input: entry.data, events: [] };
      }
      if (entry.kind === 'client') {
        if (!current) throw new Error('Client event outside turn');
        current.events.push(entry.data);
      }
      if (entry.kind === 'turn_end') {
        if (!current) throw new Error('Turn end without request');
        if (entry.data.disconnected) throw new Error('Cannot deterministically replay a disconnected turn');
        this.turns.push(current); current = undefined;
      }
    });
    if (current || !this.turns.length) throw new Error('Recording has an incomplete turn or no turns');
    this.initialLifetime = entries[0].data.lifetime ?? { tokens: 0, cost: 0 };
  }
  next(input: TurnInput): object[] {
    const next = this.turns[this.cursor];
    if (!next) throw new Error('Replay exhausted');
    for (const key of ['message', 'fen', 'moves'] as const) {
      if (JSON.stringify(input[key]) !== JSON.stringify(next.input[key])) throw new Error(`Replay mismatch at turn ${this.cursor + 1}: ${key}`);
    }
    if (next.input.playerColor !== undefined && input.playerColor !== next.input.playerColor) throw new Error(`Replay mismatch at turn ${this.cursor + 1}: playerColor`);
    this.cursor++;
    return structuredClone(next.events);
  }
}
