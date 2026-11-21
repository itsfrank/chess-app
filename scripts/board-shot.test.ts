import { describe, expect, it } from 'vitest';
import {
  parseEval,
  parseMovesString,
  renderBoardHtml,
  renderBoardSvg,
  resolveBoard,
} from './board-render.ts';

describe('board-render', () => {
  it('parses PGN fragments with numbers, comments, variations, NAGs, and results', () => {
    const pgn = `[Event "Test"]
      1. d4 Nf6 (1... d5 2. c4 (2. Nf3 e6)) 2. Nf3! g6 {KID} 3. c4 Bg7 4. g3 d6 $1 5. Bg2 O-O 6. O-O c5 1-0`;
    expect(parseMovesString(pgn)).toEqual([
      'd4',
      'Nf6',
      'Nf3',
      'g6',
      'c4',
      'Bg7',
      'g3',
      'd6',
      'Bg2',
      'O-O',
      'O-O',
      'c5',
    ]);
  });

  it('resolves SAN arrows, UCI arrows, styles, and labels containing colons', () => {
    const resolved = resolveBoard({
      moves: '1. d4 Nf6 2. Nf3 g6 3. c4 Bg7 4. g3 d6 5. Bg2 O-O 6. O-O c5',
      arrows: [
        'Nc3:red:Remove: 7. Nc3 (+0.37)',
        '7. d5:green:Replace: 7. d5 (+0.40)',
        'c8->b7:blue/dashed:Pressure',
      ],
    });
    expect(resolved.turn).toBe('white');
    expect(resolved.lastMove).toEqual({ from: 'c7', to: 'c5' });
    expect(resolved.arrows).toEqual([
      {
        from: 'b1',
        to: 'c3',
        color: '#e03e4b',
        label: 'Remove: 7. Nc3 (+0.37)',
        style: 'solid',
      },
      {
        from: 'd4',
        to: 'd5',
        color: '#22b14c',
        label: 'Replace: 7. d5 (+0.40)',
        style: 'solid',
      },
      {
        from: 'c8',
        to: 'b7',
        color: '#60a5fa',
        label: 'Pressure',
        style: 'dashed',
      },
    ]);
  });

  it('resolves multi-square highlights and auto-colored badges', () => {
    const resolved = resolveBoard({
      moves: 'd4 d5 c4 c6 Nf3 Bg4',
      highlights: ['d5,e5:blue:Center'],
      badges: ['g4:?!'],
      lastMove: false,
    });
    expect(resolved.lastMove).toBeNull();
    expect(resolved.highlights).toEqual([
      { square: 'd5', color: '#60a5fa', label: 'Center' },
      { square: 'e5', color: '#60a5fa', label: undefined },
    ]);
    expect(resolved.badges).toEqual([{ square: 'g4', glyph: '?!', color: '#f5dc50' }]);
  });

  it('parses centipawn and mate eval scores', () => {
    expect(parseEval('+0.86').label).toBe('+0.86');
    expect(parseEval('+0.86').whitePct).toBeGreaterThan(50);
    expect(parseEval(-1.5).label).toBe('-1.50');
    expect(parseEval(-1.5).whitePct).toBeLessThan(50);
    expect(parseEval('M3')).toEqual({ label: 'M3', whitePct: 100 });
    expect(parseEval('-m2')).toEqual({ label: '-M2', whitePct: 0 });
    expect(() => parseEval('not-an-eval')).toThrow(/Invalid eval/);
  });

  it('throws clear errors for illegal moves or unknown colors', () => {
    expect(() => resolveBoard({ moves: 'e4 e5 Qh9' })).toThrow(/Illegal move "Qh9"/);
    expect(() => resolveBoard({ moves: 'e4', arrows: ['e5:notacolor'] })).toThrow(/Unknown color/);
  });

  it('renders escaped HTML and suppresses duplicate "to move" pill', () => {
    const { html, resolved } = renderBoardHtml({
      moves: 'e4 c5',
      title: 'Sicilian <Test> — White to move',
      arrows: [{ san: 'Nf3', color: 'green', label: '2. Nf3 <main>' }],
      eval: '+0.20',
    });
    expect(resolved.showTurn).toBe(false);
    expect(html).toContain('Sicilian &lt;Test&gt; — White to move');
    expect(html).toContain('2. Nf3 &lt;main&gt;');
    expect(html).not.toContain('<span class="turn-pill">');
  });

  it('renders standalone SVG with pieces and arrows', () => {
    const { svg } = renderBoardSvg({
      moves: 'e4 e5',
      arrows: ['Nf3:green'],
      flip: true,
    });
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 800 800"');
    expect(svg).toContain('polygon points=');
  });
});
