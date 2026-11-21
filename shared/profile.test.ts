import { describe, expect, it } from 'vitest';
import type { ArchivedGame, PositionEval } from './protocol.ts';
import { reviewGame } from './quality.ts';
import { buildPlayerProfile, profileDigest } from './profile.ts';

const cp = (value: number, best: string | null = 'e4'): PositionEval => ({
  evaluation: { type: 'cp', value },
  best,
  depth: 16,
});

function makeGame(overrides: Partial<ArchivedGame> = {}): ArchivedGame {
  return {
    url: 'https://www.chess.com/game/live/1',
    playedAt: '2026-01-01T00:00:00.000Z',
    white: { name: 'Frk', rating: 1400 },
    black: { name: 'rival', rating: 1400 },
    playerColor: 'white',
    result: '1-0',
    termination: 'Frk won by resignation',
    timeClass: 'rapid',
    timeControl: '600',
    opening: 'Italian Game',
    moves: ['e4', 'e5', 'Nf3', 'Nc6'],
    ...overrides,
  };
}

describe('buildPlayerProfile', () => {
  it('aggregates W/D/L, color splits, timeout losses, and struggling openings', () => {
    const games: ArchivedGame[] = [
      makeGame({
        url: 'g1',
        playerColor: 'white',
        result: '1-0',
        opening: 'Italian Game',
      }),
      makeGame({
        url: 'g2',
        playerColor: 'black',
        result: '1-0',
        termination: 'rival won on time',
        opening: 'Sicilian Defense',
      }),
      makeGame({
        url: 'g3',
        playerColor: 'black',
        result: '1-0',
        termination: 'rival won by checkmate',
        opening: 'Sicilian Defense',
      }),
      makeGame({
        url: 'g4',
        playerColor: 'white',
        result: '1/2-1/2',
        opening: 'Italian Game',
      }),
    ];

    const profile = buildPlayerProfile('Frk', games);
    expect(profile.gamesAnalyzed).toBe(4);
    expect(profile.overall).toEqual({ games: 4, wins: 1, draws: 1, losses: 2 });
    expect(profile.white).toEqual({ games: 2, wins: 1, draws: 1, losses: 0 });
    expect(profile.black).toEqual({ games: 2, wins: 0, draws: 0, losses: 2 });
    expect(profile.timeoutLosses).toBe(1);
    expect(profile.weakestOpenings).toEqual([
      { name: 'Sicilian Defense', color: 'black', games: 2, wins: 0, draws: 0, losses: 2 },
    ]);
  });

  it('tracks accuracy, phase errors, and clock habits from reviewed games', () => {
    const moves = ['e4', 'e5', 'Qh5', 'Nc6'];
    const evals: PositionEval[] = [
      cp(20, 'e4'),
      cp(20, 'e5'),
      cp(20, 'Nf3'),
      cp(-350, 'Nc6'), // White's 2. Qh5 drops heavily
      cp(-350, 'Bc4'),
    ];
    const review = reviewGame(moves, evals, 2);
    const game = makeGame({
      url: 'reviewed-1',
      playerColor: 'white',
      moves,
      // White plays 1.e4 in 2s (598), then 2.Qh5 in 1s (597) — impulsive error!
      clocks: [598, 595, 597, 590],
      timeControl: '600',
    });

    const profile = buildPlayerProfile('Frk', [game], new Map([[game.url, review]]));
    expect(profile.reviewedGames).toBe(1);
    expect(profile.avgAccuracy.overall).not.toBeNull();
    expect(profile.errorCounts.blunders).toBe(1);
    expect(profile.phaseErrors.opening).toBe(1);
    expect(profile.clockHabits).toEqual({
      timedErrors: 1,
      timeTroubleErrors: 0,
      impulsiveErrors: 1,
      deepThinkErrors: 0,
    });

    const digest = profileDigest(profile);
    expect(digest?.recentGames).toBe(1);
    expect(digest?.clockHabits?.impulsiveErrors).toBe(1);
  });
});
