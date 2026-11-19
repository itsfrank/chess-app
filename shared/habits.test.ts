import { expect, it } from 'vitest';
import { findHabits, isCommon, traceGame, type HabitGame } from './habits.ts';
import { buildGraph } from './repertoire.ts';

/** White meets 1...Nf6 with 2.Nf3 and 3.c4, but takes on d5 in the other move order. */
const graph = buildGraph(
  '1. d4 d5 (1... Nf6 2. Nf3 d5 3. c4 e6 4. g3) 2. c4 Nf6 3. cxd5 Nxd5 4. e4 *',
  'white',
);
const game = (line: string, day = 1): HabitGame => ({
  url: `https://example.com/${line.replace(/ /g, '-')}-${day}`,
  playedAt: `2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`,
  moves: line.split(' '),
});

it('follows a game through the repertoire and says how it left', () => {
  expect(traceGame(graph, ['d4', 'd5', 'c4', 'Nf6', 'Nc3', 'e6'])).toMatchObject({
    plies: 4,
    exit: 'deviation',
    played: 'Nc3',
    expected: ['cxd5'],
  });
  expect(traceGame(graph, ['d4', 'e6', 'c4'])).toMatchObject({
    plies: 1,
    exit: 'uncovered',
    played: 'e6',
  });
  expect(traceGame(graph, 'd4 d5 c4 Nf6 cxd5 Nxd5 e4 Nb6'.split(' '))).toMatchObject({
    plies: 7,
    exit: 'line-end',
    played: 'Nb6',
  });
  expect(traceGame(graph, ['d4', 'd5'])).toMatchObject({ plies: 2, exit: 'game-end' });
  expect(traceGame(graph, [])).toMatchObject({ plies: 0, exit: 'game-end', expected: ['d4'] });
});

it('treats another move order into a known position as following the repertoire', () => {
  // 3.Nf3 is not the repertoire move after 1.d4 d5 2.c4 Nf6, but the position is in it.
  const trace = traceGame(graph, 'd4 d5 c4 Nf6 Nf3 e6 g3 Be7'.split(' '));
  expect(trace).toMatchObject({ plies: 7, exit: 'line-end' });
  expect(trace.followed).toHaveLength(3);
});

it('counts the moves played instead of the repertoire’s, most frequent first', () => {
  const { games, exits, habits } = findHabits(graph, [
    game('d4 d5 c4 Nf6 Nc3 e6', 3),
    game('d4 d5 c4 Nf6 Nc3 c6', 5),
    game('d4 d5 c4 Nf6 cxd5 Nxd5 e4 Nb6', 4),
    game('d4 Nf6 c4 e6', 6),
    game('d4 e6', 7),
  ]);
  expect(games).toBe(5);
  expect(exits).toEqual({ deviation: 3, uncovered: 1, 'line-end': 1, 'game-end': 0 });
  expect(habits.map(habit => [habit.finding.current, habit.finding.proposed, habit.count])).toEqual(
    [
      ['cxd5', 'Nc3', 2],
      ['Nf3', 'c4', 1],
    ],
  );
  const [usual, once] = habits;
  expect(usual.followed).toBe(1);
  expect(usual.games.map(played => played.playedAt.slice(8, 10))).toEqual(['05', '03']);
  expect(usual.finding.id).toBe(`${usual.finding.key}|cxd5|Nc3`);
  expect(isCommon(usual)).toBe(true);
  expect(isCommon(once)).toBe(false);
});
