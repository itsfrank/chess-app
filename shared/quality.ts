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
  /** Running average accuracy across evaluated moves for this side; null when none are evaluated yet. */
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
    return { accuracy: known.length ? accuracyOf(known) : null, counts };
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

/**
 * What the Explain button asks the companion about the move at `index`, sent
 * with the position before it. `mine` says whether the user played the move.
 */
export function explainPrompt(
  moves: string[],
  index: number,
  review: MoveReview,
  mine: boolean,
): string {
  const verdict =
    review.quality.id === 'book'
      ? 'It is common opening theory. Explain the idea behind it and name the main alternatives.'
      : review.best === moves[index]
        ? `The engine review labels it ${review.quality.label}: it is the engine's own choice. Explain the idea behind it and, using Stockfish, what the most natural alternative would have allowed.`
        : `The engine review labels it ${review.quality.label} and prefers ${review.best}. Using Stockfish from this position, compare the two: where does each lead, and what did the move played miss or allow? Draw one arrow for the move played and one for the engine's choice.`;
  return `From this position ${mine ? 'I' : 'my opponent'} played ${numberedMove(index, moves[index])}. ${verdict}`;
}

/** One critical decision by the reviewed player: the position before `moves[index]`. */
export type TurningPoint = {
  /** 0-based half-move index in `moves` (so the board before this decision is at `ply = index`). */
  index: number;
  /** The SAN move the player actually played in the game. */
  played: string;
  /** Stockfish's preferred SAN move in that position. */
  best: string | null;
  review: MoveReview;
};

/**
 * Picks up to `max` biggest mistakes by `playerColor` (win-chance loss > ERROR_LOSS),
 * ranked by loss descending and returned in chronological order.
 */
export function turningPoints(
  moves: readonly string[],
  review: GameReview,
  playerColor: PlayerColor,
  max = 5,
): TurningPoint[] {
  const parity = playerColor === 'white' ? 0 : 1;
  const candidates: TurningPoint[] = [];
  for (let index = 0; index < moves.length; index++) {
    if (index % 2 !== parity) continue;
    const moveReview = review.moves[index];
    if (!moveReview || moveReview.loss <= ERROR_LOSS) continue;
    if (moveReview.quality.id === 'book') continue;
    candidates.push({
      index,
      played: moves[index],
      best: moveReview.best,
      review: moveReview,
    });
  }
  return candidates
    .sort((a, b) => b.review.loss - a.review.loss || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
}

/**
 * Builds the coach debrief prompt sent from the position before `point.played`
 * after the player commits to a candidate move (or reveals without guessing).
 */
export function coachDebriefPrompt(
  point: TurningPoint,
  attempt: string | null,
  note: string,
): string {
  const gameMove = numberedMove(point.index, point.played);
  const label = point.review.quality.label.toLowerCase();
  const bestText = point.best ? `The engine prefers ${point.best}.` : '';
  const trimmedNote = note.trim();
  const reason = trimmedNote ? ` My thinking: "${trimmedNote}".` : '';

  if (!attempt) {
    return (
      `During guided review I skipped guessing here. In the game I played ${gameMove} (${label}). ` +
      `${bestText} Using diagnose_move and Stockfish from this position, explain concretely why ${point.played} went wrong, ` +
      `what ${point.best ?? 'the best move'} achieves instead, and draw arrows for both.`
    );
  }
  if (point.best && attempt === point.best) {
    return (
      `During guided review I tried ${attempt} here (which matches the engine's top choice).${reason} ` +
      `In the game I had played ${gameMove} (${label}). Using diagnose_move on ${point.played} and Stockfish, ` +
      `confirm why ${attempt} works (addressing my reasoning if given), contrast it with what ${point.played} missed or allowed, ` +
      `and draw arrows for both.`
    );
  }
  if (attempt === point.played) {
    return (
      `During guided review I tried ${attempt} again — the same ${label} I played in the game (${gameMove}).${reason} ` +
      `${bestText} Address my thinking directly first, use diagnose_move on ${point.played} to show the concrete refutation or downside, ` +
      `and compare it with ${point.best ?? 'the engine choice'} with arrows for both.`
    );
  }
  return (
    `During guided review I tried ${attempt} instead of my game move ${gameMove} (${label}).${reason} ` +
    `${bestText} Address my reasoning directly first, evaluate my try ${attempt} alongside ${point.played} and ${point.best ?? 'the best move'} ` +
    `using diagnose_move and analyze_position, and draw clear arrows on this position.`
  );
}
