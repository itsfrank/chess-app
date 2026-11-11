import { Chess } from 'chess.js';
import { afterEach, expect, it, vi } from 'vitest';
import { explore, summarize } from './lichess';
afterEach(() => vi.unstubAllGlobals());
it('uses the full sample denominator, not only the top moves', () => {
  const result = summarize({ white: 50, draws: 10, black: 40, moves: [{ uci: 'e2e4', san: 'e4', white: 20, draws: 5, black: 15 }] });
  expect(result.totalGames).toBe(100); expect(result.moves[0].frequency).toBe(.4); expect(result.otherGames).toBe(60);
  expect(summarize({ white: 0, draws: 0, black: 0, moves: [] }).moves).toEqual([]);
});
it('validates filters and moves without making requests', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(explore(new Chess().fen(), { ratings: [1234] })).rejects.toThrow('filters');
  await expect(explore(new Chess().fen(), { moves: ['e5'] })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('requests correct filters, caches results and propagates abort', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ white: 3, draws: 1, black: 2, moves: [{ uci: 'e7e5', san: 'e5', white: 1, draws: 1, black: 1 }] })));
  vi.stubGlobal('fetch', fetch);
  const fen = new Chess().fen(); const options = { moves: ['e4'], ratings: [1600], speeds: ['rapid'] };
  const first = await explore(fen, options); const second = await explore(fen, options);
  expect(first).toEqual(second); expect(fetch).toHaveBeenCalledTimes(1);
  const url = fetch.mock.calls[0][0] as URL;
  expect(url.searchParams.get('ratings')).toBe('1600'); expect(url.searchParams.get('speeds')).toBe('rapid');
  expect(url.searchParams.get('fen')).toContain(' b ');
  const abort = new AbortController(); abort.abort();
  await expect(explore(fen, options, abort.signal)).rejects.toThrow();
});
