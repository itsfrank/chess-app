import { Chess } from 'chess.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerEvent, Totals } from '../shared/protocol.ts';
import { eventLine, type ChatService } from './chat.ts';
import { errorMessage, HttpError, readJson, sendJson } from './http.ts';
import { explore } from './lichess.ts';
import type { MaiaOpponent } from './opponent.ts';
import { isAllowedOrigin } from './origin.ts';
import type { Replay } from './recording.ts';
import { parseChatRequest } from './snapshot.ts';
import { analyze } from './stockfish.ts';

export type AppOptions = {
  lifetime: Totals;
  /** Live chat; absent when serving a recording. */
  chat?: ChatService;
  /** When set, chat turns are answered from this recording and nothing else runs. */
  replay?: Replay;
  opponent?: MaiaOpponent;
};

const statusOf = (error: unknown, fallback: number) =>
  error instanceof HttpError ? error.status : fallback;

/** The local HTTP API: usage totals, position analysis, opponent moves, and the streaming chat endpoint. */
export function createApp({ lifetime, chat, replay, opponent }: AppOptions): Server {
  const usage = (res: ServerResponse) =>
    sendJson(res, 200, { lifetime: replay?.initialLifetime ?? lifetime });

  /** Answers with JSON from `respond`, whose signal aborts if the client goes away. */
  const json = async (res: ServerResponse, respond: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      sendJson(res, 200, await respond(controller.signal));
    } catch (error) {
      sendJson(res, statusOf(error, 502), { message: errorMessage(error) });
    } finally {
      res.off('close', onClose);
    }
  };

  const opponentMove = (req: IncomingMessage, res: ServerResponse) => {
    if (!opponent) {
      return sendJson(res, 409, { message: 'Opponent play is unavailable during offline replay.' });
    }
    return json(res, async signal => opponent.move(await readJson(req), signal));
  };

  /** Engine lines or explorer statistics for the position shown in the analysis panel. */
  const position =
    (lookup: (fen: string, signal: AbortSignal) => Promise<unknown>) =>
    (req: IncomingMessage, res: ServerResponse) =>
      json(res, async signal => lookup(parseFen(await readJson(req)), signal));
  const analysis = position((fen, signal) => analyze(fen, [], signal));
  const explorer = position((fen, signal) => explore(fen, {}, signal));

  const chatTurn = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const request = parseChatRequest(await readJson(req));
      if (replay) {
        const events = replay.next(request);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Chess-Replay': 'true' });
        res.end(events.map(eventLine).join(''));
      } else if (chat) {
        await chat.handle(request, res);
      } else {
        throw new HttpError(503, 'Chat is unavailable');
      }
    } catch (error) {
      // Only reached before the stream starts; mid-stream failures are sent as events.
      sendError(res, statusOf(error, 400), errorMessage(error));
    }
  };

  return createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    if (!isAllowedOrigin(req.headers.origin)) {
      sendError(res, 403, 'Request origin is not allowed. Open the app from its local address.');
    } else if (route === 'GET /api/usage') usage(res);
    else if (route === 'POST /api/analysis') void analysis(req, res);
    else if (route === 'POST /api/explorer') void explorer(req, res);
    else if (route === 'POST /api/opponent') void opponentMove(req, res);
    else if (route === 'POST /api/chat') void chatTurn(req, res);
    else res.writeHead(404).end();
  });
}

function sendError(res: ServerResponse, status: number, message: string) {
  if (res.destroyed || res.headersSent) return;
  const event: ServerEvent = { type: 'error', message };
  res.writeHead(status, { 'Content-Type': 'application/x-ndjson' }).end(eventLine(event));
}

function parseFen(body: unknown): string {
  const fen = (body as { fen?: unknown } | null)?.fen;
  try {
    if (typeof fen === 'string') return new Chess(fen).fen();
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'Invalid position');
}
