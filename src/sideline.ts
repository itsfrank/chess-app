import { Chess } from 'chess.js';
import { replay } from './chess';

/** An exploratory variation branching off a finished game's mainline. */
export type Sideline = {
  /** Mainline half-move count where the variation branches off (0..mainline.length). */
  anchor: number;
  /** Exploratory SAN moves played from `mainline.slice(0, anchor)`. Always non-empty. */
  moves: string[];
  /** Number of sideline moves currently shown on the board (0..moves.length). */
  offset: number;
};

/** Current viewing position in a game review: either on the mainline or inside a sideline. */
export type ReviewCursor = {
  /** Mainline ply shown when `sideline` is null, or the sideline's anchor ply. */
  ply: number;
  sideline: Sideline | null;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The SAN moves leading to the position currently shown on the board. */
export function shownMovesOf(mainline: readonly string[], cursor: ReviewCursor): string[] {
  if (!cursor.sideline) return mainline.slice(0, cursor.ply);
  const { anchor, moves, offset } = cursor.sideline;
  return [...mainline.slice(0, anchor), ...moves.slice(0, offset)];
}

/** The full active line and current ply for step-by-step history navigation. */
export function activeLineOf(
  mainline: readonly string[],
  cursor: ReviewCursor,
): { moves: string[]; ply: number } {
  if (!cursor.sideline) return { moves: [...mainline], ply: cursor.ply };
  const { anchor, moves, offset } = cursor.sideline;
  return {
    moves: [...mainline.slice(0, anchor), ...moves],
    ply: anchor + offset,
  };
}

/** Steps to `targetPly` along the active line, exiting the sideline when stepping before its anchor. */
export function stepInLine(
  mainline: readonly string[],
  cursor: ReviewCursor,
  targetPly: number,
): ReviewCursor {
  if (!cursor.sideline) {
    return { ply: clamp(targetPly, 0, mainline.length), sideline: null };
  }
  const { anchor, moves } = cursor.sideline;
  if (targetPly < anchor) {
    return { ply: clamp(targetPly, 0, mainline.length), sideline: null };
  }
  return {
    ply: anchor,
    sideline: { anchor, moves, offset: clamp(targetPly - anchor, 0, moves.length) },
  };
}

/** Jumps directly to a mainline ply, discarding any active sideline. */
export function selectMainline(mainline: readonly string[], targetPly: number): ReviewCursor {
  return { ply: clamp(targetPly, 0, mainline.length), sideline: null };
}

/** Returns from an active sideline to its branching point on the mainline. */
export function exitSideline(cursor: ReviewCursor): ReviewCursor {
  return { ply: cursor.sideline ? cursor.sideline.anchor : cursor.ply, sideline: null };
}

/**
 * Plays a legal SAN move from the current review position.
 * Follows the mainline when the move matches it; otherwise opens or extends a sideline.
 */
export function playMoveInReview(
  mainline: readonly string[],
  cursor: ReviewCursor,
  san: string,
): ReviewCursor {
  if (!cursor.sideline) {
    if (mainline[cursor.ply] === san) return { ply: cursor.ply + 1, sideline: null };
    return {
      ply: cursor.ply,
      sideline: { anchor: cursor.ply, moves: [san], offset: 1 },
    };
  }
  const { anchor, moves, offset } = cursor.sideline;
  if (offset === 0 && mainline[anchor] === san) {
    return { ply: anchor + 1, sideline: null };
  }
  if (moves[offset] === san) {
    return { ply: anchor, sideline: { anchor, moves, offset: offset + 1 } };
  }
  return {
    ply: anchor,
    sideline: { anchor, moves: [...moves.slice(0, offset), san], offset: offset + 1 },
  };
}

/**
 * Loads a variation starting from `mainline.slice(0, anchor)` plus optional `prefix` moves,
 * validating legality and landing at `step` (1-indexed within `variation`).
 * Moves that match the mainline are absorbed into the anchor so no redundant sideline is created.
 */
export function playVariationFrom(
  mainline: readonly string[],
  anchor: number,
  prefix: readonly string[],
  variation: readonly string[],
  step = variation.length,
): ReviewCursor | null {
  const safeAnchor = clamp(anchor, 0, mainline.length);
  const board: Chess = replay([...mainline.slice(0, safeAnchor), ...prefix]);
  const legalVariation: string[] = [];
  for (const san of variation) {
    try {
      const moved = board.move(san);
      legalVariation.push(moved.san);
    } catch {
      break;
    }
  }
  if (!legalVariation.length) return null;

  const combined = [...prefix, ...legalVariation];
  const targetIndex = prefix.length + clamp(step, 1, legalVariation.length);

  // Absorb any leading moves that coincide with the mainline.
  let shared = 0;
  while (shared < combined.length && mainline[safeAnchor + shared] === combined[shared]) {
    shared++;
  }
  const nextAnchor = safeAnchor + shared;
  const branch = combined.slice(shared);
  if (!branch.length) {
    return { ply: safeAnchor + targetIndex, sideline: null };
  }
  if (targetIndex < shared) {
    // Clicked a move that is still on the mainline before the variation diverges; keep the branch ready.
    return {
      ply: safeAnchor + targetIndex,
      sideline: null,
    };
  }
  return {
    ply: nextAnchor,
    sideline: {
      anchor: nextAnchor,
      moves: branch,
      offset: targetIndex - shared,
    },
  };
}
