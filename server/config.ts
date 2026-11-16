import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Git-ignored local state: usage totals, recordings, tokens and the Maia3 install. */
export const DATA_DIR = fileURLToPath(new URL('../.data', import.meta.url));
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const USAGE_FILE = join(DATA_DIR, 'usage.json');
export const LICHESS_TOKEN_FILE = join(DATA_DIR, 'lichess-token');
export const MAIA_DIR = join(DATA_DIR, 'maia3-spike');

export const PORT = Number(process.env.PORT || 3001);

/** The only model the companion uses; there is deliberately no fallback. */
export const MODEL = { provider: 'openai-codex', id: 'gpt-6-luna' } as const;
export const MODEL_NAME = `${MODEL.provider}/${MODEL.id}`;

export const ENGINE = {
  path: process.env.STOCKFISH_PATH || 'stockfish',
  movetime: 1500,
  multiPV: 3,
  threads: 1,
  hashMB: 32,
};
export const ENGINE_TIMEOUT_MS = 10_000;

export const MAX_BODY_CHARS = 32_000;
export const MAX_HISTORY_MOVES = 2000;
export const MAX_CONVERSATIONS = 10;
