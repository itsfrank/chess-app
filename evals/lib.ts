/** What the eval runner and the strategy lab share: questions, model calls and small helpers. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Chess } from 'chess.js';
import type { ArchivedGame } from '../shared/protocol.ts';
import { bridgedCost, createBridgeSession, promptOnly } from '../server/chat.ts';
import { CLAUDE_BRIDGE, splitModel } from '../server/config.ts';
import { positionFacts } from '../server/facts.ts';

export const SONNET = 'claude-bridge/claude-sonnet-5-5';
export const HAIKU = 'claude-bridge/claude-haiku-5-5';
export const OPUS = 'claude-bridge/claude-opus-5-5';
export const SUITES = ['mine', 'tactics', 'ideas'] as const;
export type Suite = (typeof SUITES)[number];

export type Case = {
  id: string;
  suite: Suite;
  /** The moves that lead to the position asked about. */
  moves: string[];
  playerColor: 'white' | 'black';
  message: string;
  /** The finished game the position is from, when it is one of the player's. */
  game?: ArchivedGame;
  /** What a good answer says, each point judged separately; empty when only claims are checked. */
  rubric: string[];
  /** For a question about an idea: the move asked about and the move the master played. */
  focus?: string;
  keyMove?: string;
};

export const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** Runs `work` over `items`, a few at a time, keeping their order. */
export async function pool<T, R>(
  items: T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

export function fenAfter(moves: string[]): string {
  const board = new Chess();
  for (const san of moves) board.move(san);
  return board.fen();
}
export const side = (ply: number): 'white' | 'black' => (ply % 2 === 0 ? 'white' : 'black');

/** `count` of `items`, evenly spread and always the same ones, so samples can be compared. */
export const spread = <T>(items: T[], count: number): T[] =>
  Array.from(
    { length: Math.min(count, items.length) },
    (_, index) => items[Math.floor((index * items.length) / Math.min(count, items.length))],
  );

type Idea = {
  id: string;
  /** The game up to and including the key move. */
  moves: string[];
  alternative: string | null;
  ideaPoints: string[];
  alternativePoints: string[];
};

/** Positional moves from annotated games: what the move is for, and why not the natural alternative. */
export function ideaCases(): Case[] {
  const ideas: Idea[] = JSON.parse(readFileSync(here('./ideas.json'), 'utf8'));
  return ideas.flatMap(idea => {
    const before = idea.moves.slice(0, -1);
    const mover = side(before.length);
    const name = mover === 'white' ? 'White' : 'Black';
    const keyMove = idea.moves.at(-1)!;
    const base = { suite: 'ideas' as const, moves: before, playerColor: mover, keyMove };
    const cases: Case[] = [
      {
        ...base,
        id: `idea:${idea.id}`,
        focus: keyMove,
        message: `A strong player chose ${keyMove} for ${name} in this position. What is the idea behind it?`,
        rubric: idea.ideaPoints,
      },
    ];
    if (idea.alternative && idea.alternativePoints.length) {
      cases.push({
        ...base,
        id: `idea:${idea.id}:not-${idea.alternative}`,
        focus: idea.alternative,
        message: `${idea.alternative} looks natural for ${name} here. Why is it not the best way to play?`,
        rubric: idea.alternativePoints,
      });
    }
    return cases;
  });
}

export type Completion = { text: string; tokens: number; cost: number; seconds: number };

/** One reply from `modelId` to `message` under `systemPrompt`, with no tools. */
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

/** A position for a grader: the FEN and each side's pieces spelled out. */
export const describe = (name: string, fen: string) => {
  const { white, black, toMove } = positionFacts(fen);
  return `${name}: ${fen}\n  White: ${white}\n  Black: ${black}\n  ${toMove} to move`;
};
