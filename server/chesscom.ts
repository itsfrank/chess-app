import { Chess } from 'chess.js';
import { parsePgnClocks } from '../shared/clock.ts';
import type { ArchivedGame, GameArchivePage, GameResult } from '../shared/protocol.ts';
import { HttpError } from './http.ts';

const API = 'https://api.chess.com/pub/player';
const PAGE_SIZE = 50;
/** Monthly archives read for one page before giving up on filling it. */
const MAX_ARCHIVES_PER_PAGE = 6;
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 120_000;
const CACHE_ENTRIES = 24;
const DAY_S = 86_400;

type Side = { username?: string; rating?: number };
type RawGame = {
  url?: string;
  pgn?: string;
  rules?: string;
  end_time?: number;
  time_class?: string;
  time_control?: string;
  white?: Side;
  black?: Side;
};

const cache = new Map<string, { until: number; value: unknown }>();
/** chess.com rejects parallel requests, so they run one at a time. */
let queue: Promise<unknown> = Promise.resolve();

function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const run = queue.then(async () => {
    signal?.throwIfAborted();
    const cached = cache.get(url);
    if (cached && cached.until > Date.now()) return cached.value as T;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', 'User-Agent': 'chess-companion-local/0.1' },
    });
    if (response.status === 404) throw new HttpError(404, 'No chess.com player has that username');
    if (response.status === 429)
      throw new HttpError(502, 'chess.com rate limit: wait a moment and try again');
    if (!response.ok) throw new HttpError(502, `chess.com unavailable (HTTP ${response.status})`);
    const value = (await response.json()) as T;
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(url, { until: Date.now() + CACHE_TTL_MS, value });
    return value;
  });
  queue = run.catch(() => {});
  return run;
}

/** Start of an archive's month in Unix seconds, from its `…/games/YYYY/MM` URL. */
function monthStart(archive: string): number {
  const [, year, month] = archive.match(/\/(\d{4})\/(\d{2})$/) ?? [];
  return Date.UTC(Number(year), Number(month) - 1, 1) / 1000;
}

/** "Sicilian Defense Open" from the opening URL chess.com puts in the PGN, without its move list. */
export function openingName(url: string | undefined): string | null {
  const slug = url?.match(/\/openings\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  return slug
    .replace(/-/g, ' ')
    .replace(/[ .]+\d+\..*$/, '')
    .slice(0, 120);
}

/** The game in our own terms, or null for anything that is not standard chess from the start. */
export function parseGame(raw: RawGame, username: string): ArchivedGame | null {
  if (raw.rules !== 'chess' || !raw.pgn || !raw.url || !raw.end_time) return null;
  const board = new Chess();
  try {
    board.loadPgn(raw.pgn);
  } catch {
    return null;
  }
  const headers = board.getHeaders();
  const result = headers.Result as GameResult;
  const moves = board.history();
  if (headers.FEN || !moves.length || !['1-0', '0-1', '1/2-1/2'].includes(result)) return null;
  const clocks = parsePgnClocks(raw.pgn, moves.length);
  const player = (side: Side | undefined) => ({
    name: side?.username ?? '?',
    rating: Number.isFinite(side?.rating) ? side!.rating! : null,
  });
  return {
    url: raw.url,
    playedAt: new Date(raw.end_time * 1000).toISOString(),
    white: player(raw.white),
    black: player(raw.black),
    playerColor: raw.black?.username?.toLowerCase() === username ? 'black' : 'white',
    result,
    termination: (headers.Termination ?? '').slice(0, 120),
    timeClass: raw.time_class ?? '',
    timeControl: raw.time_control ?? '',
    opening: openingName(headers.ECOUrl),
    moves,
    ...(clocks && { clocks }),
  };
}

/**
 * A page of a player's most recent standard games from chess.com's public
 * archive, ending before the Unix time `before` when it is given.
 */
export async function listGames(
  name: string,
  before?: number,
  signal?: AbortSignal,
): Promise<GameArchivePage> {
  const username = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,50}$/.test(username)) throw new HttpError(400, 'Enter a chess.com username');
  if (before !== undefined && !(Number.isSafeInteger(before) && before > 0))
    throw new HttpError(400, 'Invalid page');

  const { archives = [] } = await getJson<{ archives?: string[] }>(
    `${API}/${username}/games/archives`,
    signal,
  );
  // Months are bucketed in chess.com's time zone, so allow a day either side of the boundary.
  const months = archives
    .filter(archive => before === undefined || monthStart(archive) - DAY_S < before)
    .reverse();

  const found: RawGame[] = [];
  let read = 0;
  while (read < months.length && read < MAX_ARCHIVES_PER_PAGE && found.length < PAGE_SIZE) {
    const { games = [] } = await getJson<{ games?: RawGame[] }>(months[read++], signal);
    found.push(
      ...games.filter(game => game.end_time && (before === undefined || game.end_time < before)),
    );
  }
  found.sort((a, b) => b.end_time! - a.end_time!);
  const page = found.slice(0, PAGE_SIZE);
  const more = found.length > PAGE_SIZE || read < months.length;
  const older = more ? (page.at(-1)?.end_time ?? monthStart(months[read - 1]) - DAY_S) : null;

  const games = page.flatMap(raw => parseGame(raw, username) ?? []);
  const shown = games[0]?.[games[0].playerColor].name;
  return { username: shown?.toLowerCase() === username ? shown : username, games, older };
}
