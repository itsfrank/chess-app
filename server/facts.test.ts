import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import {
  describeLine,
  describePosition,
  lineFacts,
  moveFacts,
  positionalChange,
  positionalFacts,
  positionFacts,
} from './facts.ts';

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

it('describes the pawn structure, files, outposts and pawn breaks', () => {
  // Fischer–Petrosian 1971, game 7, before 22. Nxd7+.
  const facts = positionalFacts('r4k2/r2b1ppp/p4n2/2NpR3/1P6/3B1P2/P5PP/R5K1 w - - 3 22');
  expect(facts).toContain('Black isolated pawns: a6 d5');
  expect(facts).toContain('Black passed pawns: d5');
  expect(facts).toContain('Open file: c');
  expect(facts).toContain('Open file: e (White rook e5 on it)');
  expect(facts).toContain('Half-open file for White: d');
  expect(facts).toContainEqual(
    expect.stringMatching(/^White outposts .*: a5, c5 \(knight on it\)$/),
  );
  expect(facts).toContain('White pawn breaks and pawn captures: b4-b5 (strikes a6)');
  expect(facts).toContainEqual(expect.stringMatching(/^Black bishop d7 \(light squares\)/));
});

it('finds backward pawns, chains, bad bishops and pieces without safe squares', () => {
  // Johner–Nimzowitsch 1926, before 12… Qd7.
  const facts = positionalFacts(
    'r1bq1rk1/p4ppp/1pnp1n2/2p5/2PPpP2/1NP1P3/P3B1PP/R1BQ1RK1 b - - 1 12',
  );
  expect(facts).toContain('White doubled pawns on the c-file');
  expect(facts).toContainEqual(expect.stringMatching(/^Black backward pawns .*: d6$/));
  expect(facts).toContain(
    'White pawn chain (pawns defending each other): c3 d4 e3 f4, rearmost c3',
  );
  expect(facts).toContainEqual(
    expect.stringMatching(/^White bishop c1 \(dark squares\): 5 of .* a bad bishop/),
  );
  expect(facts).toContain('White has the bishop pair');
  expect(facts).toContainEqual(
    expect.stringMatching(/^White pieces with at most one safe move: .*bishop e2 \(none\)/),
  );
  // Karpov–Spassky 1974, before 24. Nb1: the knight on c3 can only retreat.
  expect(
    positionalFacts('r2r2k1/4qp2/2p3p1/p3p2p/PnQ1P2b/2N1B2P/1PPR2P1/5RK1 w - - 6 24'),
  ).toContain('White minor pieces with no safe move forward: knight c3');
});

it('says what changed between two positions', () => {
  const start = positionalFacts(new Chess().fen());
  expect(start).toContain(
    'White king e1: pawn cover d2 e2 f2; 0 of the squares around it attacked by Black',
  );
  const board = new Chess();
  for (const san of ['e4', 'd5']) board.move(san);
  const change = positionalChange(start, positionalFacts(board.fen()));
  expect(change.new).toContainEqual(
    expect.stringMatching(/^White pawn breaks and pawn captures: .*e4xd5/),
  );
  expect(change.gone).toContain(
    'White king e1: pawn cover d2 e2 f2; 0 of the squares around it attacked by Black',
  );
});

it('says where a king can go forward once the queens are off', () => {
  // Kings in opposition: neither can step forward.
  const facts = positionalFacts('8/p7/8/4k3/8/4K3/P7/8 w - - 0 1');
  expect(facts).toContainEqual(
    expect.stringMatching(/^White king e3: .*; safe squares forward for the king: none$/),
  );
  expect(positionalFacts('8/p7/8/8/4k3/8/P7/4K3 w - - 0 1')).toContainEqual(
    expect.stringMatching(/^White king e1: .*; safe squares forward for the king: d2 e2 f2$/),
  );
  expect(positionalFacts(new Chess().fen()).join('\n')).not.toContain('safe squares forward');
});
