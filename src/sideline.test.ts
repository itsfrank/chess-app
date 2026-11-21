import { describe, expect, it } from 'vitest';
import {
  activeLineOf,
  exitSideline,
  playMoveInReview,
  playVariationFrom,
  selectMainline,
  shownMovesOf,
  stepInLine,
  type ReviewCursor,
} from './sideline';

const mainline = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];

describe('review sidelines', () => {
  it('follows the mainline when the played move matches it, otherwise starts a sideline', () => {
    let cursor: ReviewCursor = { ply: 2, sideline: null };
    cursor = playMoveInReview(mainline, cursor, 'Nf3');
    expect(cursor).toEqual({ ply: 3, sideline: null });

    cursor = playMoveInReview(mainline, cursor, 'Nf6');
    expect(cursor).toEqual({ ply: 3, sideline: { anchor: 3, moves: ['Nf6'], offset: 1 } });
    expect(shownMovesOf(mainline, cursor)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);

    cursor = playMoveInReview(mainline, cursor, 'Nxe5');
    expect(cursor).toEqual({
      ply: 3,
      sideline: { anchor: 3, moves: ['Nf6', 'Nxe5'], offset: 2 },
    });
    expect(activeLineOf(mainline, cursor)).toEqual({
      moves: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5'],
      ply: 5,
    });
  });

  it('steps back and forward within a sideline and exits when stepping before the anchor', () => {
    const start: ReviewCursor = {
      ply: 2,
      sideline: { anchor: 2, moves: ['Bc4', 'Nf6', 'd3'], offset: 2 },
    };
    expect(shownMovesOf(mainline, start)).toEqual(['e4', 'e5', 'Bc4', 'Nf6']);

    // Stepping back to offset 0 keeps the sideline alive so Right arrow re-enters it.
    const atAnchor = stepInLine(mainline, start, 2);
    expect(atAnchor).toEqual({
      ply: 2,
      sideline: { anchor: 2, moves: ['Bc4', 'Nf6', 'd3'], offset: 0 },
    });
    expect(shownMovesOf(mainline, atAnchor)).toEqual(['e4', 'e5']);

    // Stepping forward re-enters the sideline.
    expect(stepInLine(mainline, atAnchor, 3)).toEqual({
      ply: 2,
      sideline: { anchor: 2, moves: ['Bc4', 'Nf6', 'd3'], offset: 1 },
    });

    // Stepping before the anchor exits back to the mainline.
    expect(stepInLine(mainline, atAnchor, 1)).toEqual({ ply: 1, sideline: null });

    // Playing a different move mid-sideline replaces the tail.
    const branched = playMoveInReview(mainline, stepInLine(mainline, start, 3), 'Bc5');
    expect(branched).toEqual({
      ply: 2,
      sideline: { anchor: 2, moves: ['Bc4', 'Bc5'], offset: 2 },
    });

    // Exiting returns to the anchor; selecting mainline jumps directly.
    expect(exitSideline(start)).toEqual({ ply: 2, sideline: null });
    expect(selectMainline(mainline, 5)).toEqual({ ply: 5, sideline: null });
  });

  it('loads a variation from a position, absorbing moves that already match the mainline', () => {
    // Full divergence from ply 4 (after 2...Nc6): plays 3. Bc4 Bc5 4. c3, clicking step 2 (Bc5).
    const diverged = playVariationFrom(mainline, 4, [], ['Bc4', 'Bc5', 'c3'], 2);
    expect(diverged).toEqual({
      ply: 4,
      sideline: { anchor: 4, moves: ['Bc4', 'Bc5', 'c3'], offset: 2 },
    });
    expect(shownMovesOf(mainline, diverged!)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);

    // Partially matching mainline (3. Bb5 matches mainline[4], then 3...Nf6 diverges).
    const partial = playVariationFrom(mainline, 4, [], ['Bb5', 'Nf6', 'O-O'], 2);
    expect(partial).toEqual({
      ply: 5,
      sideline: { anchor: 5, moves: ['Nf6', 'O-O'], offset: 1 },
    });

    // Fully matching mainline creates no sideline.
    const onMainline = playVariationFrom(mainline, 4, [], ['Bb5', 'a6'], 2);
    expect(onMainline).toEqual({ ply: 6, sideline: null });

    // Extending from an existing sideline prefix.
    const nested = playVariationFrom(mainline, 4, ['Bc4'], ['Nf6', 'Ng5'], 2);
    expect(nested).toEqual({
      ply: 4,
      sideline: { anchor: 4, moves: ['Bc4', 'Nf6', 'Ng5'], offset: 3 },
    });

    // Rejects illegal variations cleanly.
    expect(playVariationFrom(mainline, 4, [], ['Qxh8'], 1)).toBeNull();
  });
});
