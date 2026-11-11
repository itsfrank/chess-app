import { Chess, type Square } from 'chess.js';

export type Promotion = 'q' | 'r' | 'b' | 'n';
export function legalTargets(game: Chess, from: Square): Square[] {
  return game.moves({ square: from, verbose: true }).map(move => move.to);
}
export function needsPromotion(game: Chess, from: Square, to: Square): boolean {
  return game.moves({ square: from, verbose: true }).some(move => move.to === to && !!move.promotion);
}
export function tryMove(game: Chess, from: Square, to: Square, promotion?: Promotion): boolean {
  try { game.move({ from, to, promotion }); return true; } catch { return false; }
}
export function squareCenter(square: Square, flipped: boolean): [number, number] {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return [(flipped ? 7 - file : file) * 100 + 50, (flipped ? rank : 7 - rank) * 100 + 50];
}
