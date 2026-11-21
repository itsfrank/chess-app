import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Chess } from 'chess.js';
import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { ChatRequest, Effort, ServerEvent, Totals } from '../shared/protocol.ts';
import { numberedMove } from '../shared/quality.ts';
import { annotationErrors, repairAnnotations } from './annotation-feedback.ts';
import { ClaimCheck, claimFeedback } from './claim-check.ts';
import {
  CLAIM_CHECK,
  CLAUDE_BRIDGE,
  ENGINE,
  HOUR_CACHE,
  MAX_CONVERSATIONS,
  MODEL_PROVIDER,
  SESSIONS_DIR,
  splitModel,
} from './config.ts';
import { ConversationStore } from './conversations.ts';
import { describeLine, describePosition } from './facts.ts';
import { errorMessage, HttpError } from './http.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { Recorder } from './recording.ts';
import type { SettingsStore } from './settings.ts';
import { createTools, toolStatus, type ToolContext } from './tools.ts';
import { emptyTotals, saveTotals } from './usage.ts';

type Conversation = ToolContext & {
  id: string;
  /** Fixed when the conversation starts; later changes to the settings apply to new ones. */
  model: { provider: string; id: string; effort: Effort };
  recorder: Recorder;
  usage: Totals;
  session?: AgentSession;
  /** Set while a turn is running; `finished` resolves when it ends. */
  turn?: { aborting: boolean; finished: Promise<void> };
  touched: number;
};

/** Replies shorter than this, in words, after arrows were drawn are checked for a missing answer. */
export const SHORT_REPLY_WORDS = 50;

/** Whether a turn's visible reply may be only a caption for its arrows. */
export const needsFullAnswer = (reply: string, drewArrows: boolean) =>
  drewArrows && reply.trim().split(/\s+/).filter(Boolean).length < SHORT_REPLY_WORDS;

/** Asks for a complete replacement when the visible reply may be only a caption; "OK" means keep it. */
export const fullAnswerRequest = (reply: string) =>
  `The user sees only your reply text, not your reasoning or tool calls. So far they have seen only this:\n\n${reply.trim() || '(nothing)'}\n\nIf that already answers their question in full, reply with exactly: OK. Otherwise write the complete replacement answer now (including any arrow links you want to keep), not an addendum. Do not call any tools.`;

/** Gives an agent `systemPrompt` and nothing else: no extensions, skills or context files. */
export const promptOnly = (systemPrompt: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});

/** The position before the last of `moves`, which are known to be legal. */
function previousFen(moves: string[]): string | undefined {
  if (!moves.length) return undefined;
  const board = new Chess();
  for (const san of moves.slice(0, -1)) board.move(san);
  return board.fen();
}

/**
 * A session that loads only the Claude bridge extension, which registers the
 * Claude provider on `modelRuntime`; the model is chosen afterwards. Everything
 * else of the user's Pi setup stays out, as elsewhere.
 */
export async function createBridgeSession(
  modelRuntime: ModelRuntime,
  systemPrompt: string,
  names: string[] = [],
  tools: ReturnType<typeof createTools> = [],
): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    // The bridge lives under Pi's agent directory: …/agent/npm/node_modules/pi-claude-bridge.
    agentDir: dirname(dirname(dirname(CLAUDE_BRIDGE.dir))),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [CLAUDE_BRIDGE.dir],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    modelRuntime,
    resourceLoader,
    tools: names,
    customTools: tools,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

/**
 * What a turn through the bridge would cost at the model's list price. The
 * bridge reports none, because the turn runs on a Claude subscription. The
 * catalogue's cache-write price is the five-minute cache's; the hour-long one
 * costs twice the input price.
 */
export function bridgedCost(
  modelRuntime: ModelRuntime,
  model: { provider: string; id: string },
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  if (model.provider !== CLAUDE_BRIDGE.provider) return 0;
  const price = modelRuntime.getModel(CLAUDE_BRIDGE.pricedAs, model.id)?.cost;
  if (!price) return 0;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * (HOUR_CACHE ? 2 * price.input : price.cacheWrite)) /
    1_000_000
  );
}

const NDJSON = { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' };
export const eventLine = (event: ServerEvent) => JSON.stringify(event) + '\n';

/** Live chat: one agent session per conversation, one turn at a time, every turn recorded. */
export class ChatService {
  private readonly modelRuntime: ModelRuntime;
  private readonly settings: SettingsStore;
  /** Shared with the usage endpoint and mutated as turns report usage. */
  private readonly lifetime: Totals;
  private readonly reviewGame?: (moves: string[]) => unknown;
  private readonly conversations = new ConversationStore<Conversation>({
    max: MAX_CONVERSATIONS,
    isBusy: conversation => !!conversation.turn,
    dispose: conversation => conversation.session?.dispose(),
  });

  constructor(options: {
    modelRuntime: ModelRuntime;
    settings: SettingsStore;
    lifetime: Totals;
    /** The engine's review of a finished game, once it is complete. */
    reviewGame?: (moves: string[]) => unknown;
  }) {
    this.reviewGame = options.reviewGame;
    this.modelRuntime = options.modelRuntime;
    this.settings = options.settings;
    this.lifetime = options.lifetime;
  }

  /** Runs one turn, streaming events to `res`. Throws only before the stream starts. */
  async handle(request: ChatRequest, res: ServerResponse) {
    const conversation = await this.claim(request);
    const { recorder } = conversation;
    const turn = conversation.turn!;
    let finish!: () => void;
    turn.finished = new Promise(resolve => (finish = resolve));
    let disconnected = false;
    const onClose = () => {
      disconnected = true;
      turn.aborting = true;
      recorder.record('disconnect', {});
      void conversation.session?.abort();
    };

    const { message, fen, moves, playerColor, game } = request;
    recorder.record('request', { message, fen, moves, playerColor, ...(game && { game }) });
    conversation.fen = fen;
    conversation.movetimeMs = this.settings.current.analysisSeconds * 1000;
    conversation.previousFen = previousFen(moves);
    conversation.arrows = [];
    conversation.emit = event => {
      recorder.record('client', event);
      if (!res.destroyed) res.write(eventLine(event));
    };
    res.on('close', onClose);
    res.writeHead(200, NDJSON);
    try {
      conversation.emit({ type: 'conversation', id: conversation.id });
      conversation.session ??= await this.createSession(conversation);
      if (!res.destroyed)
        await this.runTurn(conversation, request, () => disconnected || res.destroyed);
    } catch (error) {
      conversation.emit({ type: 'error', message: errorMessage(error) });
    } finally {
      res.off('close', onClose);
      recorder.record('turn_end', { disconnected });
      conversation.emit = () => {};
      conversation.turn = undefined;
      conversation.touched = Date.now();
      finish();
      res.end();
    }
  }

  dispose() {
    this.conversations.disposeAll();
  }

  /**
   * Finds or creates the conversation and marks it busy. A turn whose client
   * has gone (Stop, reload) is already winding down, so wait for it instead of
   * rejecting the request that replaced it.
   */
  private async claim(request: ChatRequest): Promise<Conversation> {
    const id = request.conversationId ?? randomUUID();
    let conversation = this.conversations.get(id);
    while (conversation?.turn) {
      if (!conversation.turn.aborting) throw new HttpError(409, 'Conversation is busy');
      await conversation.turn.finished;
      conversation = this.conversations.get(id);
    }
    conversation ??= this.conversations.add(id, () => this.createConversation(id));
    conversation.turn = { aborting: false, finished: Promise.resolve() };
    return conversation;
  }

  /** The companion's models that this Pi login can use right now, then any through Claude Code. */
  async models(): Promise<{ id: string; name: string }[]> {
    const available = await this.modelRuntime.getAvailable(MODEL_PROVIDER);
    return [...available.map(({ id, name }) => ({ id, name })), ...(await this.bridged())];
  }

  private bridgeModels?: Promise<{ id: string; name: string }[]>;
  /**
   * Claude models offered by the bridge extension, listed once: the provider
   * only exists after a session has loaded the extension.
   */
  private bridged() {
    return (this.bridgeModels ??= (async () => {
      if (!existsSync(CLAUDE_BRIDGE.dir)) return [];
      try {
        (await this.createBridgeSession([], [])).dispose();
        return (
          this.modelRuntime
            .getModels(CLAUDE_BRIDGE.provider)
            // Dated snapshots duplicate the plain names.
            .filter(model => !/-\d{8}$/.test(model.id))
            .map(({ id, name }) => ({
              id: `${CLAUDE_BRIDGE.provider}/${id}`,
              name: `${name} (Claude Code)`,
            }))
        );
      } catch (error) {
        console.warn(`Claude bridge unavailable: ${errorMessage(error)}`);
        return [];
      }
    })());
  }

  private createBridgeSession(names: string[], tools: ReturnType<typeof createTools>) {
    return createBridgeSession(this.modelRuntime, SYSTEM_PROMPT, names, tools);
  }

  private createConversation(id: string): Conversation {
    const { model, effort, analysisSeconds } = this.settings.current;
    const { provider, id: modelId } = splitModel(model);
    const movetimeMs = analysisSeconds * 1000;
    const recorder = new Recorder(SESSIONS_DIR, {
      conversationId: id,
      model: `${provider}/${modelId}:${effort}`,
      systemPrompt: SYSTEM_PROMPT,
      lifetime: { ...this.lifetime },
      engine: { ...ENGINE, movetime: movetimeMs },
    });
    console.log(`Session recording: ${recorder.path}`);
    return {
      id,
      model: { provider, id: modelId, effort },
      movetimeMs,
      recorder,
      usage: emptyTotals(),
      touched: Date.now(),
      fen: '',
      arrows: [],
      emit: () => {},
      traceUci: (direction, line) => recorder.record('uci', { direction, line }),
    };
  }

  private async createSession(conversation: Conversation): Promise<AgentSession> {
    const tools = createTools(conversation);
    const names = tools.map(tool => tool.name);
    const { provider, id, effort } = conversation.model;
    const unavailable = () =>
      new Error(`Pi model ${provider}/${id} is unavailable; choose another in Settings.`);
    let session: AgentSession;
    if (provider === CLAUDE_BRIDGE.provider) {
      // The provider is registered by the extension, so the model can only be chosen afterwards.
      session = await this.createBridgeSession(names, tools);
      const model = this.modelRuntime.getModel(provider, id);
      if (!model) {
        session.dispose();
        throw unavailable();
      }
      await session.setModel(model);
      session.setThinkingLevel(effort);
    } else {
      const model = provider === MODEL_PROVIDER && this.modelRuntime.getModel(provider, id);
      if (!model) throw unavailable();
      ({ session } = await createAgentSession({
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: effort,
        resourceLoader: promptOnly(SYSTEM_PROMPT),
        tools: names,
        customTools: tools,
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(),
      }));
    }
    // The agent must never gain coding tools; refuse to run if anything else is active.
    session.setActiveToolsByName(names);
    const active = session.getActiveToolNames();
    if (active.length !== names.length || active.some(name => !names.includes(name))) {
      session.dispose();
      throw new Error('Unexpected tool configuration');
    }
    return session;
  }

  private async runTurn(
    conversation: Conversation,
    request: ChatRequest,
    cancelled: () => boolean,
  ) {
    const session = conversation.session!;
    const { recorder } = conversation;
    let text = '';
    let modelError: string | undefined;
    /** Whether arrows were drawn this turn. */
    let drew = false;
    /** Text held back from the user while it is decided whether to show it. */
    let held: string | null = null;
    /** Reads the reply's board claims while it is written, when claims are checked. */
    let check: ClaimCheck | undefined;

    const unsubscribe = session.subscribe(event => {
      // Text deltas are recorded as client events; record everything else the agent does.
      if (event.type !== 'message_update') recorder.record('agent', event);
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        if (held !== null) held += event.assistantMessageEvent.delta;
        else {
          text += event.assistantMessageEvent.delta;
          conversation.emit({ type: 'text', delta: event.assistantMessageEvent.delta });
          check?.update(text);
        }
      } else if (event.type === 'tool_execution_start') {
        if (event.toolName === 'set_arrows') drew = true;
        conversation.emit({ type: 'status', text: toolStatus[event.toolName] ?? 'Working…' });
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        const { usage, stopReason, errorMessage } = event.message;
        if (usage) {
          this.addUsage(
            conversation,
            usage.totalTokens,
            usage.cost.total || bridgedCost(this.modelRuntime, conversation.model, usage),
          );
        }
        if (stopReason === 'error') modelError = errorMessage || 'Model request failed';
      }
    });
    const prompt = async (message: string) => {
      modelError = undefined;
      await session.prompt(message);
      if (modelError) throw new Error(modelError);
    };

    try {
      const { message, fen, moves, playerColor, game } = request;
      let sharedPlies = 0;
      if (game) {
        while (sharedPlies < moves.length && game.moves[sharedPlies] === moves[sharedPlies]) {
          sharedPlies++;
        }
      }
      const onMainline = !game || sharedPlies === moves.length;
      const sidelineNote =
        game && !onMainline
          ? `\n\nSideline note: the board snapshot diverges from the game after ply ${sharedPlies} with ${moves.slice(sharedPlies).join(' ')}.`
          : '';
      const engineReview = game && this.reviewGame?.(game.moves);
      const review = game
        ? `\n\nGame under review: ${JSON.stringify(game)}` +
          sidelineNote +
          (engineReview ? `\n\nEngine review of the game: ${JSON.stringify(engineReview)}` : '')
        : '';
      const facts = {
        ...describePosition(fen),
        // What the move that led here did, when there is one.
        ...(conversation.previousFen && {
          lastMove: describeLine(conversation.previousFen, moves.slice(-1)).steps[0],
        }),
      };
      if (CLAIM_CHECK) {
        check = new ClaimCheck((system, question) => this.ask(conversation, system, question), {
          fen,
          ...(conversation.previousFen && {
            before: {
              fen: conversation.previousFen,
              move: numberedMove(moves.length - 1, moves[moves.length - 1]),
            },
          }),
          continuation: onMainline ? game?.moves.slice(moves.length) : undefined,
        });
      }
      await prompt(
        `Board snapshot: ${JSON.stringify({ fen, moves, playerColor })}\n\n` +
          `Board facts: ${JSON.stringify(facts)}${review}\n\nUser: ${message}`,
      );
      // The model sometimes explains in its reasoning, draws arrows and then only captions them.
      if (needsFullAnswer(text, drew) && !cancelled()) {
        conversation.emit({ type: 'status', text: 'Finishing the explanation…' });
        held = '';
        await prompt(fullAnswerRequest(text));
        const extra = held.trim();
        held = null;
        recorder.record('full_answer_request', { shown: text, extra });
        if (extra && !/^ok\.?$/i.test(extra)) {
          text = extra;
          conversation.emit({ type: 'replace_text', text });
        }
      }
      // Claims about the board are checked by the rules, and a reply with false ones is rewritten.
      if (check && text.trim() && !cancelled()) {
        conversation.emit({ type: 'status', text: 'Checking the explanation against the board…' });
        const wrong = await check.finish(text).catch(() => []);
        check = undefined;
        recorder.record('claim_check', { false: wrong });
        if (wrong.length && !cancelled()) {
          conversation.emit({ type: 'replace_text', text: '' });
          conversation.emit({ type: 'status', text: 'Correcting a statement about the board…' });
          text = '';
          await prompt(claimFeedback(wrong));
        }
      }
      const remaining = await repairAnnotations({
        errors: () => annotationErrors(fen, text, conversation.arrows),
        cancelled,
        repair: async (feedback, attempt) => {
          recorder.record('annotation_feedback', { attempt, feedback });
          conversation.emit({ type: 'replace_text', text: '' });
          conversation.emit({ type: 'status', text: 'Correcting annotation mismatch…' });
          text = '';
          await prompt(feedback);
        },
      });
      if (remaining.length) {
        recorder.record('annotation_validation_failed', { errors: remaining });
        conversation.arrows = [];
        conversation.emit({ type: 'arrows', arrows: [] });
        conversation.emit({
          type: 'status',
          text: 'Could not validate annotations; arrows hidden.',
        });
      }
      conversation.emit({ type: 'done' });
    } finally {
      unsubscribe();
    }
  }

  /** A one-off reply from the companion's model for a check on its work, counted in its usage. */
  private async ask(conversation: Conversation, system: string, question: string) {
    const { provider, id } = conversation.model;
    const reply = await complete(this.modelRuntime, `${provider}/${id}`, 'low', system, question);
    this.addUsage(conversation, reply.tokens, reply.cost);
    return reply.text;
  }

  private addUsage(conversation: Conversation, tokens: number, cost: number) {
    const add = (totals: Totals) => {
      totals.tokens += Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
      totals.cost += Number.isFinite(cost) ? Math.max(0, cost) : 0;
    };
    add(conversation.usage);
    add(this.lifetime);
    try {
      saveTotals(this.lifetime);
    } catch {
      conversation.emit({ type: 'status', text: 'Warning: lifetime usage could not be saved.' });
    }
    conversation.emit({ type: 'usage', session: conversation.usage, lifetime: this.lifetime });
  }
}

/** One reply from `modelId` to `message` under `systemPrompt`, with no tools. */
export type Completion = { text: string; tokens: number; cost: number; seconds: number };

export async function complete(
  runtime: ModelRuntime,
  modelId: string,
  effort: 'low' | 'medium',
  systemPrompt: string,
  message: string,
): Promise<Completion> {
  const model = splitModel(modelId);
  const unavailable = () => new Error(`${modelId} is unavailable`);
  let session;
  if (model.provider === CLAUDE_BRIDGE.provider) {
    session = await createBridgeSession(runtime, systemPrompt);
    const found = runtime.getModel(model.provider, model.id);
    if (!found) throw unavailable();
    await session.setModel(found);
    session.setThinkingLevel(effort);
  } else {
    const found = runtime.getModel(model.provider, model.id);
    if (!found) throw unavailable();
    ({ session } = await createAgentSession({
      modelRuntime: runtime,
      model: found,
      thinkingLevel: effort,
      resourceLoader: promptOnly(systemPrompt),
      tools: [],
      customTools: [],
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
    }));
  }
  const started = Date.now();
  const reply: Completion = { text: '', tokens: 0, cost: 0, seconds: 0 };
  let failure: string | undefined;
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      reply.text += event.assistantMessageEvent.delta;
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const { usage, stopReason, errorMessage } = event.message;
      if (usage) {
        reply.tokens += usage.totalTokens;
        reply.cost += usage.cost.total || bridgedCost(runtime, model, usage);
      }
      if (stopReason === 'error') failure = errorMessage || 'Model request failed';
    }
  });
  try {
    await session.prompt(message);
    if (failure) throw new Error(failure);
    reply.seconds = (Date.now() - started) / 1000;
    return reply;
  } finally {
    session.dispose();
  }
}
