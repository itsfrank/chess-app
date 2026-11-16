import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { analysisArrows, formatLine, lineColors, scoreText, whiteShare } from './analysis';

describe('position analysis presentation', () => {
  it('numbers continuations from either side to move', () => {
    const board = new Chess();
    expect(formatLine(board.fen(), ['e4', 'e5', 'Nf3'])).toEqual(['1. e4', 'e5', '2. Nf3']);
    board.move('e4');
    expect(formatLine(board.fen(), ['e5', 'Nf3', 'Nc6'])).toEqual(['1... e5', '2. Nf3', 'Nc6']);
  });
  it('maps the current position’s first three candidates to colored board arrows', () => {
    const board = new Chess();
    board.move('e4');
    expect(analysisArrows(board.fen(), ['e5', 'c5', 'Nf6', 'd5'])).toEqual([
      { from: 'e7', to: 'e5', color: lineColors[0], id: 'analysis-0' },
      { from: 'c7', to: 'c5', color: lineColors[1], id: 'analysis-1' },
      { from: 'g8', to: 'f6', color: lineColors[2], id: 'analysis-2' },
    ]);
    expect(analysisArrows(board.fen(), ['invalid'])).toEqual([]);
  });
  it('formats scores from White’s perspective and sizes the evaluation bar', () => {
    expect(scoreText({ type: 'cp', value: 34 })).toBe('+0.3');
    expect(scoreText({ type: 'cp', value: -120 })).toBe('−1.2');
    expect(scoreText({ type: 'cp', value: 0 })).toBe('0.0');
    expect(scoreText({ type: 'mate', value: -3 })).toBe('−M3');
    expect(scoreText({ type: 'mate', value: 0, winner: 'black' })).toBe('Black wins');
    expect(whiteShare(undefined)).toBe(50);
    expect(whiteShare({ type: 'cp', value: 0 })).toBe(50);
    expect(whiteShare({ type: 'cp', value: 400 })).toBeGreaterThan(70);
    expect(whiteShare({ type: 'mate', value: 2 })).toBe(100);
    expect(whiteShare({ type: 'mate', value: 0, winner: 'black' })).toBe(0);
  });
});
