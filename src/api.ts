import type {
  Analysis,
  ChatRequest,
  ExplorerResult,
  OpponentMove,
  OpponentRequest,
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
