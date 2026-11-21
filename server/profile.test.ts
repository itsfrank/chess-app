import { describe, expect, it, vi } from 'vitest';
import type { ArchivedGame, PositionEval } from '../shared/protocol.ts';
import { reviewGame } from '../shared/quality.ts';
import { ProfileService } from './profile.ts';

const cp = (value: number, best: string | null = 'e4'): PositionEval => ({
  evaluation: { type: 'cp', value },
  best,
  depth: 16,
});

const game = (id: number, overrides: Partial<ArchivedGame> = {}): ArchivedGame => ({
  url: `https://www.chess.com/game/live/${id}`,
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
  clocks: [598, 595, 590, 588],
  ...overrides,
});

describe('ProfileService', () => {
  it('pages up to two archive pages, attaches cached reviews, and caches the digest', async () => {
    const fetchGames = vi
      .fn()
      .mockResolvedValueOnce({ username: 'Frk', games: [game(1)], older: 100 })
      .mockResolvedValueOnce({ username: 'Frk', games: [game(2, { result: '0-1' })], older: null });
    const cachedReview = vi.fn((moves: string[]) =>
      reviewGame(moves, [cp(20), cp(20), cp(20), cp(20), cp(20)], 2),
    );
    const service = new ProfileService({ fetchGames, cachedReview });

    expect(service.cachedDigest('Frk')).toBeNull();
    const profile = await service.get('Frk');
    expect(profile.gamesAnalyzed).toBe(2);
    expect(profile.reviewedGames).toBe(2);
    expect(fetchGames).toHaveBeenCalledTimes(2);

    // Subsequent call hits TTL cache
    await service.get('frk');
    expect(fetchGames).toHaveBeenCalledTimes(2);

    // Cached digest is synchronously available for chat
    expect(service.cachedDigest('frk')).toMatchObject({
      username: 'Frk',
      recentGames: 2,
      reviewedGames: 2,
    });
  });
});
