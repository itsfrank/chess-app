import { availableParallelism, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Git-ignored local state: usage totals, recordings, tokens and the Maia3 install. */
export const DATA_DIR = fileURLToPath(new URL('../.data', import.meta.url));
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const USAGE_FILE = join(DATA_DIR, 'usage.json');
export const LICHESS_TOKEN_FILE = join(DATA_DIR, 'lichess-token');
export const MAIA_DIR = join(DATA_DIR, 'maia3-spike');
export const REPERTOIRES_DIR = join(DATA_DIR, 'repertoires');
export const EVAL_CACHE_FILE = join(DATA_DIR, 'eval-cache.json');
export const BOOK_CACHE_FILE = join(DATA_DIR, 'book-cache.json');
export const GAME_EVAL_CACHE_FILE = join(DATA_DIR, 'game-eval-cache.json');
export const FREQUENCY_CACHE_FILE = join(DATA_DIR, 'frequency-cache.json');
export const DRILLS_FILE = join(DATA_DIR, 'drills.json');

export const PORT = Number(process.env.PORT || 3001);

/**
 * The provider of the companion's model unless the setting names another as
 * "provider/model"; which model and effort is a setting, with no fallback.
 */
export const MODEL_PROVIDER = 'openai-codex';
/**
 * Claude models through the user's Claude Code login, when the pi-claude-bridge
 * extension is installed in Pi. It runs Claude Code with its own tools switched
 * off, so the companion's three tools remain the only ones.
 */
export const CLAUDE_BRIDGE = {
  provider: 'claude-bridge',
  dir: join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-claude-bridge'),
  /** The provider whose catalogue prices estimate what a bridged turn would cost. */
  pricedAs: 'anthropic',
};

/**
 * Claude Code on a subscription writes its prompt cache for an hour unless told otherwise, at
 * twice the input price where the five-minute cache costs 1.25 times. The calls of one turn come
 * seconds apart and grading calls are never repeated, so the hour is paid for and not used:
 * default to five minutes. Set CLAUDE_CODE_PROMPT_CACHE_TTL=1h to keep the hour.
 */
process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= '5m';
/** Whether bridged turns write the hour-long cache, which `bridgedCost` prices differently. */
export const HOUR_CACHE = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL === '1h';

/** The provider and model id of a model setting; a bare id belongs to the default provider. */
export function splitModel(model: string): { provider: string; id: string } {
  const slash = model.indexOf('/');
  return slash < 0
    ? { provider: MODEL_PROVIDER, id: model }
    : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** Analysis of the position on the board; how long it thinks is a setting. */
export const ENGINE = {
  path: process.env.STOCKFISH_PATH || 'stockfish',
  multiPV: 3,
  threads: 1,
  hashMB: 32,
};
/** Allowed on top of the thinking time before a search counts as hung. */
export const ENGINE_GRACE_MS = 8500;

/**
 * Repertoire analysis and game review: every position is searched once to a
 * fixed depth, which is a setting, so scores are comparable.
 */
const batchWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
export const BATCH_ENGINE = {
  workers: batchWorkers,
  threads: Math.max(1, Math.floor(Math.max(1, availableParallelism() - 2) / batchWorkers)),
  hashMB: 64,
  timeoutMs: 120_000,
};
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

/** Whether live replies are checked against the board; opt-in via `CHESS_CLAIM_CHECK=1`. */
export const CLAIM_CHECK = process.env.CHESS_CLAIM_CHECK === '1';
