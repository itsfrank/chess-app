import { expect, it } from 'vitest';
import { claimFeedback, parseCompactClaims, parts } from './claim-check.ts';

it('reads claims written one per line', () => {
  const claims = parseCompactClaims(
    [
      'attacks ; snapshot ; Nc4 Qxe4 ; black q ; white n c4 ; the queen hits the knight',
      'pinned ; before ; - ; white n f3 ; - ; pins the knight',
      'none',
      'not a claim at all',
    ].join('\n'),
  );
  expect(claims).toEqual([
    {
      kind: 'attacks',
      from: 'snapshot',
      line: ['Nc4', 'Qxe4'],
      subject: { color: 'black', piece: 'q' },
      object: { color: 'white', piece: 'n', square: 'c4' },
      quote: 'the queen hits the knight',
    },
    {
      kind: 'pinned',
      from: 'before',
      line: [],
      subject: { color: 'white', piece: 'n', square: 'f3' },
      quote: 'pins the knight',
    },
  ]);
});

it('splits a reply between paragraphs into parts of a few hundred characters', () => {
  const paragraph = 'x'.repeat(300);
  expect(parts([paragraph, paragraph, paragraph].join('\n\n'))).toHaveLength(2);
  expect(parts('one\n\ntwo')).toEqual(['one\n\ntwo']);
});

it('quotes the false statements back with the moves they depend on', () => {
  const feedback = claimFeedback([
    { kind: 'attacks', from: 'snapshot', line: ['Nc3'], subject: {}, quote: 'Nc3 hits the queen' },
  ]);
  expect(feedback).toContain('"Nc3 hits the queen" (after Nc3 from the snapshot)');
  expect(feedback).toContain('complete reply again');
});
