import { Chess } from 'chess.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerEvent, SettingsInfo, Totals } from '../shared/protocol.ts';
import { eventLine, type ChatService } from './chat.ts';
import { listGames } from './chesscom.ts';
import { MAX_PGN_CHARS } from './config.ts';
import { DrillStore } from './drills.ts';
import { parseReviewRequest, type GameReviewService } from './game-review.ts';
import { errorMessage, HttpError, readJson, sendJson } from './http.ts';
import { explore } from './lichess.ts';
import type { MaiaOpponent } from './opponent.ts';
import { isAllowedOrigin } from './origin.ts';
import type { ProfileService } from './profile.ts';
import type { Replay } from './recording.ts';
import type { RepertoireService } from './repertoires.ts';
import { SettingsStore } from './settings.ts';
import { parseChatRequest } from './snapshot.ts';
import { analyze } from './stockfish.ts';

export type AppOptions = {
  lifetime: Totals;
  /** Live chat; absent when serving a recording. */
  chat?: ChatService;
  /** When set, chat turns are answered from this recording and nothing else runs. */
  replay?: Replay;
  opponent?: MaiaOpponent;
  repertoires?: RepertoireService;
  gameReview?: GameReviewService;
  profile?: ProfileService;
  /** Kept in memory only when omitted. */
  drills?: DrillStore;
  /** Kept in memory only when omitted. */
  settings?: SettingsStore;
};

const statusOf = (error: unknown, fallback: number) =>
  error instanceof HttpError ? error.status : fallback;

/** The local HTTP API: usage totals, position analysis, opponent moves, and the streaming chat endpoint. */
export function createApp(options: AppOptions): Server {
  const { lifetime, chat, replay, opponent, repertoires, gameReview, profile } = options;
  const settings = options.settings ?? new SettingsStore();
  const drills = options.drills ?? new DrillStore();
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
  const analysis = position((fen, signal) =>
    analyze(fen, [], signal, undefined, settings.current.analysisSeconds * 1000),
  );

  /** `GET` reads the settings and the models to choose from; `PUT` changes some of them. */
  const appSettings = (req: IncomingMessage, res: ServerResponse) =>
    json(res, async (): Promise<SettingsInfo> => {
      // Without a model listing, as during a replay, any model id is taken on trust.
      const models = (await chat?.models().catch(() => [])) ?? [];
      if (req.method === 'PUT') {
        settings.update(
          await readJson(req),
          models.map(model => model.id),
        );
      }
      return { settings: settings.current, models };
    });
  const explorer = position((fen, signal) => explore(fen, {}, signal));

  /** `/api/chesscom/games?username=…&before=…`: a page of the player's recent games. */
  const games = (req: IncomingMessage, res: ServerResponse) =>
    json(res, signal => {
      const query = new URL(req.url!, 'http://localhost').searchParams;
      const before = query.get('before');
      return listGames(query.get('username') ?? '', before ? Number(before) : undefined, signal);
    });

  /** `/api/profile?username=…&refresh=1`: cross-game patterns from recent games and cached reviews. */
  const playerProfile = (req: IncomingMessage, res: ServerResponse) =>
    json(res, async signal => {
      if (!profile) throw new HttpError(503, 'Player profile is unavailable');
      const query = new URL(req.url!, 'http://localhost').searchParams;
      const username = query.get('username') ?? settings.current.chesscomUsername;
      return profile.get(username, signal, query.get('refresh') === '1');
    });

  /** Streams a game's review as NDJSON: the engine's verdict on each position, and its book depth. */
  const review = async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      if (!gameReview) throw new HttpError(503, 'Game review is unavailable');
      const { moves, refresh } = parseReviewRequest(await readJson(req));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      const line = (value: object) => res.write(JSON.stringify(value) + '\n');
      line({ depth: gameReview.configuredDepth });
      await gameReview.evaluate(
        moves,
        controller.signal,
        (ply, result, stale) => line({ ply, ...result, stale }),
        book => line({ book }),
        refresh,
      );
    } catch (error) {
      if (!res.headersSent) sendJson(res, statusOf(error, 502), { message: errorMessage(error) });
      else if (!controller.signal.aborted)
        res.write(JSON.stringify({ error: errorMessage(error) }) + '\n');
    } finally {
      res.off('close', onClose);
      res.end();
    }
  };

  /** `/api/repertoires`, `/api/repertoires/:id` and `/api/repertoires/:id/:action`. */
  const repertoire = (req: IncomingMessage, res: ServerResponse) =>
    json(res, async () => {
      if (!repertoires) throw new HttpError(503, 'Repertoires are unavailable');
      const [id, action] = req.url!.split('/').slice(3);
      const route = `${req.method} ${id ? (action ?? ':id') : ''}`.trim();
      if (route === 'GET') return repertoires.list();
      if (route === 'POST') return repertoires.import(await readJson(req, MAX_PGN_CHARS));
      if (route === 'GET :id') return repertoires.report(id);
      if (route === 'DELETE :id') return repertoires.remove(id) ?? {};
      if (req.method !== 'POST') throw new HttpError(404, 'Not found');
      const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
      if (action === 'accept') return repertoires.accept(id, body.findingId);
      if (action === 'revert') return repertoires.revert(id, body.changeId);
      if (action === 'dismiss') return repertoires.dismiss(id, body.findingId, body.dismissed);
      if (action === 'analyze') return repertoires.analyze(id, body.ratings);
      if (action === 'games') return repertoires.syncGames(id, body.username);
      if (action === 'stop') return repertoires.stop(id) ?? repertoires.report(id);
      throw new HttpError(404, 'Not found');
    });

  /** `/api/drills`, `/api/drills/:id`, and `/api/drills/:id/review`. */
  const drillRoutes = (req: IncomingMessage, res: ServerResponse) =>
    json(res, async () => {
      const [id, action] = req.url!.split('?')[0].split('/').slice(3);
      const route = `${req.method} ${id ? (action ?? ':id') : ''}`.trim();
      if (route === 'GET') return drills.list();
      if (route === 'POST') return drills.addMany(await readJson(req));
      if (route === 'DELETE :id') return drills.remove(id);
      if (route === 'POST review') return drills.review(id, await readJson(req));
      throw new HttpError(404, 'Not found');
    });

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
    else if (route === 'GET /api/settings' || route === 'PUT /api/settings')
      void appSettings(req, res);
    else if (route === 'POST /api/analysis') void analysis(req, res);
    else if (route === 'POST /api/explorer') void explorer(req, res);
    else if (route === 'POST /api/opponent') void opponentMove(req, res);
    else if (route === 'POST /api/chat') void chatTurn(req, res);
    else if (/^GET \/api\/chesscom\/games(\?|$)/.test(route)) void games(req, res);
    else if (/^GET \/api\/profile(\?|$)/.test(route)) void playerProfile(req, res);
    else if (route === 'POST /api/games/review') void review(req, res);
    else if (/^\/api\/repertoires(\/|$)/.test(req.url ?? '')) void repertoire(req, res);
    else if (/^\/api\/drills(\/|$|\?)/.test(req.url ?? '')) void drillRoutes(req, res);
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
