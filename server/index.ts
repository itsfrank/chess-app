import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Chess, type Square } from 'chess.js';
import { Type } from '@sinclair/typebox';
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, ModelRuntime, defineTool, type ResourceLoader, type AgentSession } from '@earendil-works/pi-coding-agent';
import { analyze } from './stockfish.ts';
import { opponent } from './opponent.ts';
import { explore, ratings, speeds } from './lichess.ts';
import { isAllowedOrigin } from './origin.ts';
import { emptyTotals, loadTotals, saveTotals, type Totals } from './usage.ts';
import { Recorder, Replay } from './recording.ts';
import { annotationErrors, repairAnnotations } from './annotation-feedback.ts';
import type { Annotation } from '../src/annotations.ts';
import { annotationPalette as palette, annotationColorNames, maxAnnotations } from '../src/annotation-palette.ts';
const replay = process.env.REPLAY_LOG ? new Replay(process.env.REPLAY_LOG) : undefined;
const lifetime = loadTotals();
const modelRuntime = replay ? undefined : await ModelRuntime.create();
const model = modelRuntime?.getModel('openai-codex', 'gpt-6-luna');
if (!replay && !model) throw new Error('Pi model openai-codex/gpt-6-luna is unavailable; no fallback configured.');

const instruction = `You are a concise chess companion. The user's message includes an immutable board snapshot. Respond to user questions and automatic move-review requests. Use analyze_position before making engine-evaluation or best-move claims; never invent engine results. The snapshot's playerColor is the user's chosen playing side, not the side to move. In analysis mode it follows board orientation. Address the user from that side's perspective. Automatic reviews may describe either player's latest move; use the history to identify who played it. Scores are from White's perspective. You cannot move the user's pieces. Use set_arrows to illustrate ideas, then link text using [**d4**](#annotation-ID), replacing ID with the actual arrow ID. Use at most ${maxAnnotations} arrows, and only as many as help explain the position. Use distinct available colors for simultaneous ideas. Every arrow you draw must have at least one corresponding explicit move link in your response; link all referenced moves, not just one. Use standard Markdown. For tables, put each row on its own line and include a valid header separator row; never flatten a table into one paragraph. Tools always default to the submitted position. Hypothetical moves use SAN or UCI notation. Arrows need not be legal moves (they can illustrate threats), but must refer to the submitted board. A link labeled with a move MUST point to an arrow with that move's exact source and destination squares in the snapshot (for example Black Nf6 from the initial setup is g8 to f6, never d4 to e5). Link space-control or threat arrows using descriptive prose, not an unrelated move label. Draw a separate matching arrow when linking a recommended move. Use lichess_moves when asked about move likelihood/popularity or practical opponent replies. It reports observed frequencies in filtered rated Lichess games, not engine strength or a prediction for this opponent. Always mention sample size and filters when quoting frequencies, and warn on small or empty samples. Do not call it routinely unless relevant. Keep explanations short.`;
const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => instruction, getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
};
type Conversation = { recorder: Recorder; usage: Totals; session?: AgentSession; busy: boolean; fen: string; emit: (event: object) => void; touched: number; arrows?: Annotation[] };
const conversations = new Map<string, Conversation>();
const square = Type.String({ pattern: '^[a-h][1-8]$' });
const server = createServer(async (req, res) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({ type: 'error', message: 'Request origin is not allowed. Open http://127.0.0.1:5173/.' }) + '\n');
    return;
  }
  if (req.url === '/api/usage' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ lifetime: replay?.initialLifetime ?? lifetime })); return; }
  if (req.url === '/api/opponent' && req.method === 'POST') {
    if (replay) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Opponent play is unavailable during offline replay.' })); return; }
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on('close', disconnect);
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 32000) throw new Error('Request too large'); }
      const result = await opponent.move(JSON.parse(raw), controller.signal);
      if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error instanceof Error ? error.message : 'Opponent request failed' }));
    } finally { res.off('close', disconnect); }
    return;
  }
  if (req.url !== '/api/chat' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  let conversation: Conversation | undefined;
  let claimed = false;
  let disconnected = false;
  let recording: Recorder | undefined;
  try {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 32000) throw new Error('Message too large'); }
    const body = JSON.parse(raw);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000) throw new Error('Enter a message (maximum 8000 characters)');
    if (!Array.isArray(body.moves) || body.moves.length > 2000 || !body.moves.every((m: unknown) => typeof m === 'string')) throw new Error('Invalid move history');
    const playerColor = body.playerColor ?? 'white';
    if (playerColor !== 'white' && playerColor !== 'black') throw new Error('Invalid player color');
    const board = new Chess(); for (const move of body.moves) board.move(move);
    if (board.fen() !== body.fen) throw new Error('Position does not match move history');
    if (replay) {
      const events = replay.next({ message: body.message, fen: body.fen, moves: body.moves, playerColor });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Chess-Replay': 'true' });
      for (const event of events) res.write(JSON.stringify(event) + '\n');
      return;
    }
    const id = typeof body.conversationId === 'string' ? body.conversationId : randomUUID();
    for (const [key, value] of conversations) if (!value.busy && Date.now() - value.touched > 3600000) { value.session?.dispose(); conversations.delete(key); }
    conversation = conversations.get(id);
    if (!conversation) {
      if (conversations.size >= 10) throw new Error('Too many conversations; restart the backend');
      conversation = { recorder: new Recorder('.data/sessions', { conversationId: id, model: 'openai-codex/gpt-6-luna', systemPrompt: instruction, lifetime: { ...lifetime }, engine: { path: process.env.STOCKFISH_PATH || 'stockfish', movetime: 1500, multiPV: 3, threads: 1, hashMB: 32 } }), usage: emptyTotals(), busy: false, fen: body.fen, emit: () => {}, touched: Date.now() }; conversations.set(id, conversation);
      console.log(`Session recording: ${conversation.recorder.path}`);
    }
    if (conversation.busy) { res.writeHead(409).end('Conversation is busy'); return; }
    recording = conversation.recorder;
    recording.record('request', { message: body.message, fen: body.fen, moves: body.moves, playerColor });
    conversation.busy = true; claimed = true;
    conversation.fen = body.fen;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    conversation.emit = event => { recording!.record('client', event); if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
    const current = conversation;
    const disconnect = () => { disconnected = true; recording!.record('disconnect', {}); void current.session?.abort(); };
    res.on('close', disconnect);
    try {
      current.emit({ type: 'conversation', id });
      if (!current.session) {
        const { session } = await createAgentSession({ modelRuntime, model, resourceLoader: resources, tools: ['analyze_position', 'set_arrows', 'lichess_moves'], settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(), customTools: [
          defineTool({ name: 'analyze_position', label: 'Stockfish', description: 'Evaluate the submitted position and return the top 3 engine moves, White-perspective scores and continuations. Optionally apply hypothetical moves.', parameters: Type.Object({ moves: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })) }),
            execute: async (_id, args, signal) => { const result = await analyze(current.fen, args.moves, signal, (direction, line) => current.recorder.record('uci', { direction, line })); current.emit({ type: 'analysis', result }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }; } }),
          defineTool({ name: 'lichess_moves', label: 'Lichess move frequencies', description: 'Look up empirical move frequencies and game outcomes in rated Lichess games at the submitted position, optionally after hypothetical moves. Defaults to all rating buckets and speeds. Returned frequency is a fraction of ALL games at this position, not just the displayed moves.', parameters: Type.Object({ moves: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), ratings: Type.Optional(Type.Array(Type.Integer({ enum: ratings }), { minItems: 1, maxItems: 9 })), speeds: Type.Optional(Type.Array(Type.String({ enum: speeds }), { minItems: 1, maxItems: 6 })) }),
            execute: async (_id, args, signal) => { const result = await explore(current.fen, args, signal); current.emit({ type: 'explorer', result }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }; } }),
          defineTool({ name: 'set_arrows', label: 'Draw arrows', description: 'Replace arrows on the submitted board. Link chat text with #annotation-ID.', parameters: Type.Object({ arrows: Type.Array(Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,40}$' }), from: square, to: square, color: Type.Union(annotationColorNames.map(color => Type.Literal(color))) }), { maxItems: maxAnnotations }) }),
            execute: async (_id, args) => { if (args.arrows.some(a => a.from === a.to) || new Set(args.arrows.map(a => a.id)).size !== args.arrows.length) throw new Error('Arrows require distinct endpoints and unique IDs'); const arrows = args.arrows.map(a => ({ ...a, from: a.from as Square, to: a.to as Square, color: palette[a.color] })); current.arrows = arrows; current.emit({ type: 'arrows', arrows }); return { content: [{ type: 'text', text: JSON.stringify(arrows) }], details: {} }; } }),
        ] });
        current.session = session;
        session.setActiveToolsByName(['analyze_position', 'set_arrows', 'lichess_moves']);
        const names = session.getActiveToolNames();
        if (names.length !== 3 || names.some(name => !['analyze_position', 'set_arrows', 'lichess_moves'].includes(name))) { session.dispose(); current.session = undefined; throw new Error('Unexpected tool configuration'); }
      }
      if (res.destroyed) return;
      let modelError: string | undefined;
      current.arrows = [];
      let responseText = '';
      const unsubscribe = current.session.subscribe(event => {
        // Record finalized model messages, tools, retries and lifecycle; text deltas are recorded as client events.
        if (event.type !== 'message_update') current.recorder.record('agent', event);
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const usage = event.message.usage;
          if (usage) {
            const tokens = Number.isFinite(usage.totalTokens) ? Math.max(0, usage.totalTokens) : 0;
            const cost = Number.isFinite(usage.cost.total) ? Math.max(0, usage.cost.total) : 0;
            current.usage.tokens += tokens; current.usage.cost += cost;
            lifetime.tokens += tokens; lifetime.cost += cost;
            try { saveTotals(lifetime); } catch { current.emit({ type: 'status', text: 'Warning: lifetime usage could not be saved.' }); }
            current.emit({ type: 'usage', session: current.usage, lifetime });
          }
        }
        if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') modelError = event.message.errorMessage || 'Model request failed';
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          responseText += event.assistantMessageEvent.delta;
          current.emit({ type: 'text', delta: event.assistantMessageEvent.delta });
        }
        if (event.type === 'tool_execution_start') current.emit({ type: 'status', text: event.toolName === 'analyze_position' ? 'Checking Stockfish…' : event.toolName === 'lichess_moves' ? 'Checking Lichess move frequencies…' : 'Drawing arrows…' });
      });
      try {
        await current.session.prompt(`Board snapshot: ${JSON.stringify({ fen: body.fen, moves: body.moves, playerColor })}\n\nUser: ${body.message}`);
        if (modelError) throw new Error(modelError);
        const remaining = await repairAnnotations({
          errors: () => annotationErrors(body.fen, current.session!.getLastAssistantText() ?? responseText, current.arrows ?? []),
          cancelled: () => disconnected || res.destroyed,
          repair: async (feedback, attempt) => {
            current.recorder.record('annotation_feedback', { attempt, feedback });
            current.emit({ type: 'replace_text', text: '' });
            current.emit({ type: 'status', text: 'Correcting annotation mismatch…' });
            responseText = ''; modelError = undefined;
            await current.session!.prompt(feedback);
            if (modelError) throw new Error(modelError);
          },
        });
        if (remaining.length) {
          current.recorder.record('annotation_validation_failed', { errors: remaining });
          current.arrows = [];
          current.emit({ type: 'arrows', arrows: [] });
          current.emit({ type: 'status', text: 'Could not validate annotations; arrows hidden.' });
        }
        current.emit({ type: 'done' });
      } finally { unsubscribe(); }
    } finally { res.off('close', disconnect); }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/x-ndjson' });
    const event = { type: 'error', message };
    recording?.record('client', event);
    if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
  } finally {
    if (claimed) recording?.record('turn_end', { disconnected });
    if (conversation && claimed) { conversation.busy = false; conversation.emit = () => {}; conversation.touched = Date.now(); }
    res.end();
  }
});
const port = Number(process.env.PORT || 3001);
server.listen(port, '127.0.0.1', () => console.log(`Chess API: http://127.0.0.1:${port}${replay ? ' (offline replay)' : ''}`));
const shutdown = () => { opponent.close(); for (const c of conversations.values()) c.session?.dispose(); server.close(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
