import { expect, it } from 'vitest';
import type { PositionEval } from './protocol.ts';
import { reviewGame, reviewMove, winChance } from './quality.ts';

const cp = (value: number, best: string | null = 'x'): PositionEval => ({
  evaluation: { type: 'cp', value },
  best,
  depth: 16,
});

it('turns scores into winning chances from White’s side', () => {
  expect(winChance({ type: 'cp', value: 0 })).toBe(50);
  expect(winChance({ type: 'cp', value: 100 })).toBeCloseTo(59.1, 1);
  expect(winChance({ type: 'cp', value: -100 })).toBeCloseTo(40.9, 1);
  expect(winChance({ type: 'mate', value: 3 })).toBe(100);
  expect(winChance({ type: 'mate', value: -1 })).toBe(0);
  expect(winChance({ type: 'mate', value: 0, winner: 'black' })).toBe(0);
});

it('labels a move by the winning chances its side gave up', () => {
  const label = (before: number, after: number, mover: 'white' | 'black' = 'white') =>
    reviewMove('Nf3', mover, cp(before, 'd4'), cp(after)).quality.id;
  expect(label(30, 25)).toBe('excellent');
  expect(label(30, -10)).toBe('good');
  expect(label(30, -60)).toBe('inaccuracy');
  expect(label(30, -150)).toBe('mistake');
  expect(label(30, -500)).toBe('blunder');
  // The same swing is a gift when Black is the one moving.
  expect(label(30, -500, 'black')).toBe('excellent');
  expect(label(-30, 500, 'black')).toBe('blunder');

  // The engine's own move is best even when the two searches disagree a little.
  // The only good move is great, unless it merely takes back or the runner-up was fine too.
  const only = (second: number, obvious = false) =>
    reviewMove(
      'Nxe4',
      'black',
      { ...cp(-20, 'Nxe4'), second: { type: 'cp', value: second } },
      cp(-20),
      obvious,
    ).quality.id;
  expect(only(300)).toBe('great');
  expect(only(300, true)).toBe('best');
  expect(only(40)).toBe('best');
  expect(
    reviewMove('Nf3', 'white', { ...cp(30, 'd4'), second: cp(-300).evaluation }, cp(20)).quality.id,
  ).toBe('excellent');

  const best = reviewMove('d4', 'white', cp(30, 'd4'), cp(-40));
  expect(best).toMatchObject({ quality: { id: 'best' }, loss: 0 });
  expect(best.accuracy).toBeCloseTo(100, 2);
});

it('reviews a game as far as the evaluations go', () => {
  const moves = ['e4', 'e5', 'Qh5', 'Ke7', 'Qxe5#'];
  const evals = [
    cp(30, 'e4'),
    cp(30, 'c5'),
    cp(35, 'Nf3'),
    cp(-20, 'Nc6'),
    { evaluation: { type: 'mate', value: 1 }, best: 'Qxe5#', depth: 16 } as PositionEval,
    {
      evaluation: { type: 'mate', value: 0, winner: 'white' },
      best: null,
      depth: 0,
    } as PositionEval,
  ];
  const full = reviewGame(moves, evals);
  expect(full.moves.map(move => move?.quality.id)).toEqual([
    'best',
    'excellent',
    'inaccuracy',
    'blunder',
    'best',
  ]);
  expect(full.done).toBe(5);
  expect(full.white.counts).toMatchObject({ best: 2, inaccuracy: 1 });
  expect(full.black.counts).toMatchObject({ excellent: 1, blunder: 1 });
  expect(full.white.accuracy!).toBeGreaterThan(full.black.accuracy!);
  expect(full.white.accuracy!).toBeLessThan(100);

  // A quiet only move is great; winning the queen back or taking a bigger piece is merely best.
  const line = ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qe5+', 'Be2'];
  const forced = line.map((san, index) => ({
    ...cp(30, line[index]),
    second: { type: 'cp', value: index % 2 === 0 ? -400 : 400 } as const,
  }));
  expect(reviewGame(line, [...forced, cp(30)]).moves.map(move => move?.quality.id)).toEqual([
    'great',
    'great',
    'best',
    'best',
    'great',
    'great',
    'great',
  ]);

  // Theory is book only until the first error, however long the explorer knows the line.
  const booked = reviewGame(moves, evals, 4).moves.map(move => move?.quality.id);
  expect(booked).toEqual(['book', 'book', 'inaccuracy', 'blunder', 'best']);
  expect(reviewGame(moves, evals, 1).moves[1]?.quality.id).toBe('excellent');

  const partial = reviewGame(moves, evals.slice(0, 3));
  expect(partial.done).toBe(2);
  expect(partial.moves[2]).toBeUndefined();
  expect(partial.white.accuracy).toBeNull();
});
