import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { MaiaOpponent, opponentPosition } from './opponent.ts';

const input = (moves: string[] = [], playerColor = 'black', elo = 1500) => {
  const board = new Chess(); for (const move of moves) board.move(move);
  return { moves, fen: board.fen(), playerColor, elo };
};
describe('opponent requests', () => {
  it('reconstructs UCI move history including castling', () => {
    expect(opponentPosition(input(['e4', 'e5', 'Nf3'], 'white')).moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(opponentPosition(input(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O'], 'white')).moves.at(-1)).toBe('e1g1');
  });
  it('rejects invalid requests, mismatches, human turns and terminal games', () => {
    for (const value of [null, {}, { ...input(), moves: ['illegal'] }, { ...input(), fen: 'bad' }, input([], 'white'), input([], 'black', 5000), input([], 'red'), input(['f3', 'e5', 'g4', 'Qh4#'], 'black')]) {
      expect(() => opponentPosition(value)).toThrow();
    }
  });
  it.skipIf(!process.env.TEST_MAIA3)('reuses a real CPU engine and validates responses', async () => {
    const engine = new MaiaOpponent();
    try {
      for (const value of [input(), input(['e4'], 'white'), input(['d4', 'd5', 'c4'], 'white', 1000)]) {
        const result = await engine.move(value); const board = new Chess(value.fen);
        board.move(result.move); expect(board.fen()).toBe(result.fen);
      }
      const abort = new AbortController(); abort.abort();
      await expect(engine.move(input(), abort.signal)).rejects.toThrow('cancelled');
    } finally { engine.close(); }
  }, 60000);
});
