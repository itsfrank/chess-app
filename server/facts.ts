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

// ---------------------------------------------------------------------------
// Positional facts: the slow-changing features of a position that plans are
// made from (pawn structure, files, outposts, bishops, restricted pieces, king
// cover, pawn breaks), as short sentences so that two positions can be diffed.

const FILES = 'abcdefgh';
const fileOf = (square: Square) => FILES.indexOf(square[0]);
const rankOf = (square: Square) => Number(square[1]);
const at = (file: number, rank: number) =>
  file >= 0 && file < 8 && rank >= 1 && rank <= 8 ? (`${FILES[file]}${rank}` as Square) : null;
/** Light or dark, by the usual colouring (a1 is dark). */
const shade = (square: Square) => ((fileOf(square) + rankOf(square)) % 2 === 1 ? 'dark' : 'light');
/** Ranks counted from the side's own back rank, so 1 is home and 8 is the far end. */
const relRank = (color: Color, rank: number) => (color === 'w' ? rank : 9 - rank);
const forward = (color: Color) => (color === 'w' ? 1 : -1);
const list = (squares: string[]) => squares.join(' ');

type Pawns = { w: Square[]; b: Square[] };
const pawnsOf = (pieces: Placed[]): Pawns => ({
  w: pieces
    .filter(p => p.type === 'p' && p.color === 'w')
    .map(p => p.square)
    .sort(),
  b: pieces
    .filter(p => p.type === 'p' && p.color === 'b')
    .map(p => p.square)
    .sort(),
});
/** Squares a pawn of `color` on `square` attacks. */
const pawnAttacks = (color: Color, square: Square) =>
  [-1, 1].flatMap(df => at(fileOf(square) + df, rankOf(square) + forward(color)) ?? []);
/** Whether any pawn of `color` attacks `square` now. */
const pawnCovers = (pawns: Square[], color: Color, square: Square) =>
  pawns.some(pawn => pawnAttacks(color, pawn).includes(square));
/** Whether a pawn of `color` could ever attack `square`, by advancing from where it stands. */
const pawnCanReach = (pawns: Square[], color: Color, square: Square) =>
  pawns.some(
    pawn =>
      Math.abs(fileOf(pawn) - fileOf(square)) === 1 &&
      relRank(color, rankOf(pawn)) < relRank(color, rankOf(square)),
  );

function pawnStructure(board: Chess, pawns: Pawns, color: Color): string[] {
  const name = SIDE[color];
  const mine = pawns[color];
  const theirs = pawns[other(color)];
  const facts: string[] = [];
  if (!mine.length) return [`${name} has no pawns`];
  const files = new Set(mine.map(fileOf));
  const islands = [...files]
    .sort()
    .filter((file, index, all) => index === 0 || all[index - 1] !== file - 1).length;
  const light = mine.filter(square => shade(square) === 'light').length;
  facts.push(
    `${name} pawns: ${list(mine)}; ${islands} island${islands > 1 ? 's' : ''}; ${light} on light squares, ${mine.length - light} on dark`,
  );

  const isolated = mine.filter(sq => !files.has(fileOf(sq) - 1) && !files.has(fileOf(sq) + 1));
  if (isolated.length) facts.push(`${name} isolated pawns: ${list(isolated)}`);
  const doubled = [...files].filter(file => mine.filter(sq => fileOf(sq) === file).length > 1);
  if (doubled.length)
    facts.push(`${name} doubled pawns on the ${doubled.map(f => FILES[f]).join(', ')}-file`);

  const passed = mine.filter(
    sq =>
      !theirs.some(
        enemy =>
          Math.abs(fileOf(enemy) - fileOf(sq)) <= 1 &&
          relRank(color, rankOf(enemy)) > relRank(color, rankOf(sq)),
      ),
  );
  if (passed.length) facts.push(`${name} passed pawns: ${list(passed)}`);

  // Backward: cannot be supported by a neighbour (all are further advanced or absent but it has
  // neighbours), and the square in front is controlled by an enemy pawn.
  const backward = mine.filter(sq => {
    if (isolated.includes(sq)) return false;
    const neighbours = mine.filter(p => Math.abs(fileOf(p) - fileOf(sq)) === 1);
    const supportable = neighbours.some(
      p => relRank(color, rankOf(p)) <= relRank(color, rankOf(sq)),
    );
    const stop = at(fileOf(sq), rankOf(sq) + forward(color));
    return !supportable && stop !== null && pawnCovers(theirs, other(color), stop);
  });
  if (backward.length)
    facts.push(
      `${name} backward pawns (cannot be supported by a pawn; the square in front is covered by an enemy pawn): ${list(backward)}`,
    );

  const fixed = mine.filter(sq => {
    const ahead = at(fileOf(sq), rankOf(sq) + forward(color));
    const blocker = ahead && board.get(ahead);
    return blocker && blocker.type === 'p' && blocker.color !== color;
  });
  if (fixed.length) facts.push(`${name} pawns blocked by enemy pawns: ${list(fixed)}`);

  // Chains: pawns linked diagonally, each defending the next.
  const defends = (a: Square, b: Square) => pawnAttacks(color, a).includes(b);
  const seen = new Set<Square>();
  for (const start of mine) {
    if (seen.has(start)) continue;
    const group: Square[] = [];
    const stack = [start];
    while (stack.length) {
      const sq = stack.pop()!;
      if (seen.has(sq)) continue;
      seen.add(sq);
      group.push(sq);
      stack.push(...mine.filter(p => !seen.has(p) && (defends(sq, p) || defends(p, sq))));
    }
    if (group.length >= 3) {
      const rear = group.reduce((a, b) =>
        relRank(color, rankOf(b)) < relRank(color, rankOf(a)) ? b : a,
      );
      facts.push(
        `${name} pawn chain (pawns defending each other): ${list(group.sort())}, rearmost ${rear}`,
      );
    }
  }
  return facts;
}

function files(board: Chess, pawns: Pawns): string[] {
  const facts: string[] = [];
  const heavy = placed(board).filter(p => p.type === 'r' || p.type === 'q');
  const on = (file: number) => {
    const here = heavy.filter(p => fileOf(p.square) === file);
    return here.length ? ` (${here.map(owned).join(', ')} on it)` : '';
  };
  for (let file = 0; file < 8; file++) {
    const white = pawns.w.some(sq => fileOf(sq) === file);
    const black = pawns.b.some(sq => fileOf(sq) === file);
    if (!white && !black) facts.push(`Open file: ${FILES[file]}${on(file)}`);
    else if (!white) facts.push(`Half-open file for White: ${FILES[file]}${on(file)}`);
    else if (!black) facts.push(`Half-open file for Black: ${FILES[file]}${on(file)}`);
  }
  return facts;
}

/**
 * Squares on the 4th–6th ranks that a pawn of the side defends and no enemy pawn can ever attack:
 * permanent homes for a knight (or a bishop).
 */
function outposts(board: Chess, pawns: Pawns, color: Color): string[] {
  const mine = pawns[color];
  const theirs = pawns[other(color)];
  const found: string[] = [];
  for (let file = 0; file < 8; file++)
    for (let rank = 1; rank <= 8; rank++) {
      const square = at(file, rank)!;
      if (![4, 5, 6].includes(relRank(color, rank))) continue;
      if (!pawnCovers(mine, color, square) || pawnCanReach(theirs, other(color), square)) continue;
      const occupant = board.get(square);
      if (occupant?.type === 'p') continue;
      found.push(
        occupant
          ? `${square} (${occupant.color === color ? '' : 'enemy '}${NAME[occupant.type]} on it)`
          : square,
      );
    }
  return found.length
    ? [
        `${SIDE[color]} outposts (defended by a ${SIDE[color]} pawn, no ${SIDE[other(color)]} pawn can ever attack): ${found.join(', ')}`,
      ]
    : [];
}

function bishops(board: Chess, pawns: Pawns): string[] {
  const facts: string[] = [];
  const pieces = placed(board);
  for (const bishop of pieces.filter(p => p.type === 'b')) {
    const colour = shade(bishop.square);
    const mine = pawns[bishop.color];
    const same = mine.filter(sq => shade(sq) === colour);
    const blocked = same.filter(sq => {
      const ahead = at(fileOf(sq), rankOf(sq) + forward(bishop.color));
      return ahead && board.get(ahead)?.type === 'p';
    });
    const theirs = pawns[other(bishop.color)].filter(sq => shade(sq) === colour);
    let verdict = '';
    if (mine.length && same.length * 2 > mine.length && blocked.length)
      verdict = ' — a bad bishop, hemmed in by its own fixed pawns';
    else if (mine.length && same.length * 2 > mine.length)
      verdict = ' — its own pawns stand mostly on its colour';
    else if (mine.length && same.length * 2 < mine.length)
      verdict = ' — a good bishop, its own pawns mostly on the other colour';
    facts.push(
      `${owned(bishop)} (${colour} squares): ${same.length} of its side's ${mine.length} pawns on its colour (${blocked.length} of them blocked), ${theirs.length} enemy pawns on its colour${verdict}`,
    );
  }
  const minors = (color: Color) => {
    const b = pieces.filter(p => p.color === color && p.type === 'b').length;
    const n = pieces.filter(p => p.color === color && p.type === 'n').length;
    return { b, n };
  };
  const [w, k] = [minors('w'), minors('b')];
  if (w.b === 2 && k.b < 2) facts.push('White has the bishop pair');
  if (k.b === 2 && w.b < 2) facts.push('Black has the bishop pair');
  if (w.b + w.n === k.b + k.n && w.b !== k.b)
    facts.push(
      `Minor pieces are unbalanced: White has ${w.b} bishop${w.b === 1 ? '' : 's'} and ${w.n} knight${w.n === 1 ? '' : 's'}, Black ${k.b} and ${k.n}`,
    );
  const lone = pieces.filter(p => p.type === 'b');
  if (
    lone.length === 2 &&
    lone[0].color !== lone[1].color &&
    shade(lone[0].square) !== shade(lone[1].square)
  )
    facts.push('The bishops are of opposite colours');
  return facts;
}

/** The board with `color` to move, or null when that is not a legal position (the other side is in check). */
function withTurn(board: Chess, color: Color): Chess | null {
  if (board.turn() === color) return board;
  // The side to move is in check, so handing the move to the other side would be illegal.
  if (board.isCheck()) return null;
  const parts = board.fen().split(' ');
  parts[1] = color;
  parts[3] = '-';
  try {
    return new Chess(parts.join(' '));
  } catch {
    return null;
  }
}

/**
 * Pieces (not kings or pawns) with at most one safe move: a move to a square that no enemy pawn
 * attacks and that is not attacked by a cheaper enemy piece or left undefended while attacked.
 */
function restricted(board: Chess, color: Color): string[] {
  const turn = withTurn(board, color);
  if (!turn) return [];
  const enemy = other(color);
  const result: string[] = [];
  const stuck: string[] = [];
  let total = 0;
  for (const piece of placed(board).filter(
    p => p.color === color && p.type !== 'k' && p.type !== 'p',
  )) {
    const safe = turn.moves({ square: piece.square, verbose: true }).filter(move => {
      if (move.captured)
        return VALUE[move.captured] >= VALUE[piece.type] || !board.attackers(move.to, enemy).length;
      const attackers = board.attackers(move.to, enemy).map(sq => board.get(sq)!);
      if (!attackers.length) return true;
      if (attackers.some(a => VALUE[a.type] < VALUE[piece.type] || a.type === 'p')) return false;
      return board.attackers(move.to, color).some(sq => sq !== piece.square);
    });
    total += safe.length;
    if (safe.length <= 1)
      result.push(`${label(piece)} (${safe.length ? `only ${safe[0].san}` : 'none'})`);
    else if (
      (piece.type === 'n' || piece.type === 'b') &&
      !safe.some(move => relRank(color, rankOf(move.to)) > relRank(color, rankOf(piece.square)))
    )
      stuck.push(label(piece));
  }
  const facts = [`${SIDE[color]} pieces have ${total} safe moves in all`];
  if (result.length)
    facts.push(`${SIDE[color]} pieces with at most one safe move: ${result.join(', ')}`);
  if (stuck.length)
    facts.push(`${SIDE[color]} minor pieces with no safe move forward: ${stuck.join(', ')}`);
  return facts;
}

/** Squares in the enemy half, and in the centre files c–f, that the side's pawns cover. */
function space(pawns: Pawns, color: Color): string {
  const covered = new Set(
    pawns[color]
      .flatMap(sq => pawnAttacks(color, sq))
      .filter(sq => relRank(color, rankOf(sq)) >= 5),
  );
  const central = [...covered].filter(sq => fileOf(sq) >= 2 && fileOf(sq) <= 5);
  return `${SIDE[color]} space: its pawns cover ${covered.size} squares in ${SIDE[other(color)]}'s half (${central.length} in the centre files c–f)`;
}

function kingSafety(board: Chess, pawns: Pawns, color: Color): string {
  const [king] = board.findPiece({ type: 'k', color });
  if (!king) return '';
  const mine = pawns[color];
  const enemy = other(color);
  const shield = mine.filter(
    sq =>
      Math.abs(fileOf(sq) - fileOf(king)) <= 1 &&
      relRank(color, rankOf(sq)) > relRank(color, rankOf(king)) &&
      relRank(color, rankOf(sq)) <= relRank(color, rankOf(king)) + 2,
  );
  const near = [-1, 0, 1].flatMap(df =>
    fileOf(king) + df >= 0 && fileOf(king) + df < 8 ? [fileOf(king) + df] : [],
  );
  const openNear = near.filter(file => !mine.some(sq => fileOf(sq) === file)).map(f => FILES[f]);
  const zone = [-1, 0, 1].flatMap(df =>
    [-1, 0, 1].flatMap(dr => at(fileOf(king) + df, rankOf(king) + dr) ?? []),
  );
  const attacked = zone.filter(sq => board.isAttacked(sq, enemy));
  // Without queens the king is a fighting piece: say where it can go forward without being taken.
  const queenless = !placed(board).some(piece => piece.type === 'q');
  const turn = queenless ? withTurn(board, color) : null;
  const entries = turn
    ? turn
        .moves({ square: king, verbose: true })
        .filter(move => relRank(color, rankOf(move.to)) > relRank(color, rankOf(king)))
        .map(move => move.to)
    : [];
  const advance = queenless
    ? `; safe squares forward for the king: ${entries.length ? list(entries) : 'none'}`
    : '';
  return (
    `${SIDE[color]} king ${king}: pawn cover ${shield.length ? list(shield) : 'none'}` +
    (openNear.length
      ? `; no own pawn on the ${openNear.join(', ')}-file${openNear.length > 1 ? 's' : ''} beside it`
      : '') +
    `; ${attacked.length} of the squares around it attacked by ${SIDE[enemy]}` +
    advance
  );
}

/** Pawn moves that would attack an enemy pawn, and captures of pawns already available. */
function breaks(board: Chess, pawns: Pawns, color: Color): string[] {
  const enemyPawns = new Set(pawns[other(color)]);
  const found: string[] = [];
  for (const pawn of pawns[color]) {
    const takes = pawnAttacks(color, pawn).filter(sq => enemyPawns.has(sq));
    for (const target of takes) found.push(`${pawn}x${target}`);
    const steps = [1, 2].map(n => at(fileOf(pawn), rankOf(pawn) + n * forward(color)));
    const one = steps[0];
    if (!one || board.get(one)) continue;
    const targets = [one];
    if (relRank(color, rankOf(pawn)) === 2 && steps[1] && !board.get(steps[1]))
      targets.push(steps[1]);
    for (const to of targets) {
      const hits = pawnAttacks(color, to).filter(sq => enemyPawns.has(sq));
      if (hits.length) found.push(`${pawn}-${to} (strikes ${list(hits)})`);
    }
  }
  return found.length ? [`${SIDE[color]} pawn breaks and pawn captures: ${found.join(', ')}`] : [];
}

/**
 * The positional features of `fen`, one short sentence each: pawn structure, open files,
 * outposts, bishops, restricted pieces, space, king cover and pawn breaks.
 */
export function positionalFacts(fen: string): string[] {
  const board = new Chess(fen);
  const pawns = pawnsOf(placed(board));
  const sides: Color[] = ['w', 'b'];
  return [
    ...sides.flatMap(color => pawnStructure(board, pawns, color)),
    ...files(board, pawns),
    ...sides.flatMap(color => outposts(board, pawns, color)),
    ...bishops(board, pawns),
    ...sides.flatMap(color => restricted(board, color)),
    ...sides.map(color => space(pawns, color)),
    ...sides.map(color => kingSafety(board, pawns, color)).filter(Boolean),
    ...sides.flatMap(color => breaks(board, pawns, color)),
  ];
}

/** What changed between two positions' positional facts: sentences that went and came. */
export function positionalChange(before: string[], after: string[]) {
  return {
    gone: before.filter(fact => !after.includes(fact)),
    new: after.filter(fact => !before.includes(fact)),
  };
}
