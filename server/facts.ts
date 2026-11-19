/**
 * Plain facts about positions and moves, computed from the board, so that the
 * companion can describe what a move does without working out piece geometry
 * itself.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

const NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};
const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const SIDE: Record<Color, string> = { w: 'White', b: 'Black' };
const other = (color: Color): Color => (color === 'w' ? 'b' : 'w');

type Placed = { square: Square; type: PieceSymbol; color: Color };
const placed = (board: Chess): Placed[] =>
  board
    .board()
    .flat()
    .filter(piece => piece !== null);
const label = (piece: Placed) => `${NAME[piece.type]} ${piece.square}`;
const owned = (piece: Placed) => `${SIDE[piece.color]} ${label(piece)}`;

/** A side's pieces as "Kg1 Qd1 Ra1 … pawns a2 b2". */
function listPieces(pieces: Placed[], color: Color): string {
  const mine = pieces.filter(piece => piece.color === color);
  const order = 'kqrbn';
  const officers = mine
    .filter(piece => piece.type !== 'p')
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    .map(piece => piece.type.toUpperCase() + piece.square);
  const pawns = mine.filter(piece => piece.type === 'p').map(piece => piece.square);
  return [...officers, pawns.length ? `pawns ${pawns.sort().join(' ')}` : 'no pawns'].join(' ');
}

const materialOf = (pieces: Placed[], color: Color) =>
  pieces.filter(piece => piece.color === color).reduce((sum, piece) => sum + VALUE[piece.type], 0);

/** "White is up 2 points (31 to 29)" by the usual 1-3-3-5-9 count. */
function materialText(board: Chess): string {
  const pieces = placed(board);
  const [white, black] = [materialOf(pieces, 'w'), materialOf(pieces, 'b')];
  if (white === black) return `Material is level (${white} points each)`;
  const ahead = white > black ? 'White' : 'Black';
  const points = Math.abs(white - black);
  return `${ahead} is up ${points} point${points > 1 ? 's' : ''} (White ${white}, Black ${black})`;
}

/** The enemy pieces that the piece on `square` attacks. */
export function attackedBy(board: Chess, square: Square): Placed[] {
  const piece = board.get(square);
  if (!piece) return [];
  return placed(board).filter(
    target =>
      target.color !== piece.color && board.attackers(target.square, piece.color).includes(square),
  );
}

/** Pieces that cannot move off their line without exposing their own king. */
export function pinnedPieces(board: Chess): Placed[] {
  return placed(board).filter(piece => {
    if (piece.type === 'k') return false;
    const [king] = board.findPiece({ type: 'k', color: piece.color });
    if (!king || board.isAttacked(king, other(piece.color))) return false;
    const without = new Chess(board.fen(), { skipValidation: true });
    without.remove(piece.square);
    return without.isAttacked(king, other(piece.color));
  });
}

/**
 * Every attacked piece with what attacks and defends it. It is `loose` when
 * nothing defends it or something cheaper attacks it: taking it wins material
 * unless there is a tactic.
 */
function attackedPieces(board: Chess): string[] {
  return placed(board).flatMap(piece => {
    if (piece.type === 'k') return [];
    const enemy = other(piece.color);
    const attackers = board.attackers(piece.square, enemy).map(square => ({
      square,
      ...board.get(square)!,
    }));
    if (!attackers.length) return [];
    const defenders = board
      .attackers(piece.square, piece.color)
      .map(square => ({ square, ...board.get(square)! }));
    const loose =
      !defenders.length || attackers.some(attacker => VALUE[attacker.type] < VALUE[piece.type]);
    return [
      `${owned(piece)}: attacked by ${attackers.map(label).join(', ')}; ` +
        (defenders.length ? `defended by ${defenders.map(label).join(', ')}` : 'undefended') +
        (loose ? ' (loose)' : ''),
    ];
  });
}

export type PositionFacts = {
  toMove: string;
  white: string;
  black: string;
  material: string;
  /** Empty when nothing is attacked. */
  attacked: string[];
  pinned: string[];
  check: boolean;
};

/** Where everything stands in `fen` and which pieces are under attack. */
export function positionFacts(fen: string): PositionFacts {
  const board = new Chess(fen);
  const pieces = placed(board);
  return {
    toMove: SIDE[board.turn()],
    white: listPieces(pieces, 'w'),
    black: listPieces(pieces, 'b'),
    material: materialText(board),
    attacked: attackedPieces(board),
    pinned: pinnedPieces(board).map(owned),
    check: board.isCheck(),
  };
}

export type MoveFacts = {
  /** Numbered, as in "16… Nxc3". */
  move: string;
  /** What the move is, in words: "knight d5 takes pawn on c3". */
  does: string;
  check: boolean;
  /** Enemy pieces the moved piece attacks from its new square. */
  attacks: string[];
  /** Attacks by the mover's other pieces that the move opened up. */
  uncovers: string[];
  /** The mover's own pieces left loose after the move. */
  leavesLoose: string[];
};

/** Every (attacker square, target square) pair of `color` attacking an enemy piece. */
function attackPairs(board: Chess, color: Color): Map<string, { from: Placed; to: Placed }> {
  const pairs = new Map<string, { from: Placed; to: Placed }>();
  for (const target of placed(board)) {
    if (target.color === color) continue;
    for (const square of board.attackers(target.square, color)) {
      const from = { square, ...board.get(square)! };
      pairs.set(`${square}${target.square}`, { from, to: target });
    }
  }
  return pairs;
}

/** Plays `san` on `board` and says what it did. */
export function moveFacts(board: Chess, san: string): MoveFacts {
  const number = board.moveNumber();
  const color = board.turn();
  const before = attackPairs(board, color);
  const move = board.move(san);
  const piece: Placed = { square: move.to, type: move.promotion ?? move.piece, color };

  let does = `${NAME[move.piece]} ${move.from} `;
  if (move.isKingsideCastle()) does = 'castles kingside';
  else if (move.isQueensideCastle()) does = 'castles queenside';
  else if (move.captured)
    does += `takes ${NAME[move.captured]} on ${move.isEnPassant() ? `${move.to[0]}${move.from[1]} en passant` : move.to}`;
  else does += `to ${move.to}`;
  if (move.promotion) does += `, promoting to a ${NAME[move.promotion]}`;

  const after = attackPairs(board, color);
  const uncovers = [...after]
    .filter(([key, pair]) => !before.has(key) && pair.from.square !== move.to)
    // Castling moves the rook as well; its new attacks are not discoveries of another piece.
    .filter(
      ([, pair]) =>
        !(pair.from.type === 'r' && (move.isKingsideCastle() || move.isQueensideCastle())),
    )
    .map(([, pair]) => `${label(pair.from)} on ${label(pair.to)}`);
  const mine = `${SIDE[color]} `;
  return {
    move: `${number}${color === 'w' ? '.' : '…'} ${move.san}`,
    does,
    check: board.isCheck(),
    attacks: attackedBy(board, piece.square).map(label),
    uncovers,
    leavesLoose: attackedPieces(board)
      .filter(line => line.startsWith(mine) && line.endsWith('(loose)'))
      .map(line => line.slice(mine.length, line.indexOf(':'))),
  };
}

export type LineFacts = {
  moves: MoveFacts[];
  /** Material once the described moves have been played. */
  materialAfter: string;
};

/** What each of the first `limit` moves of a line does, played from `fen`. */
export function lineFacts(fen: string, sans: string[], limit = 6): LineFacts {
  const board = new Chess(fen);
  const moves: MoveFacts[] = [];
  for (const san of sans.slice(0, limit)) {
    try {
      moves.push(moveFacts(board, san));
    } catch {
      break;
    }
  }
  return { moves, materialAfter: materialText(board) };
}

/** Drops what is empty or false, so the facts cost the model as few tokens as possible. */
function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, field]) => field !== false && !(Array.isArray(field) && !field.length),
    ),
  ) as Partial<T>;
}

/** The facts about a position, as given to the companion. */
export const describePosition = (fen: string) => compact(positionFacts(fen));

/** The facts about the first moves of a line from `fen`, as given to the companion. */
export function describeLine(fen: string, sans: string[], limit?: number) {
  const { moves, materialAfter } = lineFacts(fen, sans, limit);
  return { steps: moves.map(compact), materialAfterSteps: materialAfter };
}
