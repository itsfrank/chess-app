import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { analysisArrows, formatLine, lineColors } from './Analysis';

describe('position analysis presentation', () => {
  it('numbers continuations from either side to move', () => {
    const board = new Chess();
    expect(formatLine(board.fen(), ['e4', 'e5', 'Nf3'])).toEqual(['1. e4', 'e5', '2. Nf3']);
    board.move('e4');
    expect(formatLine(board.fen(), ['e5', 'Nf3', 'Nc6'])).toEqual(['1... e5', '2. Nf3', 'Nc6']);
  });
  it('maps the current position’s first three candidates to colored board arrows', () => {
    const board = new Chess(); board.move('e4');
    expect(analysisArrows(board.fen(), ['e5', 'c5', 'Nf6', 'd5'])).toEqual([
      { from: 'e7', to: 'e5', color: lineColors[0], id: 'analysis-0' },
      { from: 'c7', to: 'c5', color: lineColors[1], id: 'analysis-1' },
      { from: 'g8', to: 'f6', color: lineColors[2], id: 'analysis-2' },
    ]);
    expect(analysisArrows(board.fen(), ['invalid'])).toEqual([]);
  });
});
