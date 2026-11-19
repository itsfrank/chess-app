import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import { describeLine, describePosition, lineFacts, moveFacts, positionFacts } from './facts.ts';

/** White to play 16th move: Qa5, Ne5, pawns b2 d4 e4; Black Nd5, Bf5, Rc7, Qd8, pawn c3. */
const fen = '3q1rk1/2r1ppbp/6p1/Q2nNb2/3PP3/2p3P1/PP3PBP/R1B1K2R w KQ - 0 16';

it('lists the pieces, the material and everything under attack', () => {
  const facts = positionFacts(fen);
  expect(facts).toMatchObject({
    toMove: 'White',
    white: 'Ke1 Qa5 Ra1 Rh1 Bg2 Bc1 Ne5 pawns a2 b2 d4 e4 f2 g3 h2',
    black: 'Kg8 Qd8 Rf8 Rc7 Bg7 Bf5 Nd5 pawns c3 e7 f7 g6 h7',
    material: 'White is up 2 points (White 35, Black 33)',
    check: false,
  });
  // The pawn on e4 forks knight and bishop: both are attacked by something cheaper.
  expect(facts.attacked).toContain(
    'Black knight d5: attacked by queen a5, pawn e4; defended by queen d8 (loose)',
  );
  expect(facts.attacked).toContain(
    'Black bishop f5: attacked by pawn e4; defended by pawn g6 (loose)',
  );
  expect(facts.attacked).toContain('White knight e5: attacked by bishop g7; defended by pawn d4');
  expect(positionFacts(new Chess().fen())).toMatchObject({
    material: 'Material is level (39 points each)',
    attacked: [],
  });
});

it('says what a move takes, attacks, uncovers and leaves loose', () => {
  const { moves, materialAfter } = lineFacts(fen, ['bxc3', 'Nxc3', 'Be3', 'Bxe4']);
  expect(moves[1]).toEqual({
    move: '16… Nxc3',
    does: 'knight d5 takes pawn on c3',
    check: false,
    // Not the queen on a5, whatever a model may say.
    attacks: ['pawn e4', 'pawn a2'],
    uncovers: ['queen d8 on pawn d4'],
    leavesLoose: ['bishop f5'],
  });
  expect(materialAfter).toBe('White is up 1 point (White 33, Black 32)');

  const board = new Chess();
  for (const san of ['e4', 'f5', 'exf5', 'g5']) board.move(san);
  expect(moveFacts(board, 'fxg6')).toMatchObject({ does: 'pawn f5 takes pawn on g5 en passant' });
  expect(moveFacts(board, 'Nf6')).toMatchObject({ does: 'knight g8 to f6', attacks: [] });
  const open = new Chess();
  for (const san of ['e4', 'f5']) open.move(san);
  expect(moveFacts(open, 'Qh5+')).toMatchObject({ move: '2. Qh5+', check: true });
  expect(moveFacts(new Chess('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'O-O')).toMatchObject({
    does: 'castles kingside',
    uncovers: [],
  });
});

it('finds pinned pieces and stops a line at a move that cannot be played', () => {
  // The knight on c6 is pinned to the king by the bishop on b5.
  const pinned = 'r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
  expect(positionFacts(pinned).pinned).toEqual(['Black knight c6']);
  expect(lineFacts(fen, ['bxc3', 'Qxa5', 'Be3']).moves).toHaveLength(1);
});

it('leaves out what is empty when describing for the companion', () => {
  expect(describePosition(new Chess().fen())).not.toHaveProperty('attacked');
  expect(describeLine(fen, ['bxc3']).steps).toEqual([
    { move: '16. bxc3', does: 'pawn b2 takes pawn on c3' },
  ]);
});
