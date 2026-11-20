/**
 * What a move missed, worked out from the board and the engine rather than
 * guessed: the reply it allowed and what that wins, a threat that was already
 * there (seen by letting the mover pass), a win the mover had and did not
 * take, or, when no material is at stake, how the position's features differ
 * between the line after the move and the line after the engine's choice.
 */
import { Chess, type Color, type PieceSymbol } from 'chess.js';
import type { Analysis, Evaluation } from '../shared/protocol.ts';
import { winChance } from '../shared/quality.ts';
import { describeLine, positionalChange, positionalFacts } from './facts.ts';

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};
const enemy = (color: Color): Color => (color === 'w' ? 'b' : 'w');

const counts = (board: Chess, color: Color) => {
  const found: Partial<Record<PieceSymbol, number>> = {};
  for (const row of board.board())
    for (const piece of row)
      if (piece?.color === color) found[piece.type] = (found[piece.type] ?? 0) + 1;
  return found;
};
const points = (board: Chess, color: Color) =>
  Object.entries(counts(board, color)).reduce(
    (sum, [type, count]) => sum + VALUE[type as PieceSymbol] * count!,
    0,
  );
/** `color`'s material lead, in pawns. */
export const balance = (board: Chess, color: Color) =>
  points(board, color) - points(board, enemy(color));

/**
 * Plays the start of `line` from `fen`: at least `plies` half-moves, and on
 * through any captures or checks still going on, so an exchange is not cut in half.
 */
export function playLine(fen: string, line: string[], plies = 6): Chess {
  const board = new Chess(fen);
  for (let index = 0; index < Math.min(line.length, plies + 4); index++) {
    const move = board.move(line[index]);
    if (index + 1 >= plies && !move.captured && !board.isCheck()) break;
  }
  return board;
}

const pieces = (net: [PieceSymbol, number][]) =>
  net
    .map(([type, count]) => (count === 1 ? `a ${NAME[type]}` : `${count} ${NAME[type]}s`))
    .join(' and ');

/** What `color` wins along a line, net of what it gives back: "a knight for a pawn". */
export function winnings(before: Chess, after: Chess, color: Color): string {
  const lossOf = (side: Color) => {
    const [was, is] = [counts(before, side), counts(after, side)];
    return (type: PieceSymbol) => (was[type] ?? 0) - (is[type] ?? 0);
  };
  const [theirs, mine] = [lossOf(enemy(color)), lossOf(color)];
  const net = (Object.keys(NAME) as PieceSymbol[]).map(
    type => [type, theirs(type) - mine(type)] as [PieceSymbol, number],
  );
  const won = net.filter(([, count]) => count > 0);
  const given = net
    .filter(([, count]) => count < 0)
    .map(([type, count]) => [type, -count] as [PieceSymbol, number]);
  return given.length ? `${pieces(won)} for ${pieces(given)}` : pieces(won);
}

/** One move in words: "Qa5+ (queen d8 to a5, with check, attacking bishop d2)". */
export function moveInWords(fen: string, san: string): string {
  const [step] = describeLine(fen, [san], 1).steps;
  const parts = [step.does];
  if (step.check) parts.push('with check');
  if (step.attacks?.length) parts.push(`attacking ${step.attacks.join(' and ')}`);
  if (step.uncovers?.length) parts.push(`uncovering ${step.uncovers.join(' and ')}`);
  return `${san} (${parts.join(', ')})`;
}

/** Whether `evaluation` is a forced mate for `color` (scores are from White's side). */
export function mate(evaluation: Evaluation, color: Color): boolean {
  if (evaluation.type !== 'mate') return false;
  const winner =
    evaluation.value > 0
      ? 'w'
      : evaluation.value < 0
        ? 'b'
        : evaluation.winner === 'white'
          ? 'w'
          : 'b';
  return winner === color;
}

/** `color`'s winning chances, 0 to 100. */
export const chances = (evaluation: Evaluation, color: Color) =>
  color === 'w' ? winChance(evaluation) : 100 - winChance(evaluation);

/** The position with the other side to move, as if the side to move had passed; null in check. */
export function passed(fen: string): string | null {
  const board = new Chess(fen);
  if (board.isCheck()) return null;
  const fields = fen.split(' ');
  fields[1] = fields[1] === 'w' ? 'b' : 'w';
  fields[3] = '-';
  try {
    const flipped = new Chess(fields.join(' '));
    return flipped.isCheck() ? null : flipped.fen();
  } catch {
    return null;
  }
}

/** The engine's moves within `margin` points of winning chances of its first choice, in SAN. */
export const goodMoves = (analysis: Analysis, color: Color, margin: number) => {
  const best = chances(analysis.moves[0].evaluation, color);
  return analysis.moves
    .filter(move => best - chances(move.evaluation, color) <= margin)
    .map(move => move.san);
};

/**
 * A positional fact with what changes on almost every move taken out (pawn
 * lists, counts of safe moves, squares attacked, how many pawns stand on a
 * bishop's colour), so that two positions differ only where a feature does.
 * Empty for facts that are only counts.
 */
export function gist(fact: string): string {
  if (/safe moves in all|^(White|Black) space:/.test(fact)) return '';
  const pawns = /^(White|Black) pawns: [^;]*; (\d+ islands?)/.exec(fact);
  if (pawns) return `${pawns[1]} pawns: ${pawns[2]}`;
  const bishop = /^(White|Black) bishop [a-h][1-8] (\([a-z]+ squares\)).* — (.*)$/.exec(fact);
  if (bishop) return `${bishop[1]} bishop ${bishop[2]}: ${bishop[3]}`;
  return fact.replace(/; \d+ of the squares around it attacked by (White|Black)/, '');
}

/** The features that differ between two positions, as sentences that come about or go away. */
export function featureChange(fromFen: string, toFen: string) {
  const [was, is] = [positionalFacts(fromFen), positionalFacts(toFen)];
  return positionalChange(was.map(gist).filter(Boolean), is.map(gist).filter(Boolean));
}

export type Category = 'allowed' | 'allowed-mate' | 'threat' | 'chance' | 'missed-mate';

export type Diagnosis = {
  move: string;
  /** The mover's winning chances before and after, and the points given up. */
  chances: { before: number; after: number; lost: number };
  /** What was missed, when it can be shown; absent when no material or mate is at stake. */
  category?: Category;
  /** The finding in one sentence, for a move that missed something. */
  finding?: string;
  /** The engine's moves that keep the position, other than the move played. */
  better: string[];
  /** The opponent's best reply to the move and its line. */
  reply?: { move: string; line: string[]; wins?: string };
  /** What the opponent would play if the mover passed, and what it wins. */
  threatBefore?: { move: string; wins: string; stillThere: boolean };
  /** The engine's choice and its line, with what it wins when it wins material. */
  best?: { move: string; line: string[]; wins?: string };
  /** Features that differ between the end of the line after the move and after the engine's choice. */
  positional?: { afterMove: string[]; afterBest: string[] };
};

type Analyze = (fen: string, moves?: string[]) => Promise<Analysis>;

/** Diagnoses `san` played in `fen`, with `analyze` as the engine. */
export async function diagnoseMove(fen: string, san: string, analyze: Analyze): Promise<Diagnosis> {
  const start = new Chess(fen);
  const color = start.turn();
  const played = new Chess(fen).move(san).san;
  const afterFen = (() => {
    const board = new Chess(fen);
    board.move(played);
    return board.fen();
  })();
  const pass = passed(fen);
  const [before, after, threat] = await Promise.all([
    analyze(fen),
    analyze(fen, [played]),
    pass ? analyze(pass) : Promise.resolve(null),
  ]);
  const was = chances(before.evaluation, color);
  const is = chances(after.evaluation, color);
  const lost = Math.max(0, played === before.moves[0]?.san ? 0 : was - is);
  const result: Diagnosis = {
    move: played,
    chances: { before: Math.round(was), after: Math.round(is), lost: Math.round(lost) },
    better: goodMoves(before, color, 5).filter(move => move !== played),
  };

  const bestMove = before.moves[0];
  const bestLine = bestMove ? playLine(fen, bestMove.continuation) : start;
  const gain = balance(bestLine, color) - balance(start, color);
  if (bestMove) {
    result.best = {
      move: bestMove.san,
      line: bestMove.continuation.slice(0, 8),
      ...(gain >= 2 && { wins: winnings(start, bestLine, color) }),
    };
  }
  const reply = after.moves[0];
  const replyLine = reply ? playLine(afterFen, reply.continuation) : new Chess(afterFen);
  const swing = balance(start, color) - balance(replyLine, color);
  if (reply) {
    result.reply = {
      move: moveInWords(afterFen, reply.san),
      line: reply.continuation.slice(0, 8),
      ...(swing >= 2 && { wins: winnings(new Chess(afterFen), replyLine, enemy(color)) }),
    };
  }
  const threatMove = threat?.moves[0];
  if (pass && threatMove) {
    const threatLine = playLine(pass, threatMove.continuation);
    const threatGain = balance(threatLine, enemy(color)) - balance(new Chess(pass), enemy(color));
    if (threatGain >= 2 || mate(threat.evaluation, enemy(color))) {
      const same =
        !!reply &&
        (threatMove.san === reply.san || threatMove.move.slice(2, 4) === reply.move.slice(2, 4));
      result.threatBefore = {
        move: moveInWords(pass, threatMove.san),
        wins: mate(threat.evaluation, enemy(color))
          ? 'a forced mate'
          : winnings(new Chess(pass), threatLine, enemy(color)),
        stillThere: same && swing >= 2,
      };
    }
  }

  if (lost >= 8) {
    if (mate(after.evaluation, enemy(color)) && reply) {
      result.category = 'allowed-mate';
      result.finding = `${played} allows a mating attack, starting with ${result.reply!.move}.`;
    } else if (mate(before.evaluation, color) && !mate(after.evaluation, color) && bestMove) {
      result.category = 'missed-mate';
      result.finding = `There was a forced mate starting with ${moveInWords(fen, bestMove.san)}, and ${played} misses it.`;
    } else if (swing >= 2 && reply) {
      if (result.threatBefore?.stillThere) {
        result.category = 'threat';
        result.finding = `The opponent was already threatening ${result.threatBefore.move} before ${played}, and ${played} does nothing about it: the opponent wins ${result.reply!.wins}.`;
      } else {
        result.category = 'allowed';
        result.finding = `${played} allows ${result.reply!.move}, after which the opponent wins ${result.reply!.wins}.`;
      }
    } else if (gain >= 2 && balance(replyLine, color) - balance(start, color) < 2 && bestMove) {
      result.category = 'chance';
      result.finding = `${moveInWords(fen, bestMove.san)} was available and wins ${result.best!.wins}; ${played} lets the chance go.`;
    }
  }
  if (!result.category && bestMove && reply && played !== bestMove.san) {
    // No material at stake: say how the two lines leave the position.
    const end = (line: string[], from: string) => playLine(from, line, 8).fen();
    const afterMove = end(reply.continuation, afterFen);
    const afterBest = end(bestMove.continuation, fen);
    const change = featureChange(afterBest, afterMove);
    result.positional = { afterMove: change.new.slice(0, 6), afterBest: change.gone.slice(0, 6) };
  }
  return result;
}
