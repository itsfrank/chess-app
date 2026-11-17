import { Chess, type Square } from 'chess.js';
import type { PlayerColor } from '../shared/protocol';

export type Promotion = 'q' | 'r' | 'b' | 'n';

/** The position reached by playing `moves` (SAN) from the starting position. */
export function replay(moves: readonly string[]): Chess {
  const game = new Chess();
  for (const san of moves) game.move(san);
  return game;
}

/** Whose turn it is after `plies` half-moves from the starting position. */
export const sideToMove = (plies: number): PlayerColor => (plies % 2 === 0 ? 'white' : 'black');

export function legalTargets(game: Chess, from: Square): Square[] {
  return game.moves({ square: from, verbose: true }).map(move => move.to);
}

export function needsPromotion(game: Chess, from: Square, to: Square): boolean {
  return game
    .moves({ square: from, verbose: true })
    .some(move => move.to === to && !!move.promotion);
}

/** SAN for the move if it is legal in `game`, which is left untouched; otherwise null. */
export function sanForMove(
  game: Chess,
  from: Square,
  to: Square,
  promotion?: Promotion,
): string | null {
  try {
    return new Chess(game.fen()).move({ from, to, promotion }).san;
  } catch {
    return null;
  }
}

/** Centre of a square in the 800×800 overlay coordinate system. */
export function squareCenter(square: Square, flipped: boolean): [number, number] {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return [(flipped ? 7 - file : file) * 100 + 50, (flipped ? rank : 7 - rank) * 100 + 50];
}

/** How the game ended, or null while it is still in progress. */
export function gameResult(game: Chess): string | null {
  if (game.isCheckmate()) return 'Checkmate';
  if (game.isStalemate()) return 'Draw · Stalemate';
  if (game.isThreefoldRepetition()) return 'Draw · Repetition';
  if (game.isInsufficientMaterial()) return 'Draw · Insufficient material';
  if (game.isDraw()) return 'Draw · Fifty-move rule';
  return null;
}

/** Where a position sits in the game: the half-moves played to reach it and the move that did. */
export type PositionInfo = { ply: number; label: string };

/**
 * Every position of the game keyed by FEN, labelled like a scoresheet:
 * "11. Nf1" for White's moves and "11… Be6" for Black's. A repeated
 * position keeps its latest occurrence.
 */
export function gamePositions(moves: readonly string[]): Map<string, PositionInfo> {
  const game = new Chess();
  const positions = new Map([[game.fen(), { ply: 0, label: 'Starting position' }]]);
  moves.forEach((san, index) => {
    game.move(san);
    const label = `${Math.floor(index / 2) + 1}${index % 2 === 0 ? '.' : '…'} ${san}`;
    positions.set(game.fen(), { ply: index + 1, label });
  });
  return positions;
}
