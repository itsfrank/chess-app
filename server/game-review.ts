import { Chess } from 'chess.js';
import { DEFAULT_SETTINGS, type PositionEval } from '../shared/protocol.ts';
import { positionKey } from '../shared/repertoire.ts';
import { ERROR_LOSS, numberedMove, reviewGame, type QualityId } from '../shared/quality.ts';
import { BOOK, BOOK_CACHE_FILE, GAME_EVAL_CACHE_FILE, MAX_REVIEW_MOVES } from './config.ts';
import { Evaluator } from './evaluator.ts';
import { HttpError } from './http.ts';
import { explore } from './lichess.ts';
import { JsonCache } from './repertoires.ts';

/** The position before each move and the final one, as FEN. */
function positionsOf(moves: string[]): string[] {
  const board = new Chess();
  const fens = [board.fen()];
  for (const san of moves) {
    board.move(san);
    fens.push(board.fen());
  }
  return fens;
}

/** The moves of a review request, checked to be a legal game from the starting position. */
export function parseReviewRequest(body: unknown): string[] {
  const moves = (body as { moves?: unknown } | null)?.moves;
  if (
    !Array.isArray(moves) ||
    !moves.length ||
    moves.length > MAX_REVIEW_MOVES ||
    !moves.every((move): move is string => typeof move === 'string')
  ) {
    throw new HttpError(400, 'Invalid game');
  }
  try {
    positionsOf(moves);
  } catch {
    throw new HttpError(400, 'Invalid game');
  }
  return moves;
}

const percent = (value: number) => `${Math.round(value)}%`;

/** The moves that count as opening theory in a position, in SAN. */
export type BookLoader = (fen: string, signal: AbortSignal) => Promise<string[]>;

const lichessBook: BookLoader = async (fen, signal) => {
  const result = await explore(fen, { ratings: BOOK.ratings }, signal);
  return result.moves
    .filter(move => move.games >= BOOK.minGames && (move.frequency ?? 0) >= BOOK.minShare)
    .map(move => move.san);
};

export type GameReviewOptions = {
  evaluator?: Pick<Evaluator, 'cached' | 'evaluate' | 'release' | 'dispose'>;
  loadBook?: BookLoader;
  bookFile?: string;
  /** The engine depth to review at, asked for before every search. */
  depth?: () => number;
};

/**
 * Engine verdicts on every position of a game, searched once at a fixed depth
 * and kept on disk, plus how far the game followed opening theory. The browser
 * turns them into move labels and accuracy; the companion gets the same review
 * as text.
 */
export class GameReviewService {
  private readonly evaluator: NonNullable<GameReviewOptions['evaluator']>;
  private readonly loadBook: BookLoader;
  /** Book moves by position, so each opening position is looked up once. */
  private readonly book: JsonCache<string[]>;
  private readonly depth: () => number;
  private running = 0;

  constructor(options: GameReviewOptions = {}) {
    this.depth = options.depth ?? (() => DEFAULT_SETTINGS.gameReviewDepth);
    this.evaluator = options.evaluator ?? new Evaluator(GAME_EVAL_CACHE_FILE, this.depth, 2);
    this.loadBook = options.loadBook ?? lichessBook;
    this.book = new JsonCache(options.bookFile ?? BOOK_CACHE_FILE);
  }

  /**
   * Evaluates the game's positions in order, reporting each as soon as it is
   * known. Meanwhile `onBook` hears how many opening half-moves are theory
   * each time that number grows.
   */
  async evaluate(
    moves: string[],
    signal: AbortSignal,
    onEval: (ply: number, result: PositionEval) => void,
    onBook: (plies: number) => void = () => {},
  ) {
    this.running++;
    const fens = positionsOf(moves);
    // Book labels are a refinement: without the explorer the review is simply without them.
    const book = this.findBook(moves, fens, signal, onBook).catch(() => {});
    try {
      for (const [ply, fen] of fens.entries()) {
        signal.throwIfAborted();
        onEval(ply, await this.evaluator.evaluate(fen, signal));
      }
      await book;
    } finally {
      if (--this.running === 0) this.evaluator.release();
    }
  }

  private async findBook(
    moves: string[],
    fens: string[],
    signal: AbortSignal,
    onBook: (plies: number) => void,
  ) {
    for (let ply = 0; ply < Math.min(moves.length, BOOK.maxPlies); ply++) {
      signal.throwIfAborted();
      const key = positionKey(fens[ply]);
      let known = this.book.get(key);
      if (!known) this.book.set(key, (known = await this.loadBook(fens[ply], signal)));
      if (!known.includes(moves[ply])) return;
      onBook(ply + 1);
    }
  }

  /** How many opening half-moves are theory, as far as the lookups so far can tell. */
  private bookPlies(moves: string[], fens: string[]): number {
    let ply = 0;
    while (ply < Math.min(moves.length, BOOK.maxPlies)) {
      if (!this.book.get(positionKey(fens[ply]))?.includes(moves[ply])) break;
      ply++;
    }
    return ply;
  }

  /** The finished review in words for the companion, or null until every position is searched. */
  summary(moves: string[]) {
    const fens = positionsOf(moves);
    const evals = fens.map(fen => this.evaluator.cached(positionKey(fen)));
    if (evals.some(result => !result)) return null;
    const review = reviewGame(moves, evals, this.bookPlies(moves, fens));
    const side = ({ accuracy, counts }: typeof review.white) => ({
      accuracy: accuracy === null ? null : Number(accuracy.toFixed(1)),
      ...counts,
    });
    const labelled = (id: QualityId) =>
      review.moves.flatMap((move, index) =>
        move?.quality.id === id ? numberedMove(index, moves[index]) : [],
      );
    return {
      engine: `Stockfish depth ${this.depth()}`,
      white: side(review.white),
      black: side(review.black),
      /** The last move that was still opening theory. */
      bookUntil: labelled('book').at(-1) ?? null,
      /** Moves that were the only good one in their position. */
      great: labelled('great'),
      /** Every move that was not at least good, with the mover's winning chances around it. */
      errors: review.moves.flatMap((move, index) =>
        move && move.loss > ERROR_LOSS
          ? `${numberedMove(index, moves[index])}: ${move.quality.id}, winning chances ${percent(move.before)} to ${percent(move.after)}, engine preferred ${move.best}`
          : [],
      ),
    };
  }

  dispose() {
    this.book.flush();
    this.evaluator.dispose();
  }
}
