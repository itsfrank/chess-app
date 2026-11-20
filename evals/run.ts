/**
 * Measures the companion's answers on three kinds of question, through the
 * running backend:
 *
 * - `mine`: explaining the worst and best moves of the player's own recent
 *   games, as the Explain button and a typed question do.
 * - `tactics`: multi-move tactics from Lichess puzzles (`tactics.json`).
 * - `ideas`: positional moves from annotated master games (`ideas.json`),
 *   asked both as "what is the idea" and "why not the natural alternative".
 *
 * Every answer has its concrete board claims extracted and decided by the
 * rules of chess (see claims.ts). Tactics and ideas also have reference
 * points, and a judge model says which of them the answer conveys.
 *
 *   npm run eval -- <label> [--quick] [--suites mine,tactics,ideas] [--models a,b,c]
 *   npm run eval -- <label> --quick --suites ideas --no-claims     the cheapest loop for ideas
 *   npm run eval -- regrade <label>                 grade stored answers again
 *   npm run eval -- compare <label> <label>
 *
 * By default Claude Sonnet, through the bridge, both answers and grades (`--models`,
 * `--extractor`, `--judge`). `--quick` asks a fixed sample of 24 questions instead of all 75,
 * `--limit N` caps each suite at N, and `--no-claims` skips claim checking. To try a change
 * to the companion: restart the backend, run with a new label, and compare with the last one.
 *
 * The questions from the player's games are chosen once and kept in
 * `.data/evals/cases.json`, so later runs answer the same ones; delete the
 * file to choose again. They and all results stay out of the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createBridgeSession, promptOnly } from '../server/chat.ts';
import { CLAUDE_BRIDGE, DATA_DIR, PORT, splitModel } from '../server/config.ts';
import { lineFacts, positionFacts } from '../server/facts.ts';
import { EXTRACTOR_PROMPT, parseClaims, verify, type Claim, type Verdict } from './claims.ts';
import type { Tactic } from './fetch-tactics.ts';

const args = process.argv.slice(2);
const option = (name: string) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
/** Another backend can be measured by pointing at it, such as one running an older commit. */
const API = option('api') ?? `http://127.0.0.1:${PORT}`;
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const DIR = join(DATA_DIR, 'evals');
const CASES_FILE = join(DIR, 'cases.json');
const SONNET = 'claude-bridge/claude-sonnet-5-5';
/** One mid-priced model answers by default, so that trying a change is quick and cheap. */
const DEFAULT_MODELS = [SONNET];
/** `--quick` asks an evenly spread sample of each suite instead of every question. */
const QUICK = { mine: 6, tactics: 6, ideas: 12 };
const flag = (name: string) => args.includes(`--${name}`);
/** Writes down the claims in an answer; whether they are true is then decided by the rules. */
const EXTRACTOR = option('extractor') ?? SONNET;
/** Says which reference points an answer conveys. */
const JUDGE = option('judge') ?? SONNET;
const SUITES = ['mine', 'tactics', 'ideas'] as const;
type Suite = (typeof SUITES)[number];

type Case = {
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
  /** Whether the answer conveys each rubric point, in order. */
  covered: boolean[];
};
type Results = {
  label: string;
  ranAt: string;
  /** The models that graded the answers; absent in results from before they were recorded. */
  graders?: { extractor: string; judge: string };
  suiteOf: Record<string, Suite>;
  models: Record<string, Answer[]>;
};

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
const side = (ply: number): 'white' | 'black' => (ply % 2 === 0 ? 'white' : 'black');

/** The player's worst moves and a best one from each of their most recent games. */
async function chooseMine(games: number): Promise<Case[]> {
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
      .filter(({ index }) => side(index) === game.playerColor);
    const errors = mine
      .filter(({ move }) => move.loss > 5)
      .sort((a, b) => b.move.loss - a.move.loss);
    const found = mine.find(({ move }) => move.quality.id === 'great');
    const tag = game.url.split('/').pop();
    const base = { suite: 'mine' as const, game, playerColor: game.playerColor, rubric: [] };
    for (const { move, index } of [...errors.slice(0, 2), ...(found ? [found] : [])]) {
      cases.push({
        ...base,
        id: `${tag}:explain:${numberedMove(index, game.moves[index])}`,
        moves: game.moves.slice(0, index),
        message: explainPrompt(game.moves, index, move, true),
      });
    }
    // The same worst move again, asked the way a user types it with the move already on the board.
    if (errors[0]) {
      const san = game.moves[errors[0].index];
      cases.push({
        ...base,
        id: `${tag}:typed:${numberedMove(errors[0].index, san)}`,
        moves: game.moves.slice(0, errors[0].index + 1),
        message: `Why was ${san} a mistake here? What should I have played instead?`,
      });
    }
  }
  return cases;
}

/** Multi-move tactics: the answer should find the first move and explain what the sequence wins. */
function tacticCases(): Case[] {
  const tactics: Tactic[] = JSON.parse(readFileSync(here('./tactics.json'), 'utf8'));
  return tactics.map(tactic => {
    const mover = side(tactic.moves.length);
    const start = fenAfter(tactic.moves);
    const { moves: steps, materialAfter } = lineFacts(start, tactic.solution, 9);
    // Described from the board, so the judge has the mechanism and not just the notation.
    const mechanism = steps
      .filter((_, index) => index % 2 === 0)
      .map(
        step =>
          `${step.move}: ${step.does}` +
          (step.check ? ', with check' : '') +
          (step.attacks.length ? `, attacking ${step.attacks.join(' and ')}` : ''),
      )
      .join('; ');
    return {
      id: `tactic:${tactic.id}`,
      suite: 'tactics',
      moves: tactic.moves,
      playerColor: mover,
      message: `What is ${mover === 'white' ? 'White' : 'Black'}'s best move here, and why does it work?`,
      rubric: [
        `Recommends ${steps[0].move} as the move to play.`,
        `Gives the continuation ${steps.map(step => step.move).join(' ')}, or at least its decisive follow-up ${steps[2].move}.`,
        `Explains how the sequence works, consistent with: ${mechanism}. (${positionFacts(start).material} before; ${materialAfter} after.)`,
      ],
    };
  });
}

type Idea = {
  id: string;
  /** The game up to and including the key move. */
  moves: string[];
  alternative: string | null;
  ideaPoints: string[];
  alternativePoints: string[];
};

/** Positional moves from annotated games: what the move is for, and why not the natural alternative. */
function ideaCases(): Case[] {
  const ideas: Idea[] = JSON.parse(readFileSync(here('./ideas.json'), 'utf8'));
  return ideas.flatMap(idea => {
    const before = idea.moves.slice(0, -1);
    const mover = side(before.length);
    const name = mover === 'white' ? 'White' : 'Black';
    const base = { suite: 'ideas' as const, moves: before, playerColor: mover };
    const cases: Case[] = [
      {
        ...base,
        id: `idea:${idea.id}`,
        message: `A strong player chose ${idea.moves.at(-1)} for ${name} in this position. What is the idea behind it?`,
        rubric: idea.ideaPoints,
      },
    ];
    if (idea.alternative && idea.alternativePoints.length) {
      cases.push({
        ...base,
        id: `idea:${idea.id}:not-${idea.alternative}`,
        message: `${idea.alternative} looks natural for ${name} here. Why is it not the best way to play?`,
        rubric: idea.alternativePoints,
      });
    }
    return cases;
  });
}

type Reply = Omit<Answer, 'claims' | 'covered'>;
/** One companion turn in a new conversation. */
async function ask(test: Case): Promise<Reply> {
  const { moves, message, playerColor, game } = test;
  const started = Date.now();
  const answer: Reply = { case: test.id, text: '', seconds: 0, cost: 0, tools: 0, arrows: 0 };
  const body = { fen: fenAfter(moves), moves, message, playerColor, game };
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

/** One reply from `modelId` to `message` under `systemPrompt`, with no tools. */
async function complete(
  runtime: ModelRuntime,
  modelId: string,
  effort: 'low' | 'medium',
  systemPrompt: string,
  message: string,
): Promise<string> {
  const { provider, id } = splitModel(modelId);
  let session;
  if (provider === CLAUDE_BRIDGE.provider) {
    session = await createBridgeSession(runtime, systemPrompt);
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error(`${modelId} is unavailable`);
    await session.setModel(model);
    session.setThinkingLevel(effort);
  } else {
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error(`${modelId} is unavailable`);
    ({ session } = await createAgentSession({
      modelRuntime: runtime,
      model,
      thinkingLevel: effort,
      resourceLoader: promptOnly(systemPrompt),
      tools: [],
      customTools: [],
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
    }));
  }
  let reply = '';
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      reply += event.assistantMessageEvent.delta;
  });
  try {
    await session.prompt(message);
    return reply;
  } finally {
    session.dispose();
  }
}

const describe = (name: string, fen: string) => {
  const { white, black, toMove } = positionFacts(fen);
  return `${name}: ${fen}\n  White: ${white}\n  Black: ${black}\n  ${toMove} to move`;
};

/** The claims in an answer, written down by a model and decided on the board. */
async function checkClaims(
  runtime: ModelRuntime,
  test: Case,
  text: string,
): Promise<Answer['claims']> {
  const ply = test.moves.length;
  const snapshot = fenAfter(test.moves);
  const before = ply ? fenAfter(test.moves.slice(0, -1)) : undefined;
  const last = ply ? numberedMove(ply - 1, test.moves[ply - 1]) : '';
  const reply = await complete(
    runtime,
    EXTRACTOR,
    'low',
    EXTRACTOR_PROMPT,
    [
      describe('snapshot', snapshot),
      before ? `${describe('before', before)}\n  then ${last} was played, giving the snapshot` : '',
      test.game
        ? `The game continued from the snapshot: ${test.game.moves.slice(ply, ply + 12).join(' ')}`
        : '',
      `Answer to extract claims from:\n${text}`,
    ].join('\n\n'),
  );
  return parseClaims(reply).map(claim => ({ ...claim, verdict: verify(claim, snapshot, before) }));
}

const JUDGE_PROMPT = `You grade a chess coach's answer against reference points taken from published annotations or from the solution of a puzzle. For each reference point decide whether the answer conveys its substance.

- A point is covered if the answer says the same thing in any words, including by giving the concrete moves that amount to it. It need not use the reference's terms.
- A point is not covered if the answer omits it, only gestures at it with a generality that would fit any position, or says something that contradicts it.
- Judge only what the answer says. Do not reward it for other true or interesting remarks, and do not use your own analysis to fill gaps.

Output only JSON: {"covered": [true, false, ...]} with one entry per reference point, in order.`;

/** Which rubric points an answer conveys, as judged by a model that is not being measured. */
async function judge(runtime: ModelRuntime, test: Case, text: string): Promise<boolean[]> {
  if (!test.rubric.length) return [];
  const reply = await complete(
    runtime,
    JUDGE,
    'medium',
    JUDGE_PROMPT,
    [
      describe('Position', fenAfter(test.moves)),
      `Question: ${test.message}`,
      `Reference points:\n${test.rubric.map((point, index) => `${index + 1}. ${point}`).join('\n')}`,
      `Answer:\n${text}`,
    ].join('\n\n'),
  );
  const { covered } = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  return test.rubric.map((_, index) => covered?.[index] === true);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const RELATIONS = ['attacks', 'defends', 'pinned'];
const percent = (part: number, whole: number) =>
  whole ? `${Math.round((100 * part) / whole)}%` : '—';

function summarize(answers: Answer[]) {
  const claims = answers.flatMap(answer => answer.claims);
  const points = answers.flatMap(answer => answer.covered);
  const graded = answers.filter(answer => answer.covered.length);
  const wrong = (answer: Answer) => answer.claims.some(claim => claim.verdict === 'false');
  return {
    answers: answers.length,
    // How much of what a good answer says is there: per point, and answers with every point.
    'points covered': percent(points.filter(Boolean).length, points.length),
    'fully covered': graded.length
      ? `${graded.filter(answer => answer.covered.every(Boolean)).length}/${graded.length}`
      : '—',
    // Captures and checks can be read off the notation; these need the geometry.
    'attack/defence claims': claims.filter(claim => RELATIONS.includes(claim.kind)).length,
    'false claims': claims.filter(claim => claim.verdict === 'false').length,
    'answers with a false claim': answers.filter(wrong).length,
    seconds: Number(mean(answers.map(answer => answer.seconds)).toFixed(0)),
    'cost ($)': Number(mean(answers.map(answer => answer.cost)).toFixed(4)),
    errors: answers.filter(answer => answer.error).length,
  };
}

const load = (label: string): Results =>
  JSON.parse(readFileSync(join(DIR, `${label}.json`), 'utf8'));

function report(results: Results) {
  for (const suite of [...SUITES, 'all'] as const) {
    const rows = Object.entries(results.models).flatMap(([model, answers]) => {
      const part = answers.filter(
        answer => suite === 'all' || results.suiteOf[answer.case] === suite,
      );
      return part.length ? [[model, summarize(part)] as const] : [];
    });
    if (!rows.length) continue;
    console.log(`\n${results.label} · ${suite} (${results.ranAt})`);
    console.table(Object.fromEntries(rows));
  }
}

/** The questions of the chosen suites; the player's own are chosen on first use and then kept. */
async function loadCases(suites: readonly Suite[], games: number, all = false): Promise<Case[]> {
  mkdirSync(DIR, { recursive: true });
  if (suites.includes('mine') && !existsSync(CASES_FILE)) {
    writeFileSync(CASES_FILE, JSON.stringify(await chooseMine(games)));
  }
  const bySuite: Record<Suite, () => Case[]> = {
    mine: () => JSON.parse(readFileSync(CASES_FILE, 'utf8')) as Case[],
    tactics: tacticCases,
    ideas: ideaCases,
  };
  return suites.flatMap(suite => {
    const cases = bySuite[suite]();
    // The same questions every time, spread over the suite, so quick runs can be compared.
    const size = all
      ? cases.length
      : Math.min(
          cases.length,
          Number(option('limit')) || (flag('quick') ? QUICK[suite] : cases.length),
        );
    return Array.from(
      { length: size },
      (_, index) => cases[Math.floor((index * cases.length) / size)],
    );
  });
}

const save = (results: Results) =>
  writeFileSync(join(DIR, `${results.label}.json`), JSON.stringify(results, null, 2));

/** Extracts and checks the claims of every answer and judges it against its reference points. */
async function grade(runtime: ModelRuntime, cases: Case[], answers: Reply[]): Promise<Answer[]> {
  return pool(answers, 4, async (answer): Promise<Answer> => {
    const test = cases.find(item => item.id === answer.case);
    if (!test) return { ...answer, claims: [], covered: [] };
    const [claims, covered] = await Promise.all([
      // Claims need a model call per answer; `--no-claims` skips them when only ideas are being tuned.
      flag('no-claims') ? [] : checkClaims(runtime, test, answer.text).catch(() => []),
      judge(runtime, test, answer.text).catch(() => test.rubric.map(() => false)),
    ]);
    return { ...answer, claims, covered };
  });
}

async function run(label: string, models: string[], suites: Suite[], games: number) {
  const cases = await loadCases(suites, games);
  const suiteOf = Object.fromEntries(cases.map(test => [test.id, test.suite]));
  const counts = SUITES.map(
    suite => `${cases.filter(test => test.suite === suite).length} ${suite}`,
  );
  const gradings =
    cases.filter(test => test.rubric.length).length + (flag('no-claims') ? 0 : cases.length);
  console.log(`${cases.length} questions: ${counts.join(', ')}`);
  console.log(`per model: ${cases.length} answers and ${gradings} grading requests`);

  const runtime = await ModelRuntime.create();
  const original = (await json<SettingsInfo>('/api/settings')).settings;
  const use = (changes: Partial<Settings>) =>
    json('/api/settings', { method: 'PUT', body: JSON.stringify(changes) });
  const graders = { extractor: EXTRACTOR, judge: JUDGE };
  const results: Results = { label, ranAt: new Date().toISOString(), graders, suiteOf, models: {} };
  try {
    for (const model of models) {
      // A conversation keeps the model it started with, so one model is asked at a time.
      await use({ model, effort: 'medium' });
      const answers = await pool(cases, 4, ask);
      console.log(`${model}: answered`);
      // Kept before grading, so that answers survive a grading run that is cut short.
      results.models[model] = answers.map(answer => ({ ...answer, claims: [], covered: [] }));
      save(results);
      results.models[model] = await grade(runtime, cases, answers);
      save(results);
      console.log(`${model}: graded`);
    }
  } finally {
    await use({ model: original.model, effort: original.effort });
  }
  report(results);
}

/** Grades the stored answers of an earlier run again with the current graders. */
async function regrade(label: string) {
  const results = load(label);
  const cases = await loadCases(SUITES, 0, true);
  const runtime = await ModelRuntime.create();
  results.graders = { extractor: EXTRACTOR, judge: JUDGE };
  for (const [model, answers] of Object.entries(results.models)) {
    results.models[model] = await grade(runtime, cases, answers);
    save(results);
    console.log(`${model}: graded`);
  }
  report(results);
}

const [command] = args;
if (command === 'compare') args.slice(1, 3).forEach(label => report(load(label)));
else if (command === 'regrade') {
  await regrade(args[1]);
  process.exit(0);
} else if (!command || command.startsWith('--')) {
  console.log(
    'usage: npm run eval -- <label> [--quick] [--suites mine,tactics,ideas] [--models a,b]',
  );
} else {
  await run(
    command,
    option('models')?.split(',') ?? DEFAULT_MODELS,
    (option('suites')?.split(',') as Suite[] | undefined) ?? [...SUITES],
    Number(option('games')) || 6,
  );
  process.exit(0);
}
