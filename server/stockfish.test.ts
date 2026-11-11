import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { analyze } from './stockfish';

describe('Stockfish adapter', () => {
  it('returns a terminal position without starting an engine', async () => {
    const result = await analyze('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1') as { moves: unknown[]; evaluation: { type: string; winner: string } };
    expect(result.moves).toEqual([]);
    expect(result.evaluation).toEqual({ type: 'mate', value: 0, winner: 'white' });
  });
  it('rejects invalid hypothetical moves', async () => {
    await expect(analyze(new Chess().fen(), ['e2e5'])).rejects.toThrow();
  });
  it.runIf(process.env.TEST_STOCKFISH === '1')('returns 3 legal candidates from a live engine', async () => {
    const result = await analyze(new Chess().fen()) as { moves: { move: string; depth: number }[]; depth: number };
    expect(result.moves).toHaveLength(3);
    for (const candidate of result.moves) {
      expect(() => new Chess().move(candidate.move)).not.toThrow();
      expect(candidate.depth).toBe(result.depth);
    }
  }, 15000);
});
