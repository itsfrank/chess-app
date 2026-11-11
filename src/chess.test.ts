import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { legalTargets, needsPromotion, squareCenter, tryMove } from './chess';

describe('board rules', () => {
  it('accepts legal moves and rejects illegal ones without changing state', () => {
    const game = new Chess();
    const initial = game.fen();
    expect(tryMove(game, 'e2', 'e5')).toBe(false);
    expect(game.fen()).toBe(initial);
    expect(legalTargets(game, 'e2')).toEqual(expect.arrayContaining(['e3', 'e4']));
    expect(tryMove(game, 'e2', 'e4')).toBe(true);
    expect(tryMove(game, 'd2', 'd4')).toBe(false);
    game.undo();
    expect(game.fen()).toBe(initial);
  });
  it('requires a promotion choice and supports underpromotion', () => {
    const game = new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1');
    expect(needsPromotion(game, 'a7', 'a8')).toBe(true);
    expect(tryMove(game, 'a7', 'a8')).toBe(false);
    expect(tryMove(game, 'a7', 'a8', 'n')).toBe(true);
    expect(game.get('a8')?.type).toBe('n');
  });
  it('maps square centers in both orientations', () => {
    expect(squareCenter('a1', false)).toEqual([50, 750]);
    expect(squareCenter('h8', false)).toEqual([750, 50]);
    expect(squareCenter('a1', true)).toEqual([750, 50]);
  });
});
