import type { Square } from 'chess.js';
import { Type } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  annotationColorNames,
  annotationPalette,
  maxAnnotations,
} from '../shared/annotation-palette.ts';
import type { Annotation, ServerEvent } from '../shared/protocol.ts';
import { ENGINE } from './config.ts';
import { diagnoseMove, featureChange, playLine } from './diagnosis.ts';
import { describeLine, describePosition, positionalFacts } from './facts.ts';
import { explore, ratings, speeds } from './lichess.ts';
import { analyze, type UciTrace } from './stockfish.ts';

/** What the tools need from the turn in progress. */
export type ToolContext = {
  /** The position submitted with the current turn. */
  fen: string;
  /** The position one move earlier, when the snapshot has a history. */
  previousFen?: string;
  /** Arrows drawn so far in the current turn. */
  arrows: Annotation[];
  emit: (event: ServerEvent) => void;
  traceUci: UciTrace;
  /** How long the engine thinks per call, in milliseconds. */
  movetimeMs: number;
};

export const MAX_HYPOTHETICAL_MOVES = 20;

const square = Type.String({ pattern: '^[a-h][1-8]$' });
const hypotheticalMoves = Type.Optional(
  Type.Array(Type.String(), { maxItems: MAX_HYPOTHETICAL_MOVES }),
);
const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/** Which positional features come about and go away by the end of a line's first eight moves. */
function lineChange(fen: string, line: string[]) {
  try {
    const change = featureChange(fen, playLine(fen, line, 8).fen());
    return { comesAbout: change.new, goesAway: change.gone };
  } catch {
    return undefined;
  }
}

/** Status line shown in the chat while each tool runs. */
export const toolStatus: Record<string, string> = {
  analyze_position: 'Checking Stockfish…',
  diagnose_move: 'Working out what the move missed…',
  lichess_moves: 'Checking Lichess move frequencies…',
  set_arrows: 'Drawing arrows…',
};

/** The companion's only tools. They read the live turn through `context`, which outlives any one turn. */
export function createTools(context: ToolContext) {
  return [
    defineTool({
      name: 'analyze_position',
      label: 'Stockfish',
      description: `Evaluate the submitted position and return the top ${ENGINE.multiPV} engine moves, White-perspective scores and continuations, with facts computed from the board: where the pieces stand, what is attacked, and for each line's first moves what the move takes, attacks, uncovers and leaves loose; the position's positional features (pawn structure, files, outposts, bishops, restricted pieces, space, king cover, pawn breaks) and, for each line, which of them come about or go away by its end. Optionally apply hypothetical moves. Set beforeLastMove to start from the position before the last move of the snapshot's history instead: use it to see what else could have been played there, or with moves set to an alternative to see where that leads.`,
      parameters: Type.Object({
        moves: hypotheticalMoves,
        beforeLastMove: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args, signal) => {
        if (args.beforeLastMove && !context.previousFen)
          throw new Error('The snapshot has no earlier move');
        const start = args.beforeLastMove ? context.previousFen! : context.fen;
        const result = await analyze(
          start,
          args.moves,
          signal,
          context.traceUci,
          context.movetimeMs,
        );
        context.emit({ type: 'analysis', result });
        // The model gets the lines spelled out: what each move takes, attacks and leaves loose.
        return textResult({
          ...result,
          position: describePosition(result.fen),
          // The slow-changing features plans are made from, and how each line changes them.
          positional: positionalFacts(result.fen),
          moves: result.moves.map(candidate => ({
            ...candidate,
            ...describeLine(result.fen, candidate.continuation),
            positionalChangeByLineEnd: lineChange(result.fen, candidate.continuation),
          })),
        });
      },
    }),
    defineTool({
      name: 'diagnose_move',
      label: 'Diagnose a move',
      description: `Work out what a move missed or allowed, from the engine and the board rather than by eye. Give the move in SAN, played from the submitted position (or, with beforeLastMove, from the position before the snapshot's last move). Returns the mover's winning chances before and after, the engine's better moves, the opponent's best reply and what it wins, any threat that was already there before the move (found by letting the mover pass) and whether the move left it standing, any material win or mate the mover had and missed, a one-sentence finding when one of these applies, and otherwise the positional features that differ between where the move's line and the engine's line lead.`,
      parameters: Type.Object({
        move: Type.String(),
        beforeLastMove: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args, signal) => {
        if (args.beforeLastMove && !context.previousFen)
          throw new Error('The snapshot has no earlier move');
        const start = args.beforeLastMove ? context.previousFen! : context.fen;
        // Three searches run at once; each gets a little longer than a plain analysis.
        const movetime = Math.max(context.movetimeMs, 2000);
        const result = await diagnoseMove(start, args.move, (fen, moves, multiPV) =>
          analyze(fen, moves, signal, context.traceUci, movetime, multiPV),
        );
        return textResult(result);
      },
    }),
    defineTool({
      name: 'lichess_moves',
      label: 'Lichess move frequencies',
      description:
        'Look up empirical move frequencies and game outcomes in rated Lichess games at the submitted position, optionally after hypothetical moves. Defaults to all rating buckets and speeds. Returned frequency is a fraction of ALL games at this position, not just the displayed moves.',
      parameters: Type.Object({
        moves: hypotheticalMoves,
        ratings: Type.Optional(
          Type.Array(Type.Integer({ enum: ratings }), { minItems: 1, maxItems: ratings.length }),
        ),
        speeds: Type.Optional(
          Type.Array(Type.String({ enum: speeds }), { minItems: 1, maxItems: speeds.length }),
        ),
      }),
      execute: async (_id, args, signal) => {
        const result = await explore(context.fen, args, signal);
        context.emit({ type: 'explorer', result });
        return textResult(result);
      },
    }),
    defineTool({
      name: 'set_arrows',
      label: 'Draw arrows',
      description: 'Replace arrows on the submitted board. Link chat text with #annotation-ID.',
      parameters: Type.Object({
        arrows: Type.Array(
          Type.Object({
            id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,40}$' }),
            from: square,
            to: square,
            color: Type.Union(annotationColorNames.map(color => Type.Literal(color))),
          }),
          { maxItems: maxAnnotations },
        ),
      }),
      execute: async (_id, args) => {
        const ids = new Set(args.arrows.map(arrow => arrow.id));
        if (ids.size !== args.arrows.length || args.arrows.some(arrow => arrow.from === arrow.to)) {
          throw new Error('Arrows require distinct endpoints and unique IDs');
        }
        context.arrows = args.arrows.map(arrow => ({
          id: arrow.id,
          from: arrow.from as Square,
          to: arrow.to as Square,
          color: annotationPalette[arrow.color],
        }));
        context.emit({ type: 'arrows', arrows: context.arrows });
        // Without this, the model often treats drawing as the answer and only captions the arrows.
        return textResult({
          arrows: context.arrows,
          next: 'Arrows drawn. Now write your full answer to the question as your reply; the user has not seen your reasoning or tool calls, only the reply.',
        });
      },
    }),
  ];
}
