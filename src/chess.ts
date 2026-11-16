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
