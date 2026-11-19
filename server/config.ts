import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Git-ignored local state: usage totals, recordings, tokens and the Maia3 install. */
export const DATA_DIR = fileURLToPath(new URL('../.data', import.meta.url));
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const USAGE_FILE = join(DATA_DIR, 'usage.json');
export const LICHESS_TOKEN_FILE = join(DATA_DIR, 'lichess-token');
export const MAIA_DIR = join(DATA_DIR, 'maia3-spike');
export const REPERTOIRES_DIR = join(DATA_DIR, 'repertoires');
export const EVAL_CACHE_FILE = join(DATA_DIR, 'eval-cache.json');
export const BOOK_CACHE_FILE = join(DATA_DIR, 'book-cache.json');
export const GAME_EVAL_CACHE_FILE = join(DATA_DIR, 'game-eval-cache.json');
export const FREQUENCY_CACHE_FILE = join(DATA_DIR, 'frequency-cache.json');

export const PORT = Number(process.env.PORT || 3001);

/**
 * The only model the companion uses; there is deliberately no fallback.
 * `CHESS_MODEL` picks another model of the same provider and `CHESS_THINKING`
 * its reasoning effort, for comparing models.
 */
export const MODEL = {
  provider: 'openai-codex',
  id: process.env.CHESS_MODEL || 'gpt-6.1-sol',
  thinking: process.env.CHESS_THINKING || 'medium',
};
export const MODEL_NAME = `${MODEL.provider}/${MODEL.id}:${MODEL.thinking}`;

export const ENGINE = {
  path: process.env.STOCKFISH_PATH || 'stockfish',
  movetime: 1500,
  multiPV: 3,
  threads: 1,
  hashMB: 32,
};
export const ENGINE_TIMEOUT_MS = 10_000;

/** Repertoire analysis: every position is searched once to a fixed depth so scores are comparable. */
export const BATCH_ENGINE = {
  depth: 18,
  threads: Math.max(1, Math.min(6, availableParallelism() - 2)),
  hashMB: 128,
  timeoutMs: 120_000,
};
/** Game review searches every position of a game while the user waits, so it is shallower. */
export const GAME_REVIEW_DEPTH = 16;
export const MAX_REVIEW_MOVES = 600;
/**
 * Opening theory, approximated by what strong Lichess players actually play: a move is book while
 * it is among the first half-moves and at least this common in these rating groups.
 */
export const BOOK = { maxPlies: 30, ratings: [2000, 2200, 2500], minShare: 0.05, minGames: 100 };
/** Lichess games that weight repertoire lines: a 1400 player's range, at the slower speeds. */
export const DEFAULT_RATINGS = [1200, 1400];
export const FREQUENCY_SPEEDS = ['blitz', 'rapid', 'classical'];
/** The explorer rejects bursts of more than about twenty requests a minute. */
export const FREQUENCY_SPACING_MS = 3500;

/** Comparing a repertoire with the player's games: how many recent games, and how deep into each. */
export const HABITS = { games: 300, pages: 8, plies: 60 };

export const MAX_BODY_CHARS = 32_000;
export const MAX_PGN_CHARS = 2_000_000;
export const MAX_HISTORY_MOVES = 2000;
export const MAX_CONVERSATIONS = 10;
