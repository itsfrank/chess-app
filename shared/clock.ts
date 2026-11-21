/** PGN `[%clk]` clock parsing, think-time calculation, and time-management helpers. */

/** Parsed base time and per-move increment in seconds. */
export type TimeControl = { base: number; increment: number };

const HEADER_LINE = /^\[[^\]]*\]\s*$/gm;
const CLK_TAG = /\[%clk\s+(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?\]/g;

/**
 * Extracts remaining clock times (in seconds) in ply order from a PGN's `{[%clk …]}` comments.
 * Returns undefined when the PGN has no clock annotations.
 */
export function parsePgnClocks(pgn: string, moveCount: number): number[] | undefined {
  if (moveCount <= 0) return undefined;
  const movetext = pgn.replace(HEADER_LINE, '');
  const clocks: number[] = [];
  for (const comment of movetext.matchAll(/\{[^}]*\}/g)) {
    for (const match of comment[0].matchAll(CLK_TAG)) {
      const [, first, second, third] = match;
      const seconds =
        third !== undefined
          ? Number(first) * 3600 + Number(second) * 60 + Number(third)
          : Number(first) * 60 + Number(second);
      if (Number.isFinite(seconds) && seconds >= 0) {
        clocks.push(Number(seconds.toFixed(1)));
      }
    }
  }
  if (!clocks.length) return undefined;
  return clocks.slice(0, moveCount);
}

/** Parses chess.com time controls like `"600"` or `"180+2"`. Returns null for daily games. */
export function parseTimeControl(control: string): TimeControl | null {
  const match = control.trim().match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  const base = Number(match[1]);
  const increment = Number(match[2] ?? 0);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(increment) || increment < 0) {
    return null;
  }
  return { base, increment };
}

/**
 * Seconds spent thinking on each ply, computed from the mover's previous remaining clock plus
 * any increment. Returns null for plies whose clock or time control is unavailable.
 */
export function moveThinkTimes(
  clocks: readonly number[] | undefined,
  timeControl: string,
): (number | null)[] {
  if (!clocks?.length) return [];
  const parsed = parseTimeControl(timeControl);
  return clocks.map((remaining, ply) => {
    const prev = ply < 2 ? parsed?.base : clocks[ply - 2];
    if (prev === undefined) return null;
    const increment = ply >= 2 && parsed ? parsed.increment : 0;
    return Number(Math.max(0, prev + increment - remaining).toFixed(1));
  });
}

/** Both sides' remaining clock times at `ply` (0 = start of game, before move 1). */
export function clocksAtPly(
  clocks: readonly number[] | undefined,
  timeControl: string,
  ply: number,
): { white: number | null; black: number | null } {
  if (!clocks?.length) return { white: null, black: null };
  const base = parseTimeControl(timeControl)?.base ?? null;
  if (ply <= 0) return { white: base, black: base };
  const lastIndex = Math.min(ply - 1, clocks.length - 1);
  const lastWhite = lastIndex % 2 === 0 ? lastIndex : lastIndex - 1;
  const lastBlack = lastIndex % 2 === 1 ? lastIndex : lastIndex - 1;
  return {
    white: lastWhite >= 0 ? clocks[lastWhite] : base,
    black: lastBlack >= 0 ? clocks[lastBlack] : base,
  };
}

/** Formats remaining clock seconds as `M:SS`, `0:SS.d` under 20s when fractional, or `H:MM:SS`. */
export function formatClock(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped >= 3600) {
    const whole = Math.floor(clamped);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  if (clamped < 20 && Math.abs(clamped - Math.round(clamped)) >= 0.05) {
    return `0:${clamped.toFixed(1).padStart(4, '0')}`;
  }
  const whole = Math.floor(clamped);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Formats a think-time duration like `3s`, `42s`, or `1m 18s`. */
export function formatThinkTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped < 60) {
    const rounded =
      clamped < 10 && Math.abs(clamped - Math.round(clamped)) >= 0.05
        ? clamped.toFixed(1)
        : String(Math.round(clamped));
    return `${rounded}s`;
  }
  const whole = Math.round(clamped);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/** True when the player is critically low on time (under 30s or 10% of base time). */
export function isTimeTrouble(remaining: number, base: number | null): boolean {
  const threshold = base ? Math.min(30, Math.max(10, base * 0.1)) : 30;
  return remaining <= threshold;
}

/** True when a mistake was played almost instantly despite plenty of time on the clock. */
export function isImpulsiveError(
  spent: number | null,
  remaining: number,
  base: number | null,
): boolean {
  if (spent === null || base === null || base < 180) return false;
  if (isTimeTrouble(remaining, base)) return false;
  return spent <= 3 && remaining > Math.max(60, base * 0.2);
}

/** True when a mistake followed a long think in a non-bullet game. */
export function isDeepThinkError(spent: number | null, base: number | null): boolean {
  if (spent === null || base === null || base < 180) return false;
  return spent >= Math.max(25, base * 0.08);
}
