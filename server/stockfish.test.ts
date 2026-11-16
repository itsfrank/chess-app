import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { analyze, parseInfo } from './stockfish.ts';

describe('Stockfish adapter', () => {
  it('returns a terminal position without starting an engine', async () => {
    const result = await analyze('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');
    expect(result.moves).toEqual([]);
    expect(result.evaluation).toEqual({ type: 'mate', value: 0, winner: 'white' });
  });
  it('parses engine lines into White-perspective candidates', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const line =
      'info depth 12 seldepth 18 multipv 2 score cp 30 nodes 1 nps 1 time 1 pv e7e5 g1f3';
    expect(parseInfo(line, afterE4)).toEqual({
      rank: 2,
      candidate: {
        move: 'e7e5',
        san: 'e5',
        evaluation: { type: 'cp', value: -30 },
        continuation: ['e5', 'Nf3'],
        depth: 12,
      },
    });
    expect(parseInfo(line.replace('cp 30', 'cp 30 lowerbound'), afterE4)).toBeUndefined();
    expect(parseInfo(line.replace('e7e5', 'e7e4'), afterE4)).toBeUndefined();
    expect(parseInfo('info string hello', afterE4)).toBeUndefined();
  });
  it('rejects invalid hypothetical moves', async () => {
    await expect(analyze(new Chess().fen(), ['e2e5'])).rejects.toThrow();
  });
  it.runIf(process.env.TEST_STOCKFISH === '1')(
    'returns 3 legal candidates from a live engine',
    async () => {
      const result = await analyze(new Chess().fen());
      expect(result.moves).toHaveLength(3);
      for (const candidate of result.moves) {
        expect(() => new Chess().move(candidate.move)).not.toThrow();
        expect(candidate.depth).toBe(result.depth);
      }
    },
    15000,
  );
});
