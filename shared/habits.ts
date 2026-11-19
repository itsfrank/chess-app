/**
 * Compares the games a player actually played with their repertoire: where
 * each game left it, and which moves they keep playing instead of the
 * repertoire's.
 */
import { proposeChange, type Finding } from './consolidation.ts';
import { isMine, playMove, type Graph, type RepNode } from './repertoire.ts';

/** How a game stopped following a repertoire. */
export type Trace = {
  /** Half-moves played inside the repertoire. */
  plies: number;
  /** The last repertoire position of the game. */
  key: string;
  /**
   * `deviation`: the player chose a move the repertoire does not have.
   * `uncovered`: the opponent did. `line-end`: the repertoire has nothing more
   * here. `game-end`: the game ended inside it.
   */
  exit: 'deviation' | 'uncovered' | 'line-end' | 'game-end';
  /** The move that left the repertoire, and what the repertoire has there. */
  played?: string;
  expected: string[];
  /** Positions on the way where the player played the repertoire's move. */
  followed: string[];
};

/**
 * Follows `moves` through the repertoire. A move that is not in it but lands
 * on a position that is counts as following: only the move order differs.
 */
export function traceGame(graph: Graph, moves: readonly string[]): Trace {
  let node: RepNode = graph.nodes[graph.root];
  const followed: string[] = [];
  for (let ply = 0; ply < moves.length; ply++) {
    const san = moves[ply];
    const edge = node.moves.find(move => move.san === san);
    const next = graph.nodes[edge?.to ?? playMove(node.fen, san)?.move.to ?? ''];
    if (!next) {
      const exit = !node.moves.length
        ? 'line-end'
        : isMine(graph, node)
          ? 'deviation'
          : 'uncovered';
      return { plies: ply, key: node.key, exit, played: san, expected: sans(node), followed };
    }
    if (edge && isMine(graph, node)) followed.push(node.key);
    node = next;
  }
  return { plies: moves.length, key: node.key, exit: 'game-end', expected: sans(node), followed };
}
const sans = (node: RepNode) => node.moves.map(move => move.san);

/** A game reduced to what the comparison needs. */
export type HabitGame = { url: string; playedAt: string; moves: string[] };

/** A move the player made instead of the repertoire's, as a proposal to adopt it. */
export type Habit = {
  /** Replacing the repertoire move with the one played. */
  finding: Finding;
  /** Games in which the player made this move here. */
  count: number;
  /** Games in which they played the repertoire move here instead. */
  followed: number;
  /** Those games, most recent first. */
  games: { url: string; playedAt: string }[];
};

export type Habits = {
  /** Games compared, and how each left the repertoire. */
  games: number;
  exits: Record<Trace['exit'], number>;
  /** Most played first. */
  habits: Habit[];
};

/** Counts the player's own departures from the repertoire over `games`, all played as its side. */
export function findHabits(graph: Graph, games: HabitGame[]): Habits {
  const exits: Habits['exits'] = { deviation: 0, uncovered: 0, 'line-end': 0, 'game-end': 0 };
  const followed = new Map<string, number>();
  const played = new Map<string, { key: string; san: string; games: HabitGame[] }>();
  for (const game of games) {
    const trace = traceGame(graph, game.moves);
    exits[trace.exit]++;
    for (const key of trace.followed) followed.set(key, (followed.get(key) ?? 0) + 1);
    if (trace.exit !== 'deviation') continue;
    const id = `${trace.key}|${trace.played}`;
    let entry = played.get(id);
    if (!entry) played.set(id, (entry = { key: trace.key, san: trace.played!, games: [] }));
    entry.games.push(game);
  }
  const habits = [...played.values()].flatMap((entry): Habit[] => {
    // Where the repertoire offers a choice, the first move is the one to give up.
    const current = graph.nodes[entry.key].moves[0].san;
    const finding = proposeChange(graph, entry.key, current, entry.san);
    if (!finding) return [];
    const recent = [...entry.games].sort((a, b) => b.playedAt.localeCompare(a.playedAt));
    return [
      {
        finding,
        count: recent.length,
        followed: followed.get(entry.key) ?? 0,
        games: recent.map(({ url, playedAt }) => ({ url, playedAt })),
      },
    ];
  });
  habits.sort((a, b) => b.count - a.count || a.followed - b.followed);
  return { games: games.length, exits, habits };
}

/** A habit worth adopting: played more than once, and at least as often as the repertoire move. */
export const isCommon = (habit: Habit) => habit.count >= 2 && habit.count >= habit.followed;
