import { describe, expect, it } from 'vitest';
import type { DrillCard } from './protocol.ts';
import {
  DAY_MS,
  DEFAULT_EASE,
  drillKey,
  formatDueLabel,
  isDrillDue,
  nearestOpponentElo,
  scheduleDrill,
  sortDrills,
} from './drills.ts';

function makeCard(overrides: Partial<DrillCard> = {}): DrillCard {
  return {
    id: 'd1',
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    moves: ['e4', 'e5'],
    playerColor: 'white',
    played: 'Qh5',
    best: 'Nf3',
    loss: 18,
    quality: 'mistake',
    opening: 'King Pawn Game',
    gameUrl: 'https://www.chess.com/game/live/1',
    playedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    intervalDays: 0,
    ease: DEFAULT_EASE,
    reps: 0,
    lapses: 0,
    dueAt: '2026-01-01T00:00:00.000Z',
    lastReviewedAt: null,
    lastResult: null,
    ...overrides,
  };
}

describe('scheduleDrill (SM-2)', () => {
  it('progresses intervals 1d -> 6d -> ease*interval on consecutive solves', () => {
    const t0 = new Date('2026-02-01T12:00:00.000Z');
    const c1 = scheduleDrill(makeCard(), true, t0);
    expect(c1.reps).toBe(1);
    expect(c1.intervalDays).toBe(1);
    expect(c1.lastResult).toBe('pass');
    expect(Date.parse(c1.dueAt) - t0.getTime()).toBe(DAY_MS);

    const t1 = new Date(t0.getTime() + DAY_MS);
    const c2 = scheduleDrill(c1, true, t1);
    expect(c2.reps).toBe(2);
    expect(c2.intervalDays).toBe(6);

    const t2 = new Date(t1.getTime() + 6 * DAY_MS);
    const c3 = scheduleDrill(c2, true, t2);
    expect(c3.reps).toBe(3);
    expect(c3.intervalDays).toBeGreaterThanOrEqual(15);
  });

  it('resets reps, increments lapses, and schedules a short retry on miss', () => {
    const t0 = new Date('2026-02-01T12:00:00.000Z');
    const c = scheduleDrill(makeCard({ reps: 3, intervalDays: 14, ease: 2.5 }), false, t0);
    expect(c.reps).toBe(0);
    expect(c.lapses).toBe(1);
    expect(c.intervalDays).toBe(0);
    expect(c.ease).toBe(2.3);
    expect(c.lastResult).toBe('fail');
    expect(Date.parse(c.dueAt) - t0.getTime()).toBe(10 * 60_000);
  });
});

describe('sorting, due checks, and elo matching', () => {
  it('places due cards ahead of future cards and orders oldest due first', () => {
    const now = Date.parse('2026-02-10T12:00:00.000Z');
    const future = makeCard({ id: 'future', dueAt: '2026-02-12T12:00:00.000Z' });
    const dueNew = makeCard({ id: 'due-new', dueAt: '2026-02-10T11:00:00.000Z' });
    const dueOld = makeCard({ id: 'due-old', dueAt: '2026-02-09T12:00:00.000Z' });

    expect(isDrillDue(dueOld, now)).toBe(true);
    expect(isDrillDue(future, now)).toBe(false);
    expect(sortDrills([future, dueNew, dueOld], now).map(c => c.id)).toEqual([
      'due-old',
      'due-new',
      'future',
    ]);
  });

  it('matches nearest Maia3 ELO and builds stable dedup keys', () => {
    expect(nearestOpponentElo(1380)).toBe(1500);
    expect(nearestOpponentElo(1120)).toBe(1200);
    expect(nearestOpponentElo(null)).toBe(1500);
    expect(formatDueLabel('2026-02-10T11:00:00.000Z', Date.parse('2026-02-10T12:00:00.000Z'))).toBe(
      'Due now',
    );
    expect(
      drillKey('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'Qh5', 'Nf3'),
    ).toBe(drillKey('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 9', 'Qh5', 'Nf3'));
  });
});
