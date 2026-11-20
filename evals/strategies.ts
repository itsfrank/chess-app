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
};
