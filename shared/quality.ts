/** Move-quality labels and accuracy for a finished game, from one engine verdict per position. */
import { Chess } from 'chess.js';
import type { Evaluation, PlayerColor, PositionEval } from './protocol.ts';

/** Best first. A move's label is the first whose limit covers the winning chances it gave up. */
export const QUALITIES = [
  { id: 'book', label: 'Book', glyph: '📖', maxLoss: 0 },
  { id: 'great', label: 'Great', glyph: '!', maxLoss: 0 },
  { id: 'best', label: 'Best', glyph: '★', maxLoss: 0 },
  { id: 'excellent', label: 'Excellent', glyph: '✓', maxLoss: 2 },
  { id: 'good', label: 'Good', glyph: '✓', maxLoss: 5 },
  { id: 'inaccuracy', label: 'Inaccuracy', glyph: '?!', maxLoss: 10 },
  { id: 'mistake', label: 'Mistake', glyph: '?', maxLoss: 20 },
  { id: 'blunder', label: 'Blunder', glyph: '??', maxLoss: 100 },
] as const;
export type Quality = (typeof QUALITIES)[number];
export type QualityId = Quality['id'];

export type MoveReview = {
  quality: Quality;
  /** Percentage points of winning chances the move gave up, for the side that played it. */
  loss: number;
  /** The mover's winning chances before and after the move, 0 to 100. */
  before: number;
  after: number;
  /** The engine's choice in SAN; equal to the move played when the label is Great or Best. */
  best: string | null;
  /** 0 to 100 for this one move. */
  accuracy: number;
};

export type SideReview = {
  /** Null until every move of this side has been evaluated. */
  accuracy: number | null;
  counts: Record<QualityId, number>;
};
export type GameReview = {
  /** One entry per half-move; undefined where the engine has not got to yet. */
  moves: (MoveReview | undefined)[];
  white: SideReview;
  black: SideReview;
  /** Half-moves reviewed so far. */
  done: number;
};

/** White's winning chances from 0 to 100, on the curve Lichess fits to real games. */
export function winChance(evaluation: Evaluation): number {
  if (evaluation.type === 'mate')
    return evaluation.value > 0 || (evaluation.value === 0 && evaluation.winner === 'white')
      ? 100
      : 0;
  const centipawns = Math.max(-1000, Math.min(1000, evaluation.value));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * centipawns)) - 1);
}

/** Lichess's accuracy for one move, from the winning chances it gave up. */
const moveAccuracy = (loss: number) =>
  Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

/** The engine's second choice must cost more than this for its first to be the only good move. */
const GREAT_GAP = 10;
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * Labels the move `san`, given the engine's verdicts on the positions before
 * and after it. An `obvious` move, such as taking back, is never Great.
 */
export function reviewMove(
  san: string,
  mover: PlayerColor,
  before: PositionEval,
  after: PositionEval,
  obvious = false,
): MoveReview {
  const side = (chance: number) => (mover === 'white' ? chance : 100 - chance);
  const [was, is] = [side(winChance(before.evaluation)), side(winChance(after.evaluation))];
  // Two searches of the same line rarely agree exactly, so the engine's own move never loses.
  const loss = san === before.best ? 0 : Math.max(0, was - is);
  // Great: the engine's move, when every alternative was a mistake and it had to be found.
  const onlyMove = !!before.second && !obvious && was - side(winChance(before.second)) > GREAT_GAP;
  const quality =
    san !== before.best
      ? QUALITIES.find(q => q.maxLoss > 0 && loss <= q.maxLoss)!
      : QUALITIES.find(q => q.id === (onlyMove ? 'great' : 'best'))!;
  return { quality, loss, before: was, after: is, best: before.best, accuracy: moveAccuracy(loss) };
}

/** A side's accuracy: midway between the plain and the harmonic mean, so bad moves weigh more. */
function accuracyOf(moves: MoveReview[]): number | null {
  if (!moves.length) return null;
  const mean = moves.reduce((sum, move) => sum + move.accuracy, 0) / moves.length;
  const harmonic =
    moves.length / moves.reduce((sum, move) => sum + 1 / Math.max(1, move.accuracy), 0);
  return (mean + harmonic) / 2;
}

/** A move that gives up more than this is an error, and never opening theory. */
export const ERROR_LOSS = 5;

/**
 * Reviews a game from `evals`, the verdicts on its positions in order starting
 * with the initial one (one more than there are moves when complete). The
 * first `book` half-moves are known opening theory and are labelled Book, up
 * to the first of them that the engine calls an error.
 */
export function reviewGame(
  moves: string[],
  evals: (PositionEval | undefined)[],
  book = 0,
): GameReview {
  const board = new Chess();
  let captureSquare = '';
  const reviews = moves.map((san, index) => {
    const move = board.move(san);
    // Taking back, or taking a piece worth at least the one that takes, needs no finding.
    const obvious =
      !!move.captured &&
      (move.to === captureSquare || PIECE_VALUE[move.captured] >= PIECE_VALUE[move.piece]);
    captureSquare = move.captured ? move.to : '';
    const [before, after] = [evals[index], evals[index + 1]];
    if (!before || !after) return undefined;
    const review = reviewMove(san, index % 2 === 0 ? 'white' : 'black', before, after, obvious);
    if (index >= book || review.loss > ERROR_LOSS) book = 0;
    return index < book ? { ...review, quality: QUALITIES[0] } : review;
  });
  const side = (parity: number): SideReview => {
    const own = reviews.filter((_, index) => index % 2 === parity);
    const known = own.filter(review => review !== undefined);
    const counts = Object.fromEntries(QUALITIES.map(quality => [quality.id, 0])) as Record<
      QualityId,
      number
    >;
    for (const review of known) counts[review.quality.id]++;
    return { accuracy: known.length === own.length ? accuracyOf(known) : null, counts };
  };
  return {
    moves: reviews,
    white: side(0),
    black: side(1),
    done: reviews.filter(Boolean).length,
  };
}

/** "12. Nxe5" or "12… Nxe5" for the half-move at `index`. */
export const numberedMove = (index: number, san: string) =>
  `${Math.floor(index / 2) + 1}${index % 2 === 0 ? '.' : '…'} ${san}`;
