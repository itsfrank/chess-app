import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  gameResult,
  legalTargets,
  needsPromotion,
  replay,
  sanForMove,
  sideToMove,
  squareCenter,
} from './chess';

describe('board rules', () => {
  it('replays SAN history from the starting position', () => {
    expect(replay([]).fen()).toBe(new Chess().fen());
    expect(replay(['e4', 'e5', 'Nf3']).history()).toEqual(['e4', 'e5', 'Nf3']);
    expect(() => replay(['e5'])).toThrow();
  });

  it('knows whose turn follows a number of half-moves', () => {
    expect(sideToMove(0)).toBe('white');
    expect(sideToMove(3)).toBe('black');
  });

  it('returns SAN for legal moves and null for illegal ones without changing the game', () => {
    const game = new Chess();
    const initial = game.fen();
    expect(sanForMove(game, 'e2', 'e5')).toBeNull();
    expect(sanForMove(game, 'e2', 'e4')).toBe('e4');
    expect(sanForMove(game, 'g1', 'f3')).toBe('Nf3');
    expect(game.fen()).toBe(initial);
    expect(legalTargets(game, 'e2')).toEqual(expect.arrayContaining(['e3', 'e4']));
  });

  it('requires a promotion choice and supports underpromotion', () => {
    const game = new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1');
    expect(needsPromotion(game, 'a7', 'a8')).toBe(true);
    expect(sanForMove(game, 'a7', 'a8')).toBeNull();
    expect(sanForMove(game, 'a7', 'a8', 'n')).toBe('a8=N');
  });

  it('maps square centers in both orientations', () => {
    expect(squareCenter('a1', false)).toEqual([50, 750]);
    expect(squareCenter('h8', false)).toEqual([750, 50]);
    expect(squareCenter('a1', true)).toEqual([750, 50]);
  });

  it('describes how a game ended', () => {
    expect(gameResult(new Chess())).toBeNull();
    expect(gameResult(replay(['f3', 'e5', 'g4', 'Qh4#']))).toBe('Checkmate');
    expect(gameResult(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))).toBe('Draw · Stalemate');
    expect(gameResult(new Chess('7k/8/6K1/8/8/8/8/8 b - - 0 1'))).toBe(
      'Draw · Insufficient material',
    );
  });
});
