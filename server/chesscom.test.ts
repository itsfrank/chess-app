import { afterEach, expect, it, vi } from 'vitest';
import { listGames, openingName, parseGame } from './chesscom.ts';

afterEach(() => vi.unstubAllGlobals());

const pgn = (result = '1-0', extra = '') => `[Event "Live Chess"]
[White "Frk"]
[Black "rival"]
[Result "${result}"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-Giuoco-Piano-3...Bc5-4.c3"]
[Termination "Frk won by resignation"]
${extra}
1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:50]} 2... Nc6 {[%clk 0:09:49]} ${result}
`;
const raw = (end: number, overrides: object = {}) => ({
  url: `https://www.chess.com/game/live/${end}`,
  pgn: pgn(),
  rules: 'chess',
  end_time: end,
  time_class: 'rapid',
  time_control: '600',
  white: { username: 'Frk', rating: 1400 },
  black: { username: 'rival', rating: 1425 },
  ...overrides,
});

it('reads a game from its PGN and drops what is not standard chess', () => {
  expect(parseGame(raw(1_700_000_000), 'rival')).toEqual({
    url: 'https://www.chess.com/game/live/1700000000',
    playedAt: '2023-11-14T22:13:20.000Z',
    white: { name: 'Frk', rating: 1400 },
    black: { name: 'rival', rating: 1425 },
    playerColor: 'black',
    result: '1-0',
    termination: 'Frk won by resignation',
    timeClass: 'rapid',
    timeControl: '600',
    opening: 'Italian Game Giuoco Piano',
    moves: ['e4', 'e5', 'Nf3', 'Nc6'],
    clocks: [598, 597, 590, 589],
  });
  expect(parseGame(raw(1, { rules: 'chess960' }), 'frk')).toBeNull();
  expect(parseGame(raw(1, { pgn: 'not a game' }), 'frk')).toBeNull();
  expect(parseGame(raw(1, { pgn: pgn('*') }), 'frk')).toBeNull();
  const custom = '[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]';
  expect(parseGame(raw(1, { pgn: pgn('1-0', custom) }), 'frk')).toBeNull();
  expect(openingName(undefined)).toBeNull();
  expect(openingName('https://www.chess.com/openings/Reti-Opening-Larsen-Attack...4.g3-e6')).toBe(
    'Reti Opening Larsen Attack',
  );
});

/** A chess.com whose player has `perMonth` games in each of the given months. */
function stubArchive(months: string[], perMonth: number) {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/archives'))
      return Response.json({ archives: months.map(month => `https://x/games/${month}`) });
    const [year, month] = url.split('/').slice(-2).map(Number);
    const start = Date.UTC(year, month - 1, 2) / 1000;
    return Response.json({
      games: Array.from({ length: perMonth }, (_, index) => raw(start + index * 3600)),
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('pages through the monthly archives newest first without repeating a game', async () => {
  const fetch = stubArchive(['2031/01', '2031/02', '2031/03'], 40);
  const first = await listGames(' FRK ');
  expect(first.username).toBe('Frk');
  expect(first.games).toHaveLength(50);
  expect(first.games[0].playedAt > first.games[1].playedAt).toBe(true);
  // March and enough of February to fill the page.
  expect(fetch.mock.calls.map(([url]) => url.split('/games/')[1])).toEqual([
    'archives',
    '2031/03',
    '2031/02',
  ]);

  const seen = new Set(first.games.map(game => game.url));
  let page = first;
  while (page.older !== null) {
    page = await listGames('frk', page.older);
    for (const game of page.games) {
      expect(seen.has(game.url)).toBe(false);
      seen.add(game.url);
    }
  }
  expect(seen.size).toBe(120);
});

it('rejects bad usernames without a request and reports unknown players', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  await expect(listGames('../etc')).rejects.toThrow('username');
  await expect(listGames('frk', -1)).rejects.toThrow('Invalid page');
  expect(fetch).not.toHaveBeenCalled();
  await expect(listGames('nobody-here')).rejects.toMatchObject({ status: 404 });
});
