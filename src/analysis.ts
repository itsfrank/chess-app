import { Chess } from 'chess.js';
import type { Annotation, Evaluation } from '../shared/protocol';

/** Colours of the top three candidate lines, shared by the panel's dots and the board arrows. */
export const lineColors = ['#60a5fa', '#f5dc50', '#f472ce'];

/** Adds move numbers to a SAN continuation starting from `fen`: "1. e4", "e5", "2. Nf3". */
export function formatLine(fen: string, moves: string[]): string[] {
  const board = new Chess(fen);
  return moves.map((move, index) => {
    const number = board.moveNumber();
    const prefix = board.turn() === 'w' ? `${number}. ` : index === 0 ? `${number}... ` : '';
    try {
      board.move(move);
    } catch {
      // Keep the remaining notation readable if a line is incomplete.
    }
    return prefix + move;
  });
}

/** Board arrows for the first three candidate moves that are legal in `fen`. */
export function analysisArrows(fen: string, moves: string[]): Annotation[] {
  return moves.slice(0, lineColors.length).flatMap((san, index) => {
    try {
      const move = new Chess(fen).move(san);
      return [{ from: move.from, to: move.to, color: lineColors[index], id: `analysis-${index}` }];
    } catch {
      return [];
    }
  });
}

/** A White-perspective score as text: "+0.3", "−1.2", "+M3", or the winner at mate. */
export function scoreText(score: Evaluation): string {
  const sign = score.value > 0 ? '+' : score.value < 0 ? '−' : '';
  if (score.type === 'cp') return sign + (Math.abs(score.value) / 100).toFixed(1);
  if (score.value === 0) return score.winner === 'white' ? 'White wins' : 'Black wins';
  return `${sign}M${Math.abs(score.value)}`;
}

/** How much of the evaluation bar White fills, from 0 to 100. */
export function whiteShare(score: Evaluation | undefined): number {
  if (!score) return 50;
  if (score.type === 'mate') return score.value > 0 || score.winner === 'white' ? 100 : 0;
  // Logistic curve: about ±4 pawns already fills most of the bar.
  return 50 + 50 * (2 / (1 + Math.exp(-score.value / 400)) - 1);
}
