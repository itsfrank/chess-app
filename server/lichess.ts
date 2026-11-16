import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import type { ExplorerResult } from '../shared/protocol.ts';
import { LICHESS_TOKEN_FILE } from './config.ts';

export const ratings = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
export const speeds = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

const ENDPOINT = 'https://explorer.lichess.org/lichess';
const TOP_MOVES = 12;
const REQUEST_SPACING_MS = 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const RATE_LIMIT_PAUSE_MS = 60_000;
const CACHE_TTL_MS = 3_600_000;
const CACHE_ENTRIES = 200;
const RATE_LIMITED = 'Lichess rate limit: wait at least one minute before trying again';

type Counts = { white: number; draws: number; black: number };
type ExplorerMove = Counts & { uci: string; san: string; averageRating?: number };
type ExplorerData = Counts & { opening?: { eco: string; name: string }; moves: ExplorerMove[] };
export type ExplorerOptions = { moves?: string[]; ratings?: number[]; speeds?: string[] };
const games = (row: Counts) => row.white + row.draws + row.black;
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** Frequencies use every game at the position as the denominator, not just the returned moves. */
export function summarize(data: ExplorerData) {
  for (const row of [data, ...data.moves]) {
    if (![row.white, row.draws, row.black].every(isCount))
      throw new Error('Invalid Lichess counts');
  }
  const totalGames = games(data);
  const listedGames = data.moves.reduce((sum, move) => sum + games(move), 0);
  return {
    totalGames,
    opening: data.opening ?? null,
    moves: data.moves.map(move => ({
      uci: move.uci,
      san: move.san,
      games: games(move),
      frequency: totalGames ? games(move) / totalGames : null,
      whiteWins: move.white,
      draws: move.draws,
      blackWins: move.black,
      averageRating: move.averageRating ?? null,
    })),
    otherGames: Math.max(0, totalGames - listedGames),
    note: `Frequencies are empirical proportions in the selected rated Lichess sample, not predictions for a specific opponent. Missing moves may be unrecorded or outside the returned top ${TOP_MOVES}. Small samples are unreliable. Results are not engine evaluations.`,
  };
}

function lichessToken() {
  if (process.env.LICHESS_TOKEN) return process.env.LICHESS_TOKEN.trim();
  try {
    return readFileSync(LICHESS_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}

/** Sorted, de-duplicated filter values, or an error if any is unknown. */
function selectFilters<T>(chosen: T[] | undefined, allowed: T[], compare?: (a: T, b: T) => number) {
  const selected = [...new Set(chosen ?? allowed)].sort(compare);
  if (!selected.length || selected.some(value => !allowed.includes(value))) {
    throw new Error('Invalid Lichess filters');
  }
  return selected;
}

const cache = new Map<string, { until: number; value: ExplorerResult }>();
let queue: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
let blockedUntil = 0;

/** Runs tasks one at a time, in call order, regardless of earlier failures. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Looks up move frequencies for `fen` (after optional hypothetical moves) in
 * the Lichess opening explorer. Requests are serialized, spaced, and cached.
 */
export async function explore(fen: string, options: ExplorerOptions, signal?: AbortSignal) {
  const board = new Chess(fen);
  for (const move of options.moves ?? []) board.move(move);
  const selectedRatings = selectFilters(options.ratings, ratings, (a, b) => a - b);
  const selectedSpeeds = selectFilters(options.speeds, speeds);
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    variant: 'standard',
    fen: board.fen(),
    ratings: selectedRatings.join(','),
    speeds: selectedSpeeds.join(','),
    moves: String(TOP_MOVES),
    topGames: '0',
    recentGames: '0',
  }).toString();
  const key = url.toString();

  return serialized(async (): Promise<ExplorerResult> => {
    signal?.throwIfAborted();
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    if (Date.now() < blockedUntil) throw new Error(RATE_LIMITED);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextRequestAt - Date.now())));
    signal?.throwIfAborted();
    nextRequestAt = Date.now() + REQUEST_SPACING_MS;

    const token = lichessToken();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'chess-companion-local/0.1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 429) {
      const retryAfterMs = (Number(response.headers.get('retry-after')) || 0) * 1000;
      blockedUntil = Date.now() + Math.max(RATE_LIMIT_PAUSE_MS, retryAfterMs);
      throw new Error(RATE_LIMITED);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Lichess explorer requires a valid personal access token. Configure LICHESS_TOKEN on the backend; never paste it into chat.',
      );
    }
    if (!response.ok) throw new Error(`Lichess explorer unavailable (HTTP ${response.status})`);
    const data = (await response.json()) as ExplorerData;
    if (!Array.isArray(data.moves)) throw new Error('Invalid Lichess explorer response');

    const result: ExplorerResult = {
      source: 'Lichess rated games',
      url: key,
      fen: board.fen(),
      filters: { ratings: selectedRatings, speeds: selectedSpeeds },
      fetchedAt: new Date().toISOString(),
      ...summarize(data),
    };
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + CACHE_TTL_MS, value: result });
    return result;
  });
}
