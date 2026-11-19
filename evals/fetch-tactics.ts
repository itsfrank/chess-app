/**
 * Picks multi-move tactics from the Lichess puzzle database (CC0) and writes
 * them to `evals/tactics.json`. Each needs at least two moves from the solver,
 * so the point is a sequence, such as a forcing move that sets up a fork, not
 * a capture that is there to be seen.
 *
 *   curl -sL https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -dc | head -n 60000 > puzzles.csv
 *   npx tsx evals/fetch-tactics.ts puzzles.csv [count]
 *
 * The database has positions only; the game each comes from is fetched from
 * Lichess so that the companion can be given its moves.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { positionKey } from '../shared/repertoire.ts';

export type Tactic = {
  id: string;
  /** The game up to the position to solve, in SAN. */
  moves: string[];
  /** The solver's moves and the forced replies, in SAN, starting with the solver. */
  solution: string[];
  themes: string[];
  rating: number;
  source: string;
};

const FILE = fileURLToPath(new URL('./tactics.json', import.meta.url));
const [csv, count] = process.argv.slice(2);
const wanted = Number(count) || 20;
/** Themes whose first move prepares the blow rather than landing it. */
const SETUP = ['attraction', 'deflection', 'intermezzo', 'clearance', 'interference', 'sacrifice'];

type Row = {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  game: string;
};
const rows: Row[] = readFileSync(csv, 'utf8')
  .split('\n')
  .slice(1)
  .map(line => line.split(','))
  .filter(fields => fields.length >= 9)
  .map(([id, fen, moves, rating, , popularity, plays, themes, game]) => ({
    id,
    fen,
    moves: moves.split(' '),
    rating: Number(rating),
    themes: themes.split(' '),
    game,
    popularity: Number(popularity),
    plays: Number(plays),
  }))
  .filter(
    row =>
      row.popularity >= 90 &&
      row.plays >= 2000 &&
      row.rating >= 1300 &&
      row.rating <= 2100 &&
      // The opponent's move, then at least solver, reply, solver.
      row.moves.length >= 4 &&
      !row.themes.some(theme => /mate|promotion|endgame/i.test(theme)),
  );

// Half are forks that have to be set up first; the rest are other prepared blows.
const has = (row: Row, themes: string[]) => themes.some(theme => row.themes.includes(theme));
const forks = rows.filter(row => row.themes.includes('fork') && has(row, SETUP));
const others = rows.filter(
  row => !row.themes.includes('fork') && has(row, [...SETUP, 'discoveredAttack', 'skewer', 'pin']),
);
const picks = [...forks.slice(0, Math.ceil(wanted / 2)), ...others].slice(0, wanted + 6);

const tactics: Tactic[] = [];
for (const row of picks) {
  if (tactics.length >= wanted) break;
  const id = new URL(row.game).pathname.match(/[A-Za-z0-9]{8}/)?.[0];
  if (!id) continue;
  const response = await fetch(
    `https://lichess.org/game/export/${id}?tags=false&clocks=false&evals=false&opening=false`,
    { headers: { Accept: 'application/json', 'User-Agent': 'chess-companion-local/0.1' } },
  );
  await new Promise(resolve => setTimeout(resolve, 1100));
  if (!response.ok) continue;
  const game = ((await response.json()) as { moves: string }).moves.split(' ');
  try {
    // Find the puzzle's position in the game, then play the opponent's move that starts it.
    const board = new Chess();
    let ply = 0;
    while (positionKey(board.fen()) !== positionKey(row.fen)) board.move(game[ply++]);
    const [first, ...solution] = row.moves;
    board.move(first);
    const moves = board.history();
    tactics.push({
      id: row.id,
      moves,
      solution: solution.map(uci => board.move(uci).san),
      themes: row.themes,
      rating: row.rating,
      source: `https://lichess.org/training/${row.id}`,
    });
    console.log(row.id, row.rating, row.themes.join(','), tactics.at(-1)!.solution.join(' '));
  } catch {
    // A game that does not reach the position is no use as a case.
  }
}
writeFileSync(FILE, JSON.stringify(tactics, null, 2) + '\n');
console.log(`${tactics.length} tactics written to ${FILE}`);
