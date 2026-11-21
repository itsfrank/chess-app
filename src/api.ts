import type {
  Analysis,
  PositionEval,
  ChatRequest,
  DrillCard,
  DrillInput,
  ExplorerResult,
  GameArchivePage,
  OpponentMove,
  OpponentRequest,
  PlayerProfile,
  RepertoireReport,
  RepertoireSummary,
  ServerEvent,
  Settings,
  SettingsInfo,
  Totals,
} from '../shared/protocol';

/** The server's error message for a failed response, whatever shape the body has. */
async function failure(response: Response): Promise<Error> {
  const body = (await response.text()).trim();
  try {
    return new Error(JSON.parse(body).message || body);
  } catch {
    return new Error(body || `Request failed (HTTP ${response.status}).`);
  }
}

const postJson = (url: string, body: unknown, signal: AbortSignal) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

/** The app's settings and the models the companion can be set to. */
export async function fetchSettings(): Promise<SettingsInfo> {
  const response = await fetch('/api/settings');
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** Changes the given settings and answers with all of them. */
export async function saveSettings(changes: Partial<Settings>): Promise<SettingsInfo> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function fetchLifetimeUsage(signal: AbortSignal): Promise<Totals> {
  const response = await fetch('/api/usage', { signal });
  if (!response.ok) throw await failure(response);
  return (await response.json()).lifetime;
}

async function postForJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await postJson(url, body, signal);
  if (!response.ok) throw await failure(response);
  return response.json();
}

export const requestOpponentMove = (request: OpponentRequest, signal: AbortSignal) =>
  postForJson<OpponentMove>('/api/opponent', request, signal);

/** Stockfish's top lines for a position. */
export const fetchAnalysis = (fen: string, signal: AbortSignal) =>
  postForJson<Analysis>('/api/analysis', { fen }, signal);

/** Lichess move frequencies for a position, across all ratings and speeds. */
export const fetchExplorer = (fen: string, signal: AbortSignal) =>
  postForJson<ExplorerResult>('/api/explorer', { fen }, signal);

/** A page of a chess.com player's recent games, ending before `before` when given. */
export async function fetchGames(
  username: string,
  before: number | null,
  signal: AbortSignal,
): Promise<GameArchivePage> {
  const query = new URLSearchParams({ username, ...(before && { before: String(before) }) });
  const response = await fetch(`/api/chesscom/games?${query}`, { signal });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** Cross-game player profile built from recent games and cached Stockfish reviews. */
export async function fetchProfile(
  username: string,
  refresh: boolean,
  signal: AbortSignal,
): Promise<PlayerProfile> {
  const query = new URLSearchParams({ username, ...(refresh && { refresh: '1' }) });
  const response = await fetch(`/api/profile?${query}`, { signal });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** Sends a chat turn and yields the server's events as they stream in. */
export async function* streamChat(
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  yield* ndjson<ServerEvent>(await postJson('/api/chat', request, signal));
}

/**
 * One line of a game's review: the engine's verdict on a position, `stale`
 * when it comes from a shallower search than is configured; how many opening
 * half-moves are theory; or, first, the configured depth.
 */
export type ReviewEvent =
  (PositionEval & { ply: number; stale: boolean }) | { book: number } | { depth: number };

/**
 * A game's review as it is worked out: positions in order, book depth as it is
 * found. `refresh` searches again what was stored from a shallower search.
 */
export async function* streamGameReview(
  moves: string[],
  refresh: boolean,
  signal: AbortSignal,
): AsyncGenerator<ReviewEvent> {
  const lines = ndjson<ReviewEvent | { error: string }>(
    await postJson('/api/games/review', { moves, refresh }, signal),
  );
  for await (const line of lines) {
    if ('error' in line) throw new Error(line.error);
    yield line;
  }
}

/** The lines of an NDJSON response as they arrive. */
async function* ndjson<T>(response: Response): AsyncGenerator<T> {
  if (!response.ok) throw await failure(response);
  if (!response.body) throw new Error('Missing response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines) if (line) yield JSON.parse(line);
    if (done) return;
  }
}

async function repertoireRequest<T>(method: string, path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/repertoires${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}
const repertoireAction =
  <B>(action: string) =>
  (id: string, body: B) =>
    repertoireRequest<RepertoireReport>('POST', `/${id}/${action}`, body);

/** Imported opening repertoires and the proposals to simplify them. */
export const repertoires = {
  list: () => repertoireRequest<RepertoireSummary[]>('GET'),
  get: (id: string) => repertoireRequest<RepertoireReport>('GET', `/${id}`),
  import: (pgn: string) => repertoireRequest<RepertoireReport>('POST', '', { pgn }),
  remove: (id: string) => repertoireRequest<unknown>('DELETE', `/${id}`),
  accept: repertoireAction<{ findingId: string }>('accept'),
  revert: repertoireAction<{ changeId: string }>('revert'),
  dismiss: repertoireAction<{ findingId: string; dismissed: boolean }>('dismiss'),
  /** Starts the engine and Lichess passes; `ratings` changes the rating range first. */
  analyze: repertoireAction<{ ratings?: number[] }>('analyze'),
  stop: repertoireAction<object>('stop'),
  /** Fetches the player's chess.com games and compares them with the repertoire. */
  games: repertoireAction<{ username: string }>('games'),
};

async function drillRequest<T>(method: string, path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/drills${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** Spaced-repetition mistake drills built from reviewed games. */
export const drills = {
  list: () => drillRequest<DrillCard[]>('GET'),
  add: (cards: DrillInput[]) =>
    drillRequest<{ added: DrillCard[]; cards: DrillCard[] }>('POST', '', { cards }),
  review: (id: string, solved: boolean) =>
    drillRequest<DrillCard>('POST', `/${id}/review`, { solved }),
  remove: (id: string) => drillRequest<{ removed: boolean }>('DELETE', `/${id}`),
};
