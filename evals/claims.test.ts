import { expect, it } from 'vitest';
import { parseClaims, verify, type Claim } from './claims.ts';

/** White to play 16th move: Qa5, Ne5, pawns b2 d4 e4; Black Nd5, Bf5, Rc7, Qd8, pawn c3. */
const fen = '3q1rk1/2r1ppbp/6p1/Q2nNb2/3PP3/2p3P1/PP3PBP/R1B1K2R w KQ - 0 16';
const claim = (partial: Partial<Claim>): Claim => ({
  quote: '',
  from: 'snapshot',
  line: [],
  kind: 'attacks',
  subject: {},
  ...partial,
});
const knight = { color: 'black', piece: 'n' } as const;

it('decides attack and defence claims on the board after the stated moves', () => {
  const afterTaking = { line: ['bxc3', 'Nxc3'], subject: knight };
  // The claim two models made: the knight on c3 attacks the queen on a5. It does not.
  expect(verify(claim({ ...afterTaking, object: { piece: 'q', square: 'a5' } }), fen)).toBe(
    'false',
  );
  expect(verify(claim({ ...afterTaking, object: { piece: 'p', square: 'e4' } }), fen)).toBe('true');
  expect(verify(claim({ subject: { piece: 'p', square: 'e4' }, object: knight }), fen)).toBe(
    'true',
  );
  expect(
    verify(claim({ kind: 'defends', subject: { piece: 'q' }, object: { piece: 'r' } }), fen),
  ).toBe('true');
  expect(
    verify(
      claim({ kind: 'defends', subject: { piece: 'b', color: 'white' }, object: knight }),
      fen,
    ),
  ).toBe('false');
});

it('checks captures, checks, placement and pins, and reports unplayable lines', () => {
  const takes = claim({ kind: 'captures', line: ['bxc3', 'Nxc3'], subject: knight });
  expect(verify({ ...takes, object: { piece: 'p' } }, fen)).toBe('true');
  expect(verify({ ...takes, object: { piece: 'q' } }, fen)).toBe('false');
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const check = (line: string[]) => verify(claim({ kind: 'check', line, subject: {} }), start);
  expect(check(['e4', 'f5', 'Qh5+'])).toBe('true');
  expect(check(['e4', 'f5', 'Qf3'])).toBe('false');
  expect(verify(claim({ kind: 'piece_on', subject: { piece: 'n', square: 'e5' } }), fen)).toBe(
    'true',
  );
  expect(verify(claim({ kind: 'piece_on', subject: { piece: 'n', square: 'f3' } }), fen)).toBe(
    'false',
  );
  expect(verify(claim({ kind: 'pinned', subject: knight }), fen)).toBe('false');
  expect(verify(claim({ line: ['Nc6', 'Qxc6'], subject: knight, object: {} }), fen)).toBe(
    'bad-line',
  );
  expect(verify(claim({ from: 'before', subject: knight, object: {} }), fen)).toBe('unclear');
});

it('reads the claim list out of a reply with text around it', () => {
  expect(parseClaims('Here you go:\n[{"kind":"check","line":["Qh5+"]}]\nDone.')).toHaveLength(1);
  expect(parseClaims('none')).toEqual([]);
});
