import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DrillInput } from '../shared/protocol.ts';
import { DrillStore } from './drills.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'chess-drills-'));
  dirs.push(dir);
  return join(dir, 'drills.json');
}

const sample: DrillInput = {
  moves: ['e4', 'e5'],
  playerColor: 'white',
  played: 'Qh5',
  best: 'Nf3',
  loss: 21,
  quality: 'mistake',
  opening: 'King Pawn Game',
  gameUrl: 'https://www.chess.com/game/live/123',
  playedAt: '2026-01-10T10:00:00.000Z',
  rating: 1420,
};

describe('DrillStore', () => {
  it('validates, deduplicates, persists, schedules, and removes drills', () => {
    const file = tempFile();
    const store = new DrillStore(file);

    const first = store.addMany({ cards: [sample, sample] });
    expect(first.added).toHaveLength(1);
    expect(first.cards).toHaveLength(1);
    expect(first.added[0].fen).toContain('4p3/4P3');

    // Duplicate on a second call is ignored
    const dup = store.addMany(sample);
    expect(dup.added).toHaveLength(0);
    expect(dup.cards).toHaveLength(1);

    // Review updates SM-2 schedule and persists to disk
    const id = first.added[0].id;
    const reviewed = store.review(id, { solved: true }, new Date('2026-02-01T00:00:00.000Z'));
    expect(reviewed.reps).toBe(1);
    expect(reviewed.intervalDays).toBe(1);

    // Reload from disk verifies persistence
    const reloaded = new DrillStore(file);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].reps).toBe(1);

    // Delete removes and persists
    expect(reloaded.remove(id)).toEqual({ removed: true });
    expect(new DrillStore(file).list()).toHaveLength(0);
  });

  it('rejects illegal drill moves', () => {
    const store = new DrillStore();
    expect(() => store.addMany({ ...sample, best: 'Qxe5' })).toThrow('not legal');
    expect(() => store.addMany({ ...sample, moves: ['Ke5'] })).toThrow('Illegal move history');
  });
});
