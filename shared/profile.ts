/** Cross-game player profile aggregation and compact digest formatting for the coach. */
import { Chess } from 'chess.js';
import {
  isDeepThinkError,
  isImpulsiveError,
  isTimeTrouble,
  moveThinkTimes,
  parseTimeControl,
} from './clock.ts';
import type {
  ArchivedGame,
  ClockHabits,
  OpeningStat,
  PhaseErrors,
  PlayerColor,
  PlayerProfile,
  RecordSplit,
} from './protocol.ts';
import { ERROR_LOSS, type GameReview } from './quality.ts';

const PIECE_VALUES: Record<string, number> = { n: 3, b: 3, r: 5, q: 9 };
/** Non-pawn material threshold (both sides combined) below which a position counts as endgame. */
const ENDGAME_MATERIAL = 26;
/** Half-moves up to which non-endgame positions count as the opening phase. */
const OPENING_PLIES = 16;

const emptySplit = (): RecordSplit => ({ games: 0, wins: 0, draws: 0, losses: 0 });

function recordOutcome(split: RecordSplit, game: ArchivedGame): 'win' | 'draw' | 'loss' {
  split.games++;
  if (game.result === '1/2-1/2') {
    split.draws++;
    return 'draw';
  }
  const won = (game.result === '1-0') === (game.playerColor === 'white');
  if (won) {
    split.wins++;
    return 'win';
  }
  split.losses++;
  return 'loss';
}

function scoreRate(split: RecordSplit): number {
  return split.games ? (split.wins + split.draws * 0.5) / split.games : 0;
}

function nonPawnMaterial(board: Chess): number {
  let total = 0;
  for (const row of board.board()) {
    for (const square of row) {
      if (square) total += PIECE_VALUES[square.type] ?? 0;
    }
  }
  return total;
}

function phaseForMove(ply: number, board: Chess, isBook: boolean): keyof PhaseErrors {
  if (isBook || ply < OPENING_PLIES) return 'opening';
  if (nonPawnMaterial(board) <= ENDGAME_MATERIAL) return 'endgame';
  return 'middlegame';
}

const average = (values: number[]): number | null =>
  values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : null;

/**
 * Aggregates recent games and any cached Stockfish reviews into a cross-game player profile.
 * `reviews` maps `game.url` to its finished `GameReview`.
 */
export function buildPlayerProfile(
  username: string,
  games: ArchivedGame[],
  reviews: Map<string, GameReview> = new Map(),
): PlayerProfile {
  const overall = emptySplit();
  const white = emptySplit();
  const black = emptySplit();
  const openingMap = new Map<string, OpeningStat>();
  let timeoutLosses = 0;

  const accuracyAll: number[] = [];
  const accuracyWhite: number[] = [];
  const accuracyBlack: number[] = [];
  const errorCounts = { inaccuracies: 0, mistakes: 0, blunders: 0 };
  const phaseErrors: PhaseErrors = { opening: 0, middlegame: 0, endgame: 0 };
  const clockHabits: ClockHabits = {
    timedErrors: 0,
    timeTroubleErrors: 0,
    impulsiveErrors: 0,
    deepThinkErrors: 0,
  };
  let reviewedGames = 0;

  for (const game of games) {
    const outcome = recordOutcome(overall, game);
    recordOutcome(game.playerColor === 'white' ? white : black, game);
    if (outcome === 'loss' && /\bon time\b/i.test(game.termination)) {
      timeoutLosses++;
    }
    if (game.opening) {
      const key = `${game.playerColor}:${game.opening}`;
      let stat = openingMap.get(key);
      if (!stat) {
        stat = { name: game.opening, color: game.playerColor, ...emptySplit() };
        openingMap.set(key, stat);
      }
      recordOutcome(stat, game);
    }

    const review = reviews.get(game.url);
    if (!review) continue;
    reviewedGames++;

    const sideReview = review[game.playerColor];
    if (sideReview.accuracy !== null) {
      accuracyAll.push(sideReview.accuracy);
      (game.playerColor === 'white' ? accuracyWhite : accuracyBlack).push(sideReview.accuracy);
    }
    errorCounts.inaccuracies += sideReview.counts.inaccuracy;
    errorCounts.mistakes += sideReview.counts.mistake;
    errorCounts.blunders += sideReview.counts.blunder;

    const thinkTimes = moveThinkTimes(game.clocks, game.timeControl);
    const base = parseTimeControl(game.timeControl)?.base ?? null;
    const board = new Chess();
    for (let ply = 0; ply < game.moves.length; ply++) {
      const mover: PlayerColor = ply % 2 === 0 ? 'white' : 'black';
      const move = review.moves[ply];
      if (mover === game.playerColor && move && move.loss > ERROR_LOSS) {
        const phase = phaseForMove(ply, board, move.quality.id === 'book');
        phaseErrors[phase]++;
        const remaining = game.clocks?.[ply];
        if (remaining !== undefined) {
          clockHabits.timedErrors++;
          const spent = thinkTimes[ply] ?? null;
          if (isTimeTrouble(remaining, base)) clockHabits.timeTroubleErrors++;
          else if (isImpulsiveError(spent, remaining, base)) clockHabits.impulsiveErrors++;
          else if (isDeepThinkError(spent, base)) clockHabits.deepThinkErrors++;
        }
      }
      try {
        board.move(game.moves[ply]);
      } catch {
        break;
      }
    }
  }

  const allOpenings = [...openingMap.values()];
  const openings = [...allOpenings].sort((a, b) => b.games - a.games).slice(0, 5);
  const weakestOpenings = allOpenings
    .filter(stat => stat.games >= 2 && scoreRate(stat) < 0.5)
    .sort((a, b) => scoreRate(a) - scoreRate(b) || b.games - a.games)
    .slice(0, 4);

  return {
    username,
    generatedAt: new Date().toISOString(),
    gamesAnalyzed: games.length,
    overall,
    white,
    black,
    timeoutLosses,
    openings,
    weakestOpenings,
    reviewedGames,
    avgAccuracy: {
      overall: average(accuracyAll),
      white: average(accuracyWhite),
      black: average(accuracyBlack),
    },
    errorCounts,
    phaseErrors,
    clockHabits,
  };
}

const formatSplit = (split: RecordSplit) => `${split.wins}W-${split.draws}D-${split.losses}L`;

/** Compact summary of `profile` for injecting into the coach's prompt without bloating context. */
export function profileDigest(profile: PlayerProfile) {
  if (!profile.gamesAnalyzed) return null;
  const totalLosses = profile.overall.losses;
  return {
    username: profile.username,
    recentGames: profile.gamesAnalyzed,
    record: {
      overall: formatSplit(profile.overall),
      white: formatSplit(profile.white),
      black: formatSplit(profile.black),
    },
    ...(totalLosses > 0 && {
      timeoutLosses: `${profile.timeoutLosses}/${totalLosses} losses (${Math.round((profile.timeoutLosses / totalLosses) * 100)}%)`,
    }),
    ...(profile.weakestOpenings.length > 0 && {
      strugglingOpenings: profile.weakestOpenings.map(
        stat => `${stat.name} (${stat.color}, ${formatSplit(stat)})`,
      ),
    }),
    ...(profile.reviewedGames > 0 && {
      reviewedGames: profile.reviewedGames,
      avgAccuracy: profile.avgAccuracy,
      errorCounts: profile.errorCounts,
      errorsByPhase: profile.phaseErrors,
      ...(profile.clockHabits.timedErrors > 0 && { clockHabits: profile.clockHabits }),
    }),
  };
}
