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
};
