import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Recorder, Replay } from './recording';
const input = { message: 'Explain d4', fen: 'test-fen', moves: ['d4'] };
it('replays exact ordered events, rejects mismatches without consuming, and never writes usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chess-replay-'));
  try {
    const recorder = new Recorder(dir, { model: 'test', lifetime: { tokens: 100, cost: .01 } });
    const events = [
      { type: 'conversation', id: 'recorded-id' },
      { type: 'status', text: 'Checking Stockfish…' },
      { type: 'analysis', result: { depth: 15, moves: ['d4'] } },
      { type: 'arrows', arrows: [{ id: 'center', from: 'd2', to: 'd4', color: '#60a5fa' }] },
      { type: 'text', delta: 'Play ' }, { type: 'text', delta: 'd4.' },
      { type: 'usage', session: { tokens: 200, cost: .02 }, lifetime: { tokens: 300, cost: .03 } },
      { type: 'done' },
    ];
    recorder.record('request', input);
    recorder.record('agent', { type: 'tool_execution_start', args: {} });
    events.forEach(event => recorder.record('client', event));
    recorder.record('turn_end', { disconnected: false });
    recorder.record('request', { ...input, message: 'Next' });
    recorder.record('client', { type: 'error', message: 'Recorded failure' });
    recorder.record('turn_end', { disconnected: false });
    const original = readFileSync(recorder.path, 'utf8');
    const replay = new Replay(recorder.path);
    expect(() => replay.next({ ...input, message: 'Different' })).toThrow('message');
    expect(() => replay.next({ ...input, fen: 'different' })).toThrow('fen');
    expect(() => replay.next({ ...input, moves: [] })).toThrow('moves');
    expect(replay.initialLifetime).toEqual({ tokens: 100, cost: .01 });
    expect(replay.next(input)).toEqual(events);
    expect(replay.next({ ...input, message: 'Next' })).toEqual([{ type: 'error', message: 'Recorded failure' }]);
    expect(() => replay.next(input)).toThrow('exhausted');
    expect(new Replay(recorder.path).next(input)).toEqual(events);
    expect(readFileSync(recorder.path, 'utf8')).toBe(original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('rejects incomplete, disconnected, and corrupt recordings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chess-replay-'));
  try {
    const recorder = new Recorder(dir, {});
    recorder.record('request', input);
    expect(() => new Replay(recorder.path)).toThrow('incomplete');
    recorder.record('turn_end', { disconnected: true });
    expect(() => new Replay(recorder.path)).toThrow('disconnected');
    writeFileSync(recorder.path, 'not json');
    expect(() => new Replay(recorder.path)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
