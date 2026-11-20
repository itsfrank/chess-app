import { expect, it } from 'vitest';
import { measure, plain, summarizeMetrics } from './metrics.ts';

const rubric = [
  'The bishop on a7 plugs the a-file and prevents the exchange of rooks.',
  'Behind it White can double rooks, e.g. on a2 and a1.',
];

it('counts engine scores and notices an answer that leads with one', () => {
  const numbers = measure(
    'Ba7 is the engine’s top move at **+0.9** (depth 18). The next best scores −0.3, about 1.2 pawns worse.',
    rubric,
    false,
  );
  expect(numbers).toMatchObject({ scores: 4, leadsWithScore: true });
  const reasons = measure(
    'The bishop blocks the a-file so Black cannot trade rooks. White doubles on a2 and a1 behind it; the engine agrees (+0.9).',
    rubric,
    false,
  );
  expect(reasons).toMatchObject({ scores: 1, leadsWithScore: false, words: 22 });
  // a2 and a1 are there; a7 is not.
  expect(reasons.squares).toBeCloseTo(2 / 3);
  expect(measure('It develops a piece.', rubric, false).squares).toBe(0);
  expect(measure('It develops a piece.', ['Keeps the initiative.'], false).squares).toBeNull();
});

it('flags answers that dispute the premise, only where there is one', () => {
  const disputing = 'Actually, Qxf2+ is the engine’s top choice here.';
  expect(measure(disputing, rubric, true).contradicts).toBe(true);
  expect(measure(disputing, rubric, false).contradicts).toBe(false);
  expect(measure('Trading queens leaves a drawn bishop ending.', rubric, true).contradicts).toBe(
    false,
  );
});

it('measures what the reader sees and summarises several answers', () => {
  expect(plain('[**Ba7**](#annotation-ba7) is `strong`')).toBe('Ba7 is strong');
  const row = summarizeMetrics([
    measure('Best by +0.5.', rubric, true),
    measure('It blocks the a-file from a7.', rubric, true),
  ]);
  expect(row).toEqual({
    words: 5,
    'scores quoted': 0.5,
    'lead with a score': 1,
    'reference squares': '17%',
    'dispute the premise': 0,
  });
});
