import type {
  Analysis,
  ChatRequest,
  ExplorerResult,
  OpponentMove,
  OpponentRequest,
  RepertoireReport,
  RepertoireSummary,
  ServerEvent,
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

/** Sends a chat turn and yields the server's events as they stream in. */
export async function* streamChat(
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const response = await postJson('/api/chat', request, signal);
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
};
