/** SM-2 spaced-repetition scheduler and helpers for mistake drills and Maia3 sparring. */
import { OPPONENT_ELOS, type DrillCard } from './protocol.ts';
import { numberedMove } from './quality.ts';
import { positionKey } from './repertoire.ts';

export const DAY_MS = 86_400_000;
const RETRY_DELAY_MS = 10 * 60_000;
export const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 2.8;

/** Deduplication key for a drill card: position + game move + engine best move. */
export function drillKey(fen: string, played: string, best: string): string {
  return `${positionKey(fen)}|${played}|${best}`;
}

/** True when a drill card is due for review at `nowMs`. */
export function isDrillDue(card: Pick<DrillCard, 'dueAt'>, nowMs = Date.now()): boolean {
  return Date.parse(card.dueAt) <= nowMs;
}

/** Sorts drills so due cards come first (oldest due first), followed by upcoming cards. */
export function sortDrills(cards: readonly DrillCard[], nowMs = Date.now()): DrillCard[] {
  return [...cards].sort((a, b) => {
    const aDue = isDrillDue(a, nowMs);
    const bDue = isDrillDue(b, nowMs);
    if (aDue !== bDue) return aDue ? -1 : 1;
    const dueDiff = Date.parse(a.dueAt) - Date.parse(b.dueAt);
    if (dueDiff !== 0) return dueDiff;
    return b.loss - a.loss;
  });
}

/** Applies one SM-2 review outcome (`solved = true` on clean solve, `false` on miss/reveal). */
export function scheduleDrill(card: DrillCard, solved: boolean, now = new Date()): DrillCard {
  const isoNow = now.toISOString();
  if (solved) {
    const reps = card.reps + 1;
    const intervalDays =
      reps === 1 ? 1 : reps === 2 ? 6 : Math.max(1, Math.round(card.intervalDays * card.ease));
    const ease = Number(Math.min(MAX_EASE, Math.max(MIN_EASE, card.ease + 0.1)).toFixed(2));
    return {
      ...card,
      reps,
      intervalDays,
      ease,
      dueAt: new Date(now.getTime() + intervalDays * DAY_MS).toISOString(),
      lastReviewedAt: isoNow,
      lastResult: 'pass',
    };
  }
  const ease = Number(Math.max(MIN_EASE, card.ease - 0.2).toFixed(2));
  return {
    ...card,
    reps: 0,
    lapses: card.lapses + 1,
    intervalDays: 0,
    ease,
    dueAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
    lastReviewedAt: isoNow,
    lastResult: 'fail',
  };
}

/** Nearest supported Maia3 sparring rating to `rating`, defaulting to 1500. */
export function nearestOpponentElo(
  rating: number | null | undefined,
): (typeof OPPONENT_ELOS)[number] {
  if (!rating || !Number.isFinite(rating)) return 1500;
  let best: (typeof OPPONENT_ELOS)[number] = OPPONENT_ELOS[0];
  let bestDiff = Math.abs(rating - best);
  for (const elo of OPPONENT_ELOS) {
    const diff = Math.abs(rating - elo);
    if (diff < bestDiff) {
      best = elo;
      bestDiff = diff;
    }
  }
  return best;
}

/** Human-readable next-review interval text for a drill card. */
export function formatDueLabel(dueAt: string, nowMs = Date.now()): string {
  const diffMs = Date.parse(dueAt) - nowMs;
  if (diffMs <= 0) return 'Due now';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `In ${Math.max(1, minutes)} min`;
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return `In ${hours}h`;
  const days = Math.round(diffMs / DAY_MS);
  return days === 1 ? 'In 1 day' : `In ${days} days`;
}

/** Prompt sent to the companion when the user asks why a drill's best move works. */
export function drillCoachPrompt(card: DrillCard, attempt: string | null): string {
  const ply = card.moves.length;
  const played = numberedMove(ply, card.played);
  const best = numberedMove(ply, card.best);
  const tried =
    attempt && attempt !== card.best
      ? ` During this drill I tried ${numberedMove(ply, attempt)}.`
      : '';
  return (
    `I'm drilling a ${card.quality} from one of my games. In the game I played ${played} and the engine prefers ${best}.${tried} ` +
    `Briefly explain why ${card.best} works here, what goes wrong after ${card.played}, and one quick visual cue so I spot this pattern next time.`
  );
}
