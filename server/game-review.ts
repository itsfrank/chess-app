import { Chess } from 'chess.js';
import {
  formatClock,
  formatThinkTime,
  isImpulsiveError,
  isTimeTrouble,
  moveThinkTimes,
  parseTimeControl,
} from '../shared/clock.ts';
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

/**
 * A review request: its moves, checked to be a legal game from the starting
 * position, and whether verdicts from a shallower search are to be replaced.
 */
export function parseReviewRequest(body: unknown): { moves: string[]; refresh: boolean } {
  const { moves, refresh } = (body ?? {}) as { moves?: unknown; refresh?: unknown };
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
  return { moves, refresh: refresh === true };
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
  evaluator?: Pick<Evaluator, 'cached' | 'current' | 'evaluate' | 'release' | 'dispose'> & {
    concurrency?: number;
  };
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

  /** The depth a review is searched at when nothing is stored. */
  get configuredDepth(): number {
    return this.depth();
  }

  /**
   * Evaluates the game's positions, reporting cached verdicts at once and
   * searching the rest in parallel across the evaluator's workers. Stored
   * verdicts from a shallower search are used as they are unless `refresh` asks
   * for them to be searched again. Meanwhile `onBook` hears how many opening
   * half-moves are theory each time that number grows.
   */
  async evaluate(
    moves: string[],
    signal: AbortSignal,
    onEval: (ply: number, result: PositionEval, stale: boolean) => void,
    onBook: (plies: number) => void = () => {},
    refresh = false,
  ) {
    this.running++;
    const fens = positionsOf(moves);
    // Book labels are a refinement: without the explorer the review is simply without them.
    const book = this.findBook(moves, fens, signal, onBook).catch(() => {});
    try {
      const toSearch: number[] = [];
      for (const [ply, fen] of fens.entries()) {
        signal.throwIfAborted();
        const key = positionKey(fen);
        const known = this.evaluator.cached(key);
        if (known && (this.evaluator.current(key) || !refresh)) {
          onEval(ply, known, !this.evaluator.current(key));
        } else {
          toSearch.push(ply);
        }
      }
      const workers = Math.max(1, Math.min(this.evaluator.concurrency ?? 1, toSearch.length));
      let next = 0;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (next < toSearch.length) {
            signal.throwIfAborted();
            const ply = toSearch[next++];
            const result = await this.evaluator.evaluate(fens[ply], signal);
            signal.throwIfAborted();
            onEval(ply, result, false);
          }
        }),
      );
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

  /** Synchronous cached review of `moves`, or null if any position has not been searched yet. */
  cachedReview(moves: string[]): ReturnType<typeof reviewGame> | null {
    if (!moves.length) return null;
    let fens: string[];
    try {
      fens = positionsOf(moves);
    } catch {
      return null;
    }
    const keys = fens.map(positionKey);
    const evals = keys.map(key => this.evaluator.cached(key));
    if (evals.some(result => !result)) return null;
    return reviewGame(moves, evals, this.bookPlies(moves, fens));
  }

  /** The finished review in words for the companion, or null until every position is searched. */
  summary(moves: string[], clocks?: readonly number[], timeControl = '') {
    const fens = positionsOf(moves);
    const keys = fens.map(positionKey);
    const evals = keys.map(key => this.evaluator.cached(key));
    if (evals.some(result => !result)) return null;
    const shallow = keys.some(key => !this.evaluator.current(key));
    const review = reviewGame(moves, evals, this.bookPlies(moves, fens));
    const thinkTimes = moveThinkTimes(clocks, timeControl);
    const base = parseTimeControl(timeControl)?.base ?? null;
    const side = ({ accuracy, counts }: typeof review.white) => ({
      accuracy: accuracy === null ? null : Number(accuracy.toFixed(1)),
      ...counts,
    });
    const labelled = (id: QualityId) =>
      review.moves.flatMap((move, index) =>
        move?.quality.id === id ? numberedMove(index, moves[index]) : [],
      );
    const clockNote = (index: number) => {
      const remaining = clocks?.[index];
      if (remaining === undefined) return '';
      const spent = thinkTimes[index] ?? null;
      const parts = [
        spent !== null ? `spent ${formatThinkTime(spent)}` : null,
        `${formatClock(remaining)} left`,
      ].filter(Boolean);
      const tag = isTimeTrouble(remaining, base)
        ? ' — time trouble'
        : isImpulsiveError(spent, remaining, base)
          ? ' — fast/impulsive'
          : '';
      return ` (${parts.join(', ')}${tag})`;
    };
    return {
      engine: shallow
        ? `Stockfish, partly at less than depth ${this.depth()}`
        : `Stockfish depth ${this.depth()}`,
      white: side(review.white),
      black: side(review.black),
      /** The last move that was still opening theory. */
      bookUntil: labelled('book').at(-1) ?? null,
      /** Moves that were the only good one in their position. */
      great: labelled('great'),
      /** Every move that was not at least good, with the mover's winning chances around it. */
      errors: review.moves.flatMap((move, index) =>
        move && move.loss > ERROR_LOSS
          ? `${numberedMove(index, moves[index])}: ${move.quality.id}, winning chances ${percent(move.before)} to ${percent(move.after)}, engine preferred ${move.best}${clockNote(index)}`
          : [],
      ),
    };
  }

  dispose() {
    this.book.flush();
    this.evaluator.dispose();
  }
}
