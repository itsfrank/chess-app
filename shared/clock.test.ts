import { describe, expect, it } from 'vitest';
import {
  clocksAtPly,
  formatClock,
  formatThinkTime,
  isDeepThinkError,
  isImpulsiveError,
  isTimeTrouble,
  moveThinkTimes,
  parsePgnClocks,
  parseTimeControl,
} from './clock.ts';

describe('parsePgnClocks', () => {
  it('parses chess.com [%clk] tags in ply order including tenths', () => {
    const pgn = `[Event "Live Chess"]
[TimeControl "600"]

1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:57.5]} 2. Nf3 {[%clk 0:09:40]} 2... Nc6 {[%clk 0:09:30.2]} 1-0`;
    expect(parsePgnClocks(pgn, 4)).toEqual([598, 597.5, 580, 570.2]);
  });

  it('returns undefined when no clock tags are present', () => {
    expect(parsePgnClocks('1. e4 e5 2. Nf3 Nc6 1-0', 4)).toBeUndefined();
  });
});

describe('parseTimeControl and moveThinkTimes', () => {
  it('computes think times with and without increment', () => {
    expect(parseTimeControl('600')).toEqual({ base: 600, increment: 0 });
    expect(parseTimeControl('180+2')).toEqual({ base: 180, increment: 2 });
    expect(parseTimeControl('1/86400')).toBeNull();

    // 3+2 game: White spends 2s on move 1 (178), Black spends 5s (175),
    // White gets +2s then spends 10s (170), Black gets +2s then spends 1s (176)
    expect(moveThinkTimes([178, 175, 170, 176], '180+2')).toEqual([2, 5, 10, 1]);
  });

  it('resolves clocks at any ply', () => {
    const clocks = [598, 595, 580, 570];
    expect(clocksAtPly(clocks, '600', 0)).toEqual({ white: 600, black: 600 });
    expect(clocksAtPly(clocks, '600', 1)).toEqual({ white: 598, black: 600 });
    expect(clocksAtPly(clocks, '600', 2)).toEqual({ white: 598, black: 595 });
    expect(clocksAtPly(clocks, '600', 3)).toEqual({ white: 580, black: 595 });
    expect(clocksAtPly(clocks, '600', 4)).toEqual({ white: 580, black: 570 });
  });
});

describe('formatting and habit classifiers', () => {
  it('formats clocks and think durations cleanly', () => {
    expect(formatClock(598)).toBe('9:58');
    expect(formatClock(14.3)).toBe('0:14.3');
    expect(formatClock(3665)).toBe('1:01:05');
    expect(formatThinkTime(2)).toBe('2s');
    expect(formatThinkTime(75)).toBe('1m 15s');
  });

  it('distinguishes time trouble, impulsive errors, and deep-think errors', () => {
    expect(isTimeTrouble(22, 600)).toBe(true);
    expect(isTimeTrouble(45, 600)).toBe(false);
    expect(isTimeTrouble(15, 180)).toBe(true);

    expect(isImpulsiveError(2, 420, 600)).toBe(true);
    expect(isImpulsiveError(2, 20, 600)).toBe(false); // time trouble, not impulsive
    expect(isImpulsiveError(1, 50, 60)).toBe(false); // bullet excluded

    expect(isDeepThinkError(55, 600)).toBe(true);
    expect(isDeepThinkError(12, 600)).toBe(false);
  });
});
