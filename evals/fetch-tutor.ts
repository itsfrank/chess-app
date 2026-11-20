/**
 * Builds the tutor suite (`evals/tutor.json`) from club-level rapid games in
 * the Lichess database (CC0): questions a player reviewing their own game asks
 * a coach, with reference points worked out from the board and Stockfish.
 *
 *   curl -sL https://database.lichess.org/standard/lichess_db_standard_rated_2026-10.pgn.zst \
 *     | zstd -dc | head -n 400000 > games.pgn
 *   npx tsx evals/fetch-tutor.ts games.pgn [games]
 *
 * Two kinds of question, one of each per game where the game has one:
 * - `mistake`: the player's worst move, asked "why was it bad, what did I miss".
 *   What was missed is found, not guessed: a reply it allowed that wins material
 *   or mates, a threat that was already there (seen by letting the player pass),
 *   or a win the player had and did not take. Mistakes that are none of these
 *   are left out, since what a coach would say about them cannot be checked.
 * - `plan`: a quiet middlegame position with the player to move, where the
 *   engine's choices are close and none is forcing, asked "what should my plan be".
 *
 * Players' names are not kept; each game's Lichess link is.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess, type Color } from 'chess.js';
import { numberedMove } from '../shared/quality.ts';
import {
  balance,
  chances,
  featureChange,
  goodMoves,
  mate,
  moveInWords,
  passed,
  playLine,
  winnings,
} from '../server/diagnosis.ts';
import { analyze } from '../server/stockfish.ts';
import { fenAfter, pool } from './lib.ts';

export type TutorCase = {
  kind: 'mistake' | 'plan';
  /** The half-move asked about: the move played for a mistake, the move to find for a plan. */
  ply: number;
  /** For a mistake, what was missed. */
  category?: 'allowed' | 'allowed-mate' | 'threat' | 'chance' | 'missed-mate';
  message: string;
  rubric: string[];
};
export type TutorGame = {
  id: string;
  source: string;
  whiteElo: number;
  blackElo: number;
  timeControl: string;
  opening: string | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  playedAt: string;
  moves: string[];
  /** Seconds left on the mover's clock after each half-move. */
  clocks: number[];
  /** The side whose games these questions treat as the user's. */
  playerColor: 'white' | 'black';
  cases: TutorCase[];
};

const FILE = fileURLToPath(new URL('./tutor.json', import.meta.url));
const QUICK_MS = 400;
const DEEP_MS = 3000;
const ENGINES = 6;
const enemy = (color: Color): Color => (color === 'w' ? 'b' : 'w');

// ---------------------------------------------------------------------------
// Games

type Pgn = { headers: Record<string, string>; movetext: string };
function parsePgn(text: string): Pgn[] {
  const games: Pgn[] = [];
  let headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const header = /^\[(\w+) "(.*)"\]$/.exec(line);
    if (header) headers[header[1]] = header[2];
    else if (line.startsWith('1.')) {
      games.push({ headers, movetext: line });
      headers = {};
    }
  }
  return games;
}

function readGame({ headers, movetext }: Pgn): Omit<TutorGame, 'playerColor' | 'cases'> | null {
  const moves: string[] = [];
  const clocks: number[] = [];
  const text = movetext.replace(/\d+\.(\.\.)?/g, '');
  for (const [, san, comment] of text.matchAll(/([^\s{}]+)\s*\{([^}]*)\}/g)) {
    const clock = /%clk (\d+):(\d+):(\d+)/.exec(comment);
    if (!clock) return null;
    moves.push(san.replace(/[?!]+$/, ''));
    clocks.push(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  }
  try {
    fenAfter(moves);
  } catch {
    return null;
  }
  const result = headers.Result as TutorGame['result'];
  return {
    id: headers.Site.split('/').pop()!,
    source: headers.Site,
    whiteElo: Number(headers.WhiteElo),
    blackElo: Number(headers.BlackElo),
    timeControl: headers.TimeControl,
    opening: headers.Opening ?? null,
    result,
    playedAt: headers.UTCDate.replaceAll('.', '-'),
    moves,
    clocks,
  };
}

const clubRapid = ({ headers }: Pgn) => {
  const [base] = (headers.TimeControl ?? '').split('+').map(Number);
  const elos = [Number(headers.WhiteElo), Number(headers.BlackElo)];
  return (
    base >= 600 &&
    base <= 1800 &&
    headers.Termination === 'Normal' &&
    elos.every(elo => elo >= 1300 && elo <= 1800)
  );
};

const or = (moves: string[]) =>
  moves.length > 1 ? `${moves.slice(0, -1).join(', ')} or ${moves.at(-1)}` : moves[0];

// ---------------------------------------------------------------------------
// Questions

const HABIT: Record<NonNullable<TutorCase['category']>, string> = {
  allowed: `Gives a habit that would have caught it, such as checking the opponent's checks, captures and attacks in reply before playing a move (a blunder check), especially against pieces the move leaves undefended.`,
  'allowed-mate': `Gives a habit that would have caught it, such as checking the opponent's checks and captures in reply before playing a move, above all near one's own king.`,
  threat: `Gives a habit that would have caught it, such as asking what the opponent's last move threatens, or what they want to do next, before choosing a move.`,
  chance: `Gives a habit that would have caught it, such as looking at one's own checks, captures and attacks (forcing moves) before settling on a quiet move.`,
  'missed-mate': `Gives a habit that would have caught it, such as looking at every check, capture and attack near the enemy king before settling on another move.`,
};

/** Why the player's move at `ply` was bad, if what was missed can be shown; null otherwise. */
async function mistakeCase(game: TutorGame, ply: number): Promise<TutorCase | null> {
  const color: Color = ply % 2 === 0 ? 'w' : 'b';
  const fen = fenAfter(game.moves.slice(0, ply));
  const played = game.moves[ply];
  const pass = passed(fen);
  const [before, after, threat] = await Promise.all([
    analyze(fen, [], undefined, undefined, DEEP_MS),
    analyze(fen, [played], undefined, undefined, DEEP_MS),
    pass ? analyze(pass, [], undefined, undefined, DEEP_MS) : null,
  ]);
  const loss = chances(before.evaluation, color) - chances(after.evaluation, color);
  if (loss < 8 || !after.moves.length) return null;

  const start = new Chess(fen);
  const afterFen = fenAfter([...game.moves.slice(0, ply + 1)]);
  const reply = after.moves[0];
  const replyLine = playLine(afterFen, reply.continuation);
  const swing = balance(start, color) - balance(replyLine, color);
  const best = before.moves[0];
  const bestLine = playLine(fen, best.continuation);
  const gain = balance(bestLine, color) - balance(start, color);
  const better = goodMoves(before, color, 5).filter(move => move !== played);
  if (!better.length) return null;
  const numbered = numberedMove(ply, played);

  let category: TutorCase['category'];
  let missed: string;
  if (mate(after.evaluation, enemy(color))) {
    category = 'allowed-mate';
    missed = `Identifies that ${played} allowed a mating attack, starting with ${moveInWords(afterFen, reply.san)}.`;
  } else if (mate(before.evaluation, color) && !mate(after.evaluation, color)) {
    category = 'missed-mate';
    missed = `Points out that there was a forced mate, starting with ${moveInWords(fen, best.san)}, and ${played} missed it.`;
  } else if (swing >= 2) {
    const threatMove = threat?.moves[0];
    const threatLine = threatMove && playLine(pass!, threatMove.continuation);
    const threatened =
      threatLine &&
      balance(threatLine, enemy(color)) - balance(new Chess(pass!), enemy(color)) >= 2;
    const same =
      threatMove &&
      (threatMove.san === reply.san || threatMove.move.slice(2, 4) === reply.move.slice(2, 4));
    const wins = winnings(new Chess(afterFen), replyLine, enemy(color));
    if (threatened && same) {
      category = 'threat';
      missed = `Points out that the opponent was already threatening ${moveInWords(pass!, threatMove.san)} before ${played}, and that ${played} did nothing about it: the opponent goes on to win ${wins}.`;
    } else {
      category = 'allowed';
      missed = `Identifies what ${played} allowed: ${moveInWords(afterFen, reply.san)}, after which the opponent wins ${wins}.`;
    }
  } else if (gain >= 2 && balance(replyLine, color) - balance(start, color) < 2) {
    category = 'chance';
    missed = `Points out that ${moveInWords(fen, best.san)} was available and wins ${winnings(start, bestLine, color)}; ${played} let the chance go.`;
  } else return null;

  return {
    kind: 'mistake',
    ply,
    category,
    message: `I played ${numbered} here and the review calls it a mistake. Why was it bad, and what did I miss?`,
    rubric: [
      missed,
      `Names a better move, such as ${or(better)}, and says what it does about the problem.`,
      HABIT[category],
    ],
  };
}

/** What to aim for in a quiet position at `ply`, if it is quiet enough; null otherwise. */
async function planCase(game: TutorGame, ply: number): Promise<TutorCase | null> {
  const color: Color = ply % 2 === 0 ? 'w' : 'b';
  const fen = fenAfter(game.moves.slice(0, ply));
  const pass = passed(fen);
  if (!pass) return null;
  const [now, threat] = await Promise.all([
    analyze(fen, [], undefined, undefined, DEEP_MS),
    analyze(pass, [], undefined, undefined, DEEP_MS),
  ]);
  if (now.evaluation.type !== 'cp' || Math.abs(now.evaluation.value) > 150) return null;
  const good = goodMoves(now, color, 4);
  const forcing = now.moves.some(move => /[x+#]/.test(move.san));
  if (good.length < 2 || forcing) return null;

  const end = playLine(fen, now.moves[0].continuation, 8);
  const change = featureChange(fen, end.fen());
  const features = [
    ...change.new.map(fact => `${fact} (comes about)`),
    ...change.gone.map(fact => `${fact} (goes away)`),
  ].slice(0, 6);
  if (!features.length) return null;
  const wanted = threat.moves[0];

  return {
    kind: 'plan',
    ply,
    message: `It's my move and nothing obvious is happening. What should my plan be here?`,
    rubric: [
      `Recommends one of ${or(good)} as the next move, or a plan that starts with one of them.`,
      `Grounds the plan in how the position should change, consistent with where the engine's best line leads; any one of these, explained, counts: ${features.join('; ')}.`,
      `Says what the opponent wants to do next and whether the plan stops it (if it were the opponent's move, the engine would play ${moveInWords(pass, wanted.san)}).`,
      `Gives a concrete way to carry the plan out, such as a two- or three-move manoeuvre, rather than only general principles.`,
    ],
  };
}

// ---------------------------------------------------------------------------

/** The quick pass: the mover's winning chances lost by each move, from one short search per position. */
async function losses(game: Omit<TutorGame, 'playerColor' | 'cases'>): Promise<number[]> {
  const fens = game.moves.map((_, ply) => fenAfter(game.moves.slice(0, ply)));
  fens.push(fenAfter(game.moves));
  const verdicts = await pool(fens, ENGINES, fen =>
    analyze(fen, [], undefined, undefined, QUICK_MS),
  );
  return game.moves.map((_, ply) => {
    const color: Color = ply % 2 === 0 ? 'w' : 'b';
    return chances(verdicts[ply].evaluation, color) - chances(verdicts[ply + 1].evaluation, color);
  });
}

async function build(file: string, wanted: number) {
  const { readFileSync } = await import('node:fs');
  const all = parsePgn(readFileSync(file, 'utf8')).filter(clubRapid);
  const games = all
    .map(readGame)
    .filter((game): game is NonNullable<typeof game> => !!game)
    .filter(game => game.moves.length >= 50 && game.moves.length <= 150)
    .slice(0, wanted);
  console.log(`${all.length} club rapid games, using ${games.length}`);

  const built: TutorGame[] = [];
  for (const [index, raw] of games.entries()) {
    const game: TutorGame = { ...raw, playerColor: index % 2 ? 'black' : 'white', cases: [] };
    const mine = (ply: number) => (ply % 2 === 0) === (game.playerColor === 'white');
    const lossOf = await losses(game);
    const mistakes = lossOf
      .map((loss, ply) => ({ loss, ply }))
      .filter(({ loss, ply }) => mine(ply) && ply >= 10 && loss >= 10)
      .sort((a, b) => b.loss - a.loss);
    for (const { ply } of mistakes.slice(0, 3)) {
      const found = await mistakeCase(game, ply);
      if (found) {
        game.cases.push(found);
        break;
      }
    }
    const quiet = lossOf
      .map((loss, ply) => ({ loss, ply }))
      .filter(({ loss, ply }) => mine(ply) && ply >= 20 && ply <= 60 && loss < 3)
      .filter(({ ply }) => !game.cases.some(test => Math.abs(test.ply - ply) < 6));
    for (const { ply } of quiet.slice(0, 4)) {
      const found = await planCase(game, ply);
      if (found) {
        game.cases.push(found);
        break;
      }
    }
    const kinds = game.cases.map(test => test.category ?? test.kind).join(', ') || 'nothing';
    console.log(`${index + 1}/${games.length} ${game.id}: ${kinds}`);
    if (game.cases.length) built.push(game);
  }
  writeFileSync(FILE, JSON.stringify(built, null, 2) + '\n');
  const all_ = built.flatMap(game => game.cases);
  const tally = Object.entries(
    all_.reduce<Record<string, number>>((sum, test) => {
      const key = test.category ?? test.kind;
      sum[key] = (sum[key] ?? 0) + 1;
      return sum;
    }, {}),
  );
  console.log(
    `${all_.length} questions: ${tally.map(([key, count]) => `${count} ${key}`).join(', ')}`,
  );
}

const [file, count] = process.argv.slice(2);
await build(file, Number(count) || 36);
