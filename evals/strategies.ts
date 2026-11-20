/**
 * Ways of briefing the companion that the lab compares. A strategy turns a
 * question's frozen context (the position, its facts and the engine analysis
 * already run) into one system prompt and one message, so trying a new idea
 * costs a single model request per question and no engine time.
 *
 * To try something: add a strategy here and run
 * `npm run lab -- compare <old> <new>`. Extra information for the model, such
 * as a new kind of fact, belongs in `freeze` (lab.ts) so that it is computed
 * once and every strategy can choose whether to show it.
 */
import { positionalChange } from '../server/facts.ts';
import { SYSTEM_PROMPT } from '../server/prompt.ts';
import type { Context } from './lab.ts';

export type Strategy = {
  /** What is being tried, in a line, for the report. */
  about: string;
  system: string;
  message: (context: Context) => string;
};

const NO_TOOLS = `In this turn your tools are unavailable. The engine analysis you would have asked for has already been run and is included in the message. Do not call tools, draw arrows or write annotation links; answer in plain Markdown.`;

/** Everything the companion would have seen and fetched, laid out as its turn would have it. */
const briefing = ({ test, fen, position, analysis, afterFocus, afterKey }: Context) =>
  [
    `Board snapshot: ${JSON.stringify({ fen, moves: test.moves, playerColor: test.playerColor })}`,
    `Board facts: ${JSON.stringify(position)}`,
    `Engine analysis of this position: ${JSON.stringify(analysis)}`,
    `Engine analysis after ${test.focus}: ${JSON.stringify(afterFocus)}`,
    afterKey ? `Engine analysis after ${test.keyMove}: ${JSON.stringify(afterKey)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

const bullets = (facts: string[]) => facts.map(fact => `- ${fact}`).join('\n');
const change = (before: string[], after: string[]) => {
  const { gone, new: added } = positionalChange(before, after);
  return `No longer true:\n${bullets(gone) || '- (nothing)'}\nNow true:\n${bullets(added) || '- (nothing)'}`;
};

/** The position's positional facts and how the move asked about (and the master's move) change them. */
const positionalBriefing = ({ test, positional }: Context) =>
  [
    `Positional facts of this position:\n${bullets(positional.before)}`,
    `Positional change right after ${test.focus}:\n${change(positional.before, positional.afterFocus.now)}`,
    positional.afterKey
      ? `Positional change right after ${test.keyMove}:\n${change(positional.before, positional.afterKey.now)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

const POSITIONAL_FACTS = `The message may also include "Positional facts", computed from the board: pawn structure (islands, isolated, doubled, backward, passed and blocked pawns, pawn chains, how many pawns stand on light and dark squares), open and half-open files and the heavy pieces on them, outposts (squares in the enemy half that a pawn defends and no enemy pawn can ever attack), each bishop measured against its own pawns, pieces with at most one safe move or no safe move forward, pawn cover around each king, and the pawn breaks available to each side. Where the facts show how a move changes these, use them to explain what the move is for. These are long-term features; they matter more to a plan than small differences in engine score.`;

/** How the positional facts stand once the engine's best line after a move has been played out. */
const lineBriefing = ({ test, positional }: Context) =>
  [
    `Positional change by the end of the engine's best line after ${test.focus} (${positional.afterFocus.line.join(' ')}):\n${change(positional.before, positional.afterFocus.afterLine)}`,
    positional.afterKey
      ? `Positional change by the end of the engine's best line after ${test.keyMove} (${positional.afterKey.line.join(' ')}):\n${change(positional.before, positional.afterKey.afterLine)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

/** How to answer a question about the idea behind a move: a structure and a checklist of themes. */
const IDEAS_GUIDE = [
  `When asked about the idea behind a move, or why a natural move is not best, explain the plan, not the calculation. Answer in two parts:`,
  `1. **What changes**: two to four positional features the move (or the line it starts) changes, taken from the positional facts and the engine lines: a piece that gains or loses squares, a file, an outpost, a weak pawn, a bishop that becomes good or bad, a pawn break made possible or prevented, a trade that changes which minor pieces remain.`,
  `2. **The idea**: what the move is for, why that matters in this position, and what it gives up or what the alternative would give up. Say what the side intends next and what the opponent can no longer do.`,
  `Themes to consider: prophylaxis (what the opponent wanted to do next, and how the move stops it); rerouting a badly placed piece (where it is going, by which squares); improving the worst piece or restricting the opponent's best one; trading a good piece for a bad one, or trading to reach a structure or a minor-piece balance that favours one side (an advantage changing form, not material won); restraint and blockade of pawns; seizing or contesting an open file; creating or fixing weaknesses; and in a simplified or endgame position, whether the stronger side can still make progress (weaknesses to attack, entry squares for the king) or the position is a fortress.`,
  `A fixed-depth engine cannot see long-term factors such as a blockade, a bad bishop, a fortress or a slow manoeuvre. When scores are within a few tenths of a pawn, they do not decide between moves; the long-term factors do, so explain those instead of calling the moves equal. Do not frame the idea as a difference in score, do not open with a score, and quote at most one. The question tells you which move a strong player chose; explain why, rather than disputing it because the scores are close.`,
].join('\n\n');

// ---------------------------------------------------------------------------
// The same information as text rather than JSON: fewer tokens, and nothing to parse.

type Evaluation = { type: 'cp' | 'mate'; value: number };
type Step = {
  move: string;
  does: string;
  check?: boolean;
  attacks?: string[];
  uncovers?: string[];
  leavesLoose?: string[];
};
type Line = {
  san: string;
  evaluation: Evaluation;
  continuation: string[];
  steps?: Step[];
  materialAfterSteps?: string;
};
type EngineLines = { depth: number; moves: object[] };

const score = ({ type, value }: Evaluation) =>
  type === 'mate'
    ? `${value > 0 ? 'White' : 'Black'} mates in ${Math.abs(value)}`
    : `${value >= 0 ? '+' : '−'}${(Math.abs(value) / 100).toFixed(2)}`;
const step = (s: Step) =>
  [
    `${s.move} (${s.does}${s.check ? ', check' : ''})`,
    s.attacks?.length ? `attacks ${s.attacks.join(', ')}` : '',
    s.uncovers?.length ? `uncovers ${s.uncovers.join(', ')}` : '',
    s.leavesLoose?.length ? `leaves loose ${s.leavesLoose.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(', ');
const engineText = (title: string, analysis: EngineLines) =>
  `${title} (depth ${analysis.depth}; scores from White's side):\n` +
  (analysis.moves as Line[])
    .map(
      line =>
        `- ${line.san} ${score(line.evaluation)}: ${line.continuation.join(' ')}\n` +
        (line.steps?.length ? `  ${line.steps.map(step).join('; ')}. ` : '  ') +
        (line.materialAfterSteps ?? ''),
    )
    .join('\n');

/** The briefing of `briefing`, written as text. */
function compactBriefing({ test, fen, position, analysis, afterFocus, afterKey }: Context) {
  const facts = position as {
    toMove: string;
    white: string;
    black: string;
    material: string;
    attacked?: string[];
    pinned?: string[];
    check?: boolean;
  };
  const after = (san: string, { move, analysis: lines }: typeof afterFocus) =>
    engineText(`Engine analysis after ${san} (${step(move as Step)})`, lines as EngineLines);
  return [
    `Board: ${fen}; moves so far ${test.moves.join(' ')}; the user plays ${test.playerColor}.`,
    `Board facts: ${facts.toMove} to move. White: ${facts.white}. Black: ${facts.black}. ${facts.material}.` +
      (facts.check ? ' The side to move is in check.' : '') +
      (facts.attacked?.length ? `\nAttacked: ${facts.attacked.join('; ')}.` : '') +
      (facts.pinned?.length ? `\nPinned: ${facts.pinned.join(', ')}.` : ''),
    engineText('Engine analysis of this position', analysis as EngineLines),
    after(test.focus!, afterFocus),
    afterKey ? after(test.keyMove!, afterKey) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A positional fact's feature, with squares and counts taken out, so it can be matched. */
const feature = (fact: string) => {
  const head = fact.includes(':') ? fact.slice(0, fact.indexOf(':')) : fact;
  return head
    .replace(/\b[a-h][1-8]\b/g, '')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
};
/** Each feature that differs between two positions, as "feature: before → after". */
function pairedChange(before: string[], after: string[]): string {
  const group = (facts: string[]) => {
    const groups = new Map<string, string[]>();
    for (const fact of facts) {
      const key = feature(fact);
      const head = fact.includes(':') ? fact.slice(0, fact.indexOf(':')) : fact;
      // The value is what follows the feature's name, or the whole fact when the name had squares.
      const value =
        head.replace(/\s+/g, ' ').trim() === key
          ? fact.includes(':')
            ? fact.slice(fact.indexOf(':') + 1).trim()
            : 'yes'
          : fact;
      groups.set(key, [...(groups.get(key) ?? []), value]);
    }
    return groups;
  };
  const [old, now] = [group(before), group(after)];
  const lines = [...new Set([...old.keys(), ...now.keys()])].flatMap(key => {
    const [was, is] = [old.get(key)?.join('; ') ?? 'none', now.get(key)?.join('; ') ?? 'none'];
    return was === is ? [] : [`- ${key}: ${was} → ${is}`];
  });
  return lines.join('\n') || '- (no change)';
}

/** Positional facts now, and feature by feature where the engine's lines lead. */
function pairedBriefing({ test, positional }: Context) {
  const { afterFocus, afterKey } = positional;
  return [
    `Positional facts of this position:\n${bullets(positional.before)}`,
    `How they change by the end of the engine's best line after ${test.focus} (${afterFocus.line.join(' ')}):\n${pairedChange(positional.before, afterFocus.afterLine)}`,
    afterKey
      ? `How they change by the end of the engine's best line after ${test.keyMove} (${afterKey.line.join(' ')}):\n${pairedChange(positional.before, afterKey.afterLine)}`
      : '',
    afterKey
      ? `Side by side, the end of the line after ${test.keyMove} → the end of the line after ${test.focus}:\n${pairedChange(afterKey.afterLine, afterFocus.afterLine)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** How the positional facts stand once the engine's line is continued about ten more moves. */
const farBriefing = ({ test, positional }: Context) =>
  [
    [test.focus, positional.afterFocus] as const,
    ...(positional.afterKey ? [[test.keyMove, positional.afterKey] as const] : []),
  ]
    .filter(([, outlook]) => outlook.afterFar)
    .map(
      ([move, outlook]) =>
        `Positional change further on, after ${move} ${outlook.line.join(' ')} ${outlook.farLine!.join(' ')} (the engine's line continued):\n${change(positional.before, outlook.afterFar!)}`,
    )
    .join('\n\n');

const LINE_FACTS = `${POSITIONAL_FACTS} The change by the end of an engine line shows what kind of position the move leads to; use it to say what the move is aiming for.`;

/** What the opponent would do if the side to move passed, and their best reply after the move. */
function threatBriefing({ test, threat, afterFocus }: Context) {
  if (!threat) return '';
  const mover = test.playerColor === 'white' ? 'White' : 'Black';
  const opponent = mover === 'White' ? 'Black' : 'White';
  const [best] = threat.analysis.moves as {
    continuation: string[];
    evaluation: object;
    steps: object[];
  }[];
  const [reply] = afterFocus.analysis.moves as { continuation: string[] }[];
  if (!best) return '';
  return [
    `What ${opponent} wants: if ${mover} could pass, the engine's best line for ${opponent} would be ${best.continuation.slice(0, 8).join(' ')} (evaluation ${JSON.stringify(best.evaluation)}; steps ${JSON.stringify(best.steps)}).`,
    reply
      ? `After ${test.focus}, ${opponent}'s best line is ${reply.continuation.slice(0, 8).join(' ')}.`
      : '',
    `Use this to say whether the move stops something ${opponent} wanted (prophylaxis).`,
  ]
    .filter(Boolean)
    .join(' ');
}

export const STRATEGIES: Record<string, Strategy> = {
  /** As close to the shipped companion as a single tool-less request allows. */
  current: {
    about: 'the shipped prompt, with the engine analysis it would have fetched',
    system: `${SYSTEM_PROMPT}\n\n${NO_TOOLS}`,
    message: context => `${briefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** The same information, with the prompt rewritten around plans instead of moves. */
  ideas: {
    about: 'same information; prompt asks for the plan, the reason and the trade-off',
    system: [
      `You are a chess coach helping a club player understand ideas. The user's message includes a board snapshot, facts computed from the board, and engine analysis that has already been run.`,
      `Explain the idea, not the calculation. Say what the move is for: the plan it starts or the opponent's plan it stops, which piece or pawn it improves or restricts, which squares, files or diagonals it gains or gives up, and what it accepts in return. Then say what the side intends to do next and what the opponent can no longer do. When asked why a natural move is not best, explain what that move gives up over the coming moves, not only what the engine prefers.`,
      `Engine scores are evidence that a judgement is sound; they are not the explanation, and a small difference in score is not a reason. A fixed-depth engine can misjudge long-term factors such as a blockade, a bad bishop or a fortress. Do not open with a score, and quote at most one where it supports a point. Do not dismiss the premise of the question because the scores are close.`,
      `Take every statement about where pieces stand and what a move captures, attacks or defends from the board facts and the analysis. If they do not show it, do not claim it.`,
      `Write three short paragraphs or fewer in plain Markdown. Tools are unavailable in this turn; do not draw arrows or write annotation links.`,
    ].join('\n\n'),
    message: context => `${briefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** The shipped prompt, plus positional facts and how the move changes them. */
  positional: {
    about: 'shipped prompt + positional facts of the position and their change after the move',
    system: `${SYSTEM_PROMPT}\n\n${POSITIONAL_FACTS}\n\n${NO_TOOLS}`,
    message: context =>
      `${briefing(context)}\n\n${positionalBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** As `positional`, plus where the engine's line after the move leads, positionally. */
  consequences: {
    about:
      'positional + how the positional facts change by the end of the engine line after the move',
    system: `${SYSTEM_PROMPT}\n\n${POSITIONAL_FACTS} The change by the end of an engine line shows what kind of position the move leads to; use it to say what the move is aiming for.\n\n${NO_TOOLS}`,
    message: context =>
      `${briefing(context)}\n\n${positionalBriefing(context)}\n\n${lineBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** As `consequences`, with a guide to answering idea questions appended to the shipped prompt. */
  coach: {
    about:
      'consequences + shipped prompt extended with a two-part answer (what changes, the idea) and a theme checklist',
    system: `${SYSTEM_PROMPT}\n\n${POSITIONAL_FACTS} The change by the end of an engine line shows what kind of position the move leads to; use it to say what the move is aiming for.\n\n${IDEAS_GUIDE}\n\n${NO_TOOLS}`,
    message: context =>
      `${briefing(context)}\n\n${positionalBriefing(context)}\n\n${lineBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** As `consequences`, plus what the opponent would do if the mover passed (prophylaxis). */
  threat: {
    about:
      'consequences + what the opponent would play if the mover passed (null-move engine line)',
    system: `${SYSTEM_PROMPT}\n\n${POSITIONAL_FACTS} The change by the end of an engine line shows what kind of position the move leads to; use it to say what the move is aiming for.\n\n${NO_TOOLS}`,
    message: context =>
      `${briefing(context)}\n\n${positionalBriefing(context)}\n\n${lineBriefing(context)}\n\n${threatBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** `consequences` with the engine analysis and board facts written as text instead of JSON. */
  compact: {
    about: 'consequences, with engine analysis and board facts as short text instead of JSON',
    system: `${SYSTEM_PROMPT}\n\n${LINE_FACTS}\n\n${NO_TOOLS}`,
    message: context =>
      `${compactBriefing(context)}\n\n${positionalBriefing(context)}\n\n${lineBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** `compact` with changes shown feature by feature, and the two moves' outcomes side by side. */
  paired: {
    about:
      'compact, changes as feature: before → after, and for "why not X" both moves’ line ends side by side',
    system: `${SYSTEM_PROMPT}\n\n${LINE_FACTS}\n\n${NO_TOOLS}`,
    message: context =>
      `${compactBriefing(context)}\n\n${pairedBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** `compact` without the facts of the position itself or right after the move: only where it leads. */
  lineonly: {
    about:
      'compact, without positional facts of the position itself; only their change by line end',
    system: `${SYSTEM_PROMPT}\n\n${LINE_FACTS}\n\n${NO_TOOLS}`,
    message: context =>
      `${compactBriefing(context)}\n\n${lineBriefing(context)}\n\nUser: ${context.test.message}`,
  },

  /** `consequences` plus the positional change once the engine's line is continued further. */
  farther: {
    about:
      'consequences + positional change after the engine line continued to about 18 half-moves',
    system: `${SYSTEM_PROMPT}\n\n${LINE_FACTS} The change further on shows where a slow plan leads.\n\n${NO_TOOLS}`,
    message: context =>
      `${briefing(context)}\n\n${positionalBriefing(context)}\n\n${lineBriefing(context)}\n\n${farBriefing(context)}\n\nUser: ${context.test.message}`,
  },
};
