/**
 * A cheap loop for improving how the companion explains ideas. Instead of a
 * whole conversation with tool calls per question, each question's context is
 * computed once and kept; a strategy (strategies.ts) turns it into a single
 * model request. Answers are cached, measured for free (metrics.ts), and two
 * strategies are compared by one judge request per dozen questions that sees
 * both answers unlabelled.
 *
 *   npm run lab -- freeze [--engine]              compute every question's context (no model);
 *                                                 the engine runs only with --engine or when nothing is frozen
 *   npm run lab -- run <strategy> [--model haiku] answer, cached, and print the free metrics
 *   npm run lab -- compare <old> <new>            answer both, then judge them head to head
 *   npm run lab -- score <a> <b> … [--samples N]  score each answer once, point by point, and compare
 *   npm run lab -- agree <a> …                    score with Sonnet and Haiku and say how often they agree
 *   npm run lab -- show <strategy> <case-id>      print one answer beside its reference points
 *
 * A dozen questions are used unless `--all` asks for all 31 or `--holdout` for the 19 not in
 * the dozen (kept for confirming a strategy that won on the dozen). `--model` is
 * `haiku` (the default: cheapest, and with the most to gain) or `sonnet`;
 * `--judge` is `sonnet` by default. Needs no backend, only Stockfish and the
 * Claude bridge. What holds up here should then be confirmed with `npm run eval`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Chess } from 'chess.js';
import type { Analysis } from '../shared/protocol.ts';
import { DATA_DIR } from '../server/config.ts';
import { describeLine, describePosition, positionalFacts } from '../server/facts.ts';
import { analyze } from '../server/stockfish.ts';
import { complete, fenAfter, HAIKU, ideaCases, pool, SONNET, spread, type Case } from './lib.ts';
import { measure, plain, summarizeMetrics } from './metrics.ts';
import { STRATEGIES } from './strategies.ts';

const DIR = join(DATA_DIR, 'evals', 'lab');
const CONTEXTS = join(DIR, 'contexts.json');
const ANSWERS = join(DIR, 'answers.json');
const VERDICTS = join(DIR, 'verdicts.json');
const SCORES = join(DIR, 'scores.json');
const SAMPLE = 12;
const BATCH = 12;
const ENGINE_MS = 2500;
const MODELS: Record<string, string> = { haiku: HAIKU, sonnet: SONNET };

/** The engine's lines with what each move does, as the companion's tool would return them. */
type Lines = Omit<Analysis, 'moves'> & { moves: object[] };
/** Everything known about a question before any model is asked. */
export type Context = {
  test: Case;
  fen: string;
  position: object;
  analysis: Lines;
  /** What the move asked about does, and the engine's view of the position after it. */
  afterFocus: { move: object; analysis: Lines };
  /** The same for the move the master played, when the question is about another move. */
  afterKey?: { move: object; analysis: Lines };
  /**
   * What the opponent would play if the side to move passed: the engine's best line with the turn
   * handed over, or null when that is illegal (the side to move is in check).
   */
  threat?: { analysis: Lines } | null;
  /**
   * The engine's line continued from where the frozen line after each move ends, by searching that
   * position again, so slow plans have time to show.
   */
  further?: { focus: string[]; key?: string[] };
  /** Positional facts (server/facts.ts), recomputed from the board without the engine. */
  positional: {
    before: string[];
    afterFocus: Outlook;
    afterKey?: Outlook;
  };
};
/**
 * The positional facts after a move, after the engine's best line from there, and after that line
 * continued further (when frozen).
 */
type Outlook = {
  now: string[];
  line: string[];
  afterLine: string[];
  farLine?: string[];
  afterFar?: string[];
};
type Stored = { text: string; tokens: number; cost: number; seconds: number };
type Verdict = { winner: 'old' | 'new' | 'tie'; old: number; new: number; cost?: number };
/** Which reference points one answer conveys, by one judge, with the words that convey each. */
type Score = { points: boolean[]; quotes: string[]; cost: number };

const args = process.argv.slice(2);
const option = (name: string) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
const modelOf = (name: string | undefined, fallback: string) =>
  MODELS[name ?? ''] ?? name ?? fallback;
const readJson = <T>(file: string, empty: T): T =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : empty;
const writeJson = (file: string, value: unknown) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
};
const hash = (...parts: string[]) =>
  createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);

async function lines(fen: string): Promise<Lines> {
  const analysis = await analyze(fen, [], undefined, undefined, ENGINE_MS);
  return {
    ...analysis,
    moves: analysis.moves.map(candidate => ({
      ...candidate,
      ...describeLine(analysis.fen, candidate.continuation),
    })),
  };
}

/** The engine's best line for the opponent if the side to move could pass. */
async function threat(fen: string): Promise<{ analysis: Lines } | null> {
  if (new Chess(fen).isCheck()) return null;
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return { analysis: await lines(parts.join(' ')) };
}

const LINE_PLIES = 8;

/** Plays as much of `sans` as is legal on `board`, returning the moves played. */
function play(board: Chess, sans: string[]): string[] {
  const played: string[] = [];
  for (const san of sans) {
    try {
      played.push(board.move(san).san);
    } catch {
      break;
    }
  }
  return played;
}
const bestLine = (analysis: Lines) =>
  (analysis.moves[0] as { continuation?: string[] } | undefined)?.continuation ?? [];

/** Positional facts after a move, at the end of the engine's best line, and further on. */
function outlook(fen: string, analysis: Lines, further?: string[]): Outlook {
  const board = new Chess(fen);
  const now = positionalFacts(board.fen());
  const line = play(board, bestLine(analysis).slice(0, LINE_PLIES));
  const afterLine = positionalFacts(board.fen());
  if (!further) return { now, line, afterLine };
  const farLine = play(board, further);
  return { now, line, afterLine, farLine, afterFar: positionalFacts(board.fen()) };
}

/** The engine's best line from where the frozen line after a move ends. */
async function continued(analysis: Lines): Promise<string[]> {
  const board = new Chess(analysis.fen);
  play(board, bestLine(analysis).slice(0, LINE_PLIES));
  if (board.isGameOver()) return [];
  return bestLine(await lines(board.fen()));
}
const furtherOf = async (context: Omit<Context, 'positional'>) => ({
  focus: await continued(context.afterFocus.analysis),
  ...(context.afterKey && { key: await continued(context.afterKey.analysis) }),
});

/** The facts that need no engine, from a context's frozen positions. */
function withBoardFacts(context: Omit<Context, 'positional'>): Context {
  return {
    ...context,
    positional: {
      before: positionalFacts(context.fen),
      afterFocus: outlook(
        context.afterFocus.analysis.fen,
        context.afterFocus.analysis,
        context.further?.focus,
      ),
      ...(context.afterKey && {
        afterKey: outlook(
          context.afterKey.analysis.fen,
          context.afterKey.analysis,
          context.further?.key,
        ),
      }),
    },
  };
}

/**
 * Runs the engine on every question's position and on the moves it asks about, then adds the
 * board facts. With contexts already frozen and no `--engine`, only the board facts are redone, so
 * the engine output (and every answer cached on it) stays the same.
 */
async function freeze() {
  if (existsSync(CONTEXTS) && !args.includes('--engine')) {
    const frozen = readJson<Context[]>(CONTEXTS, []);
    // Engine work added after a freeze is done only where it is missing.
    const contexts = await pool(frozen, 4, async context =>
      withBoardFacts({
        ...context,
        threat: context.threat === undefined ? await threat(context.fen) : context.threat,
        further: context.further ?? (await furtherOf(context)),
      }),
    );
    writeJson(CONTEXTS, contexts);
    console.log(`board facts of ${contexts.length} contexts rewritten in ${CONTEXTS}`);
    return;
  }
  const cases = ideaCases();
  const after = async (fen: string, san: string) => {
    const board = new Chess(fen);
    board.move(san);
    return { move: describeLine(fen, [san]).steps[0], analysis: await lines(board.fen()) };
  };
  const contexts = await pool(cases, 4, async (test): Promise<Context> => {
    const fen = fenAfter(test.moves);
    const engine = {
      test,
      fen,
      position: describePosition(fen),
      analysis: await lines(fen),
      afterFocus: await after(fen, test.focus!),
      ...(test.focus !== test.keyMove && { afterKey: await after(fen, test.keyMove!) }),
      threat: await threat(fen),
    };
    return withBoardFacts({ ...engine, further: await furtherOf(engine) });
  });
  writeJson(CONTEXTS, contexts);
  console.log(`${contexts.length} contexts written to ${CONTEXTS}`);
}

function loadContexts(): Context[] {
  if (!existsSync(CONTEXTS)) throw new Error('Run `npm run lab -- freeze` first');
  const all = readJson<Context[]>(CONTEXTS, []);
  if (args.includes('--all')) return all;
  const sample = spread(all, SAMPLE);
  // The questions never iterated on, for confirming a strategy that won on the sample.
  return args.includes('--holdout') ? all.filter(context => !sample.includes(context)) : sample;
}

/** The strategy's answer to every question, asked only where it is not already stored. */
async function answers(
  runtime: ModelRuntime,
  name: string,
  model: string,
  contexts: Context[],
  sample = 0,
) {
  const strategy = STRATEGIES[name];
  if (!strategy) throw new Error(`No strategy "${name}"; there are ${Object.keys(STRATEGIES)}`);
  const stored = readJson<Record<string, Stored>>(ANSWERS, {});
  let asked = 0;
  const result = await pool(contexts, 4, async context => {
    const message = strategy.message(context);
    // Keyed by what is actually sent, so editing a strategy asks again and nothing else does.
    // Further samples of the same request are told apart by number; the first keeps its key.
    const key = sample
      ? hash(model, strategy.system, message, `sample ${sample}`)
      : hash(model, strategy.system, message);
    if (!stored[key]) {
      stored[key] = await complete(runtime, model, 'medium', strategy.system, message);
      asked++;
      writeJson(ANSWERS, stored);
    }
    return { context, key, ...stored[key] };
  });
  const cost = result.reduce((sum, answer) => sum + answer.cost, 0);
  console.log(
    `${name}${sample ? ` (sample ${sample + 1})` : ''} on ${model.split('/').pop()}: ${asked} asked, ${result.length - asked} from cache, ` +
      `$${(cost / result.length).toFixed(4)} per answer at list price`,
  );
  return result;
}
type Answered = Awaited<ReturnType<typeof answers>>;

const metricsOf = (answered: Answered) =>
  summarizeMetrics(
    answered.map(({ context, text }) =>
      measure(text, context.test.rubric, context.test.focus !== context.test.keyMove),
    ),
  );

const JUDGE_PROMPT = `You compare two chess coaches' answers to the same question against reference points taken from published annotations of the game. For each question you get the reference points and two answers, A and B.

For each question:
- Count how many reference points each answer conveys. A point counts if the answer says the same thing in any words, including through concrete moves that amount to it. It does not count if it is absent, only gestured at with a generality that would fit any position, or contradicted.
- Say which answer conveys the reference reasoning better: "A", "B" or "tie". Prefer the one that conveys more points; between equals, the one that says nothing misleading. Length, style and engine scores are not merits.

Output only JSON: [{"id": "<question id>", "a": <points A conveys>, "b": <points B conveys>, "better": "A" | "B" | "tie"}, ...] with one entry per question, in order.`;

/** Head-to-head verdicts on two sets of answers to the same questions, a batch per request. */
async function judgePairs(runtime: ModelRuntime, judge: string, old: Answered, fresh: Answered) {
  const stored = readJson<Record<string, Verdict>>(VERDICTS, {});
  const pairs = old.map((answer, index) => {
    const key = hash(judge, answer.key, fresh[index].key);
    // Which answer is shown first is fixed per pair, and balanced, so position cannot favour one.
    const oldFirst = parseInt(key.slice(0, 2), 16) % 2 === 0;
    return { context: answer.context, key, oldFirst, old: answer.text, fresh: fresh[index].text };
  });
  const pending = pairs.filter(pair => !stored[pair.key]);
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    const message = batch
      .map(({ context, oldFirst, old: oldText, fresh: freshText }) => {
        const [a, b] = oldFirst ? [oldText, freshText] : [freshText, oldText];
        const points = context.test.rubric
          .map((point, index) => `${index + 1}. ${point}`)
          .join('\n');
        return `## Question ${context.test.id}\n${context.test.message}\n\nReference points:\n${points}\n\n### Answer A\n${plain(a)}\n\n### Answer B\n${plain(b)}`;
      })
      .join('\n\n');
    const { text, cost } = await complete(runtime, judge, 'medium', JUDGE_PROMPT, message);
    const rows = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as {
      id: string;
      a: number;
      b: number;
      better: string;
    }[];
    for (const [index, pair] of batch.entries()) {
      // By id where the judge kept it exactly; otherwise by position, which it was told to keep.
      const row =
        rows.find(item => item.id === pair.context.test.id) ??
        (rows.length === batch.length ? rows[index] : undefined);
      if (!row) continue;
      const [oldPoints, newPoints] = pair.oldFirst ? [row.a, row.b] : [row.b, row.a];
      const first = pair.oldFirst ? 'old' : 'new';
      const second = pair.oldFirst ? 'new' : 'old';
      stored[pair.key] = {
        winner: row.better === 'A' ? first : row.better === 'B' ? second : 'tie',
        old: oldPoints,
        new: newPoints,
        cost: cost / batch.length,
      };
    }
    writeJson(VERDICTS, stored);
  }
  return pairs.map(pair => ({ ...pair, verdict: stored[pair.key] }));
}

const SCORE_PROMPT = `You grade chess coaches' answers against reference points taken from published annotations of the game. Each item has a question, its numbered reference points and one answer; items are independent and may answer the same question differently.

For each reference point, decide whether the answer conveys it. A point counts if the answer says the same thing in any words, including through concrete moves that amount to it. It does not count if it is absent, only gestured at with a generality that would fit any position, or contradicted elsewhere in the answer. Length, style and engine scores are not merits.

Output only JSON: [{"item": <item number>, "conveyed": [<1 or 0 per reference point, in order>], "quotes": [<for each point, the answer's words (at most 12) that convey it, or "">]}, ...] with one entry per item, in order.`;

/**
 * Which reference points each answer conveys, judged once per answer and stored, so a strategy is
 * scored once and any two can be compared without judging either again. Answers from different
 * strategies are mixed within a batch, and the judge never learns which strategy wrote one.
 */
async function scoreAnswers(runtime: ModelRuntime, judge: string, answered: Answered) {
  const stored = readJson<Record<string, Score>>(SCORES, {});
  const keyOf = (answer: Answered[number]) =>
    hash(judge, answer.key, ...answer.context.test.rubric);
  const pending = [...new Map(answered.map(answer => [keyOf(answer), answer])).entries()]
    .filter(([key]) => !stored[key])
    .sort(([a], [b]) => a.localeCompare(b));
  let spent = 0;
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    const message = batch
      .map(([, { context, text }], index) => {
        const points = context.test.rubric.map((point, n) => `${n + 1}. ${point}`).join('\n');
        return `## Item ${index + 1}\n${context.test.message}\n\nReference points:\n${points}\n\n### Answer\n${plain(text)}`;
      })
      .join('\n\n');
    const { text, cost } = await complete(runtime, judge, 'medium', SCORE_PROMPT, message);
    spent += cost;
    type Row = { item: number; conveyed: number[]; quotes?: string[] };
    let rows: Row[];
    try {
      // An empty quote is sometimes left out altogether ("…",,""); put it back.
      const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
      rows = JSON.parse(json.replace(/,(?=\s*[,\]])/g, ',""')) as Row[];
    } catch {
      console.log(
        `${judge.split('/').pop()} returned unreadable JSON; ${batch.length} left unscored`,
      );
      continue;
    }
    for (const [index, [key, answer]] of batch.entries()) {
      const row =
        rows.find(item => Number(item.item) === index + 1) ??
        (rows.length === batch.length ? rows[index] : undefined);
      if (row?.conveyed?.length !== answer.context.test.rubric.length) continue;
      stored[key] = {
        points: row.conveyed.map(Boolean),
        quotes: (row.quotes ?? []).map(String),
        cost: cost / batch.length,
      };
    }
    writeJson(SCORES, stored);
  }
  if (pending.length)
    console.log(
      `${judge.split('/').pop()} judged ${pending.length} answers for $${spent.toFixed(3)} at list price`,
    );
  return answered.map(answer => stored[keyOf(answer)]);
}

/** Every strategy's answers, `samples` per question, all scored by `judge` in shared batches. */
async function scored(
  runtime: ModelRuntime,
  names: string[],
  model: string,
  judge: string,
  contexts: Context[],
  samples: number,
) {
  const sets: { name: string; sample: number; answered: Answered }[] = [];
  for (const name of names)
    for (let sample = 0; sample < samples; sample++)
      sets.push({ name, sample, answered: await answers(runtime, name, model, contexts, sample) });
  const scores = await scoreAnswers(
    runtime,
    judge,
    sets.flatMap(set => set.answered),
  );
  let offset = 0;
  return sets.map(set => {
    const mine = scores.slice(offset, (offset += set.answered.length));
    return { ...set, points: mine.map(score => score?.points.filter(Boolean).length ?? NaN) };
  });
}

/** Chance of a split at least this lopsided if the two were equally good (two-sided sign test). */
function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  const choose = (k: number) => {
    let value = 1;
    for (let index = 1; index <= k; index++) value = (value * (n - k + index)) / index;
    return value;
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k++) tail += choose(k);
  return n ? Math.min(1, (2 * tail) / 2 ** n) : 1;
}

const [command, first, second] = args;
if (command === 'freeze') {
  await freeze();
} else if (command === 'run' && first) {
  const runtime = await ModelRuntime.create();
  const answered = await answers(runtime, first, modelOf(option('model'), HAIKU), loadContexts());
  console.table({ [first]: metricsOf(answered) });
} else if (command === 'compare' && first && second) {
  const runtime = await ModelRuntime.create();
  const model = modelOf(option('model'), HAIKU);
  const contexts = loadContexts();
  const old = await answers(runtime, first, model, contexts);
  const fresh = await answers(runtime, second, model, contexts);
  console.table({ [first]: metricsOf(old), [second]: metricsOf(fresh) });

  const judged = await judgePairs(runtime, modelOf(option('judge'), SONNET), old, fresh);
  const verdicts = judged.flatMap(pair => pair.verdict ?? []);
  const count = (winner: Verdict['winner']) => verdicts.filter(v => v.winner === winner).length;
  const total = judged.reduce((sum, pair) => sum + pair.context.test.rubric.length, 0);
  const points = (which: 'old' | 'new') => verdicts.reduce((sum, v) => sum + v[which], 0);
  console.log(`\n${first}: ${STRATEGIES[first].about}\n${second}: ${STRATEGIES[second].about}\n`);
  for (const { context, verdict } of judged) {
    const mark = !verdict
      ? '?'
      : verdict.winner === 'new'
        ? '+'
        : verdict.winner === 'old'
          ? '−'
          : '=';
    console.log(
      `  ${mark} ${context.test.id.slice(5).padEnd(46)} ${verdict?.old ?? '?'} → ${verdict?.new ?? '?'} of ${context.test.rubric.length}`,
    );
  }
  console.log(
    `\n${second} better in ${count('new')}, ${first} better in ${count('old')}, ${count('tie')} ties ` +
      `(p = ${signTest(count('new'), count('old')).toFixed(2)} that this is chance)\n` +
      `reference points conveyed: ${points('old')} → ${points('new')} of ${total}`,
  );
} else if ((command === 'score' || command === 'agree') && first) {
  const runtime = await ModelRuntime.create();
  const model = modelOf(option('model'), HAIKU);
  const contexts = loadContexts();
  const names = args.slice(1).filter(arg => arg in STRATEGIES);
  const samples = Number(option('samples') ?? 1);
  const max = contexts.reduce((sum, context) => sum + context.test.rubric.length, 0);
  const judges = command === 'agree' ? [SONNET, HAIKU] : [modelOf(option('judge'), SONNET)];
  const byJudge = [];
  for (const judge of judges)
    byJudge.push(await scored(runtime, names, model, judge, contexts, samples));

  for (const [index, sets] of byJudge.entries()) {
    // Each question's points averaged over the samples, per strategy.
    const mean = (name: string) =>
      contexts.map((_, question) => {
        const mine = sets.filter(set => set.name === name);
        // Over the samples that were scored; a judge occasionally leaves an answer out.
        const values = mine.map(set => set.points[question]).filter(value => !Number.isNaN(value));
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      });
    const rows = Object.fromEntries(
      names.map(name => {
        const mine = sets.filter(set => set.name === name);
        const all = mine.flatMap(set => set.answered);
        const total = mean(name).reduce((sum, value) => sum + value, 0);
        return [
          name,
          {
            points: `${total.toFixed(1)} of ${max}`,
            'per sample': mine
              .map(set => set.points.reduce((a, b) => a + (Number.isNaN(b) ? 0 : b), 0))
              .join(' / '),
            ...metricsOf(all),
            '$ per answer': (all.reduce((sum, a) => sum + a.cost, 0) / all.length).toFixed(4),
          },
        ];
      }),
    );
    console.log(`\njudged by ${judges[index].split('/').pop()}, ${samples} sample(s) per question`);
    console.table(rows);
    const base = mean(names[0]);
    for (const name of names.slice(1)) {
      const theirs = mean(name);
      const better = theirs.filter((value, q) => value > base[q]).length;
      const worse = theirs.filter((value, q) => value < base[q]).length;
      console.log(
        `${name} against ${names[0]}: better in ${better}, worse in ${worse}, ` +
          `${contexts.length - better - worse} level (p = ${signTest(better, worse).toFixed(2)})`,
      );
    }
    if (!args.includes('--quiet'))
      for (const [question, context] of contexts.entries())
        console.log(
          `  ${context.test.id.slice(5).padEnd(46)} ${names.map(name => mean(name)[question].toFixed(1).padStart(4)).join(' ')} of ${context.test.rubric.length}`,
        );
  }
  if (command === 'agree') {
    // Point by point, how often the cheaper judge says what the reference judge says.
    const [reference] = byJudge;
    let same = 0;
    let count = 0;
    const stored = readJson<Record<string, Score>>(SCORES, {});
    for (const set of reference)
      for (const answer of set.answered) {
        const a = stored[hash(judges[0], answer.key, ...answer.context.test.rubric)];
        const b = stored[hash(judges[1], answer.key, ...answer.context.test.rubric)];
        if (!a || !b) continue;
        a.points.forEach((point, n) => {
          count++;
          if (point === b.points[n]) same++;
        });
      }
    console.log(`\nthe judges agree on ${same} of ${count} reference points`);
  }
} else if (command === 'show' && first && second) {
  const runtime = await ModelRuntime.create();
  const contexts = readJson<Context[]>(CONTEXTS, []).filter(context =>
    context.test.id.includes(second),
  );
  const [answer] = await answers(
    runtime,
    first,
    modelOf(option('model'), HAIKU),
    contexts.slice(0, 1),
  );
  if (!answer) throw new Error(`No question matches "${second}"`);
  console.log(
    `\n${answer.context.test.message}\n\nReference:\n- ${answer.context.test.rubric.join('\n- ')}\n\n${plain(answer.text)}`,
  );
} else {
  console.log(
    'usage: npm run lab -- freeze | run <strategy> | compare <old> <new> | show <strategy> <case>',
  );
}
process.exit(0);
