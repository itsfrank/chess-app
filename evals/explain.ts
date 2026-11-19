/**
 * Measures how often the companion states things about the board that are not
 * true. It asks each model to explain the same moves from the player's own
 * games through the running backend, extracts the concrete claims in every
 * answer, and checks them against the position (see claims.ts).
 *
 *   npm run eval -- <label> [--models a,b,c] [--games 4]   run and save a result set
 *   npm run eval -- compare <label> <label>                put two result sets side by side
 *
 * The backend must be running. The cases are chosen once and kept in
 * `.data/evals/cases.json`, so later runs answer the same questions; delete
 * the file to choose again. Nothing here is committed: the games are the
 * user's own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Chess } from 'chess.js';
import type {
  ArchivedGame,
  GameArchivePage,
  PositionEval,
  ServerEvent,
  Settings,
  SettingsInfo,
} from '../shared/protocol.ts';
import { explainPrompt, numberedMove, reviewGame } from '../shared/quality.ts';
import { promptOnly } from '../server/chat.ts';
import { DATA_DIR, MODEL_PROVIDER, PORT } from '../server/config.ts';
import { positionFacts } from '../server/facts.ts';
import { EXTRACTOR_PROMPT, parseClaims, verify, type Claim, type Verdict } from './claims.ts';

const API = `http://127.0.0.1:${PORT}`;
const DIR = join(DATA_DIR, 'evals');
const CASES_FILE = join(DIR, 'cases.json');
const DEFAULT_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const EXTRACTOR = 'gpt-6.1-sol';
const MAX_CASES = 12;

type Case = {
  id: string;
  game: ArchivedGame;
  /** Half-moves played in the position asked about. */
  ply: number;
  message: string;
};
type Answer = {
  case: string;
  text: string;
  seconds: number;
  cost: number;
  tools: number;
  arrows: number;
  error?: string;
  claims: (Claim & { verdict: Verdict })[];
};
type Results = { label: string; ranAt: string; models: Record<string, Answer[]> };

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(API + path, init);
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json() as Promise<T>;
};
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Runs `work` over `items`, a few at a time, keeping their order. */
async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
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

function fenAfter(moves: string[]): string {
  const board = new Chess();
  for (const san of moves) board.move(san);
  return board.fen();
}

/** The player's worst moves and a best one from each of their most recent games. */
async function chooseCases(games: number): Promise<Case[]> {
  const { settings } = await json<SettingsInfo>('/api/settings');
  if (!settings.chesscomUsername) throw new Error('Set a chess.com username in Settings first');
  const page = await json<GameArchivePage>(
    `/api/chesscom/games?username=${settings.chesscomUsername}`,
  );
  const cases: Case[] = [];
  for (const game of page.games.slice(0, games)) {
    const response = await fetch(`${API}/api/games/review`, post({ moves: game.moves }));
    const evals: PositionEval[] = [];
    let book = 0;
    for (const line of (await response.text()).trim().split('\n')) {
      const event = JSON.parse(line);
      if ('ply' in event) evals[event.ply] = event;
      else if ('book' in event) book = event.book;
    }
    const review = reviewGame(game.moves, evals, book);
    const mine = review.moves
      .map((move, index) => ({ move: move!, index }))
      .filter(({ index }) => (index % 2 === 0) === (game.playerColor === 'white'));
    const errors = mine
      .filter(({ move }) => move.loss > 5)
      .sort((a, b) => b.move.loss - a.move.loss);
    const found = mine.find(({ move }) => move.quality.id === 'great');
    const tag = game.url.split('/').pop();
    for (const { move, index } of [...errors.slice(0, 2), ...(found ? [found] : [])]) {
      cases.push({
        id: `${tag}:explain:${numberedMove(index, game.moves[index])}`,
        game,
        ply: index,
        message: explainPrompt(game.moves, index, move, true),
      });
    }
    // The same worst move again, asked the way a user types it with the move already on the board.
    if (errors[0]) {
      const san = game.moves[errors[0].index];
      cases.push({
        id: `${tag}:typed:${numberedMove(errors[0].index, san)}`,
        game,
        ply: errors[0].index + 1,
        message: `Why was ${san} a mistake here? What should I have played instead?`,
      });
    }
  }
  return cases.slice(0, MAX_CASES);
}

/** One companion turn in a new conversation. */
async function ask(test: Case): Promise<Omit<Answer, 'claims'>> {
  const moves = test.game.moves.slice(0, test.ply);
  const started = Date.now();
  const answer = { case: test.id, text: '', seconds: 0, cost: 0, tools: 0, arrows: 0 } as Omit<
    Answer,
    'claims'
  >;
  const { playerColor } = test.game;
  const body = { fen: fenAfter(moves), moves, message: test.message, playerColor, game: test.game };
  const response = await fetch(`${API}/api/chat`, post(body));
  for (const line of (await response.text()).trim().split('\n')) {
    const event = JSON.parse(line) as ServerEvent;
    if (event.type === 'text') answer.text += event.delta;
    else if (event.type === 'replace_text') answer.text = event.text;
    else if (event.type === 'analysis' || event.type === 'explorer') answer.tools++;
    else if (event.type === 'arrows') answer.arrows = event.arrows.length;
    else if (event.type === 'usage') answer.cost = event.session.cost;
    else if (event.type === 'error') answer.error = event.message;
  }
  answer.seconds = (Date.now() - started) / 1000;
  return answer;
}

/** The claims in an answer, written down by a model and decided on the board. */
async function checkClaims(
  runtime: ModelRuntime,
  test: Case,
  text: string,
): Promise<Answer['claims']> {
  const model = runtime.getModel(MODEL_PROVIDER, EXTRACTOR);
  if (!model) throw new Error(`${EXTRACTOR} is unavailable for extracting claims`);
  const snapshot = fenAfter(test.game.moves.slice(0, test.ply));
  const before = test.ply ? fenAfter(test.game.moves.slice(0, test.ply - 1)) : undefined;
  const describe = (name: string, fen: string) => {
    const { white, black, toMove } = positionFacts(fen);
    return `${name}: ${fen}\n  White: ${white}\n  Black: ${black}\n  ${toMove} to move`;
  };
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    thinkingLevel: 'low',
    resourceLoader: promptOnly(EXTRACTOR_PROMPT),
    tools: [],
    customTools: [],
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(),
  });
  let reply = '';
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      reply += event.assistantMessageEvent.delta;
  });
  try {
    await session.prompt(
      [
        describe('snapshot', snapshot),
        before
          ? `${describe('before', before)}\n  then ${numberedMove(test.ply - 1, test.game.moves[test.ply - 1])} was played, giving the snapshot`
          : '',
        `The game continued from the snapshot: ${test.game.moves.slice(test.ply, test.ply + 12).join(' ')}`,
        `Answer to extract claims from:\n${text}`,
      ].join('\n\n'),
    );
    return parseClaims(reply).map(claim => ({
      ...claim,
      verdict: verify(claim, snapshot, before),
    }));
  } finally {
    session.dispose();
  }
}

const RELATIONS = ['attacks', 'defends', 'pinned'];
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

function summarize(answers: Answer[]) {
  const claims = answers.flatMap(answer => answer.claims);
  const count = (verdict: Verdict) => claims.filter(claim => claim.verdict === verdict).length;
  const wrong = (answer: Answer) => answer.claims.some(claim => claim.verdict === 'false');
  return {
    answers: answers.length,
    claims: claims.length,
    // Captures and checks can be read off the notation; these need the geometry.
    'attack/defence claims': claims.filter(claim => RELATIONS.includes(claim.kind)).length,
    false: count('false'),
    'bad lines': count('bad-line'),
    'answers with a false claim': answers.filter(wrong).length,
    'arrows drawn': answers.filter(answer => answer.arrows > 0).length,
    'tool calls': Number(mean(answers.map(answer => answer.tools)).toFixed(1)),
    seconds: Number(mean(answers.map(answer => answer.seconds)).toFixed(0)),
    'cost ($)': Number(mean(answers.map(answer => answer.cost)).toFixed(4)),
    errors: answers.filter(answer => answer.error).length,
  };
}

const load = (label: string): Results =>
  JSON.parse(readFileSync(join(DIR, `${label}.json`), 'utf8'));

function report(results: Results) {
  console.log(`\n${results.label} (${results.ranAt})`);
  console.table(
    Object.fromEntries(
      Object.entries(results.models).map(([model, answers]) => [model, summarize(answers)]),
    ),
  );
}

async function run(label: string, models: string[], games: number) {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(CASES_FILE)) {
    writeFileSync(CASES_FILE, JSON.stringify(await chooseCases(games)));
  }
  const cases: Case[] = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  console.log(`${cases.length} cases:\n  ${cases.map(test => test.id).join('\n  ')}`);

  const runtime = await ModelRuntime.create();
  const original = (await json<SettingsInfo>('/api/settings')).settings;
  const use = (changes: Partial<Settings>) =>
    json('/api/settings', { method: 'PUT', body: JSON.stringify(changes) });
  const results: Results = { label, ranAt: new Date().toISOString(), models: {} };
  try {
    for (const model of models) {
      // A conversation keeps the model it started with, so one model is asked at a time.
      await use({ model, effort: 'medium' });
      const answers = await pool(cases, 3, ask);
      console.log(`${model}: answered`);
      results.models[model] = await pool(answers, 4, async (answer): Promise<Answer> => {
        const test = cases.find(item => item.id === answer.case)!;
        const claims = await checkClaims(runtime, test, answer.text).catch(() => []);
        return { ...answer, claims };
      });
      writeFileSync(join(DIR, `${label}.json`), JSON.stringify(results, null, 2));
    }
  } finally {
    await use({ model: original.model, effort: original.effort });
  }
  report(results);
  for (const [model, answers] of Object.entries(results.models)) {
    for (const answer of answers) {
      for (const claim of answer.claims) {
        if (claim.verdict === 'false')
          console.log(`FALSE ${model} ${answer.case}: “${claim.quote}”`);
      }
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => rest[rest.indexOf(`--${name}`) + 1];
if (command === 'compare') rest.slice(0, 2).forEach(label => report(load(label)));
else if (!command) console.log('usage: npm run eval -- <label> [--models a,b] [--games 4]');
else {
  await run(
    command,
    rest.includes('--models') ? option('models').split(',') : DEFAULT_MODELS,
    rest.includes('--games') ? Number(option('games')) : 4,
  );
  process.exit(0);
}
