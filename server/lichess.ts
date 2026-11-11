import { Chess } from 'chess.js';
import { readFileSync } from 'node:fs';
function lichessToken() {
  if (process.env.LICHESS_TOKEN) return process.env.LICHESS_TOKEN.trim();
  try { return readFileSync('.data/lichess-token', 'utf8').trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return ''; }
}
export const ratings = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
export const speeds = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
type Counts = { white: number; draws: number; black: number };
type ExplorerData = Counts & { opening?: { eco: string; name: string }; moves: (Counts & { uci: string; san: string; averageRating?: number })[] };
const count = (row: Counts) => row.white + row.draws + row.black;
export function summarize(data: ExplorerData) {
  const rows = [data, ...data.moves];
  if (rows.some(row => ['white', 'draws', 'black'].some(key => !Number.isSafeInteger(row[key as keyof Counts]) || row[key as keyof Counts] < 0))) throw new Error('Invalid Lichess counts');
  const totalGames = count(data);
  return {
    totalGames, opening: data.opening ?? null,
    moves: data.moves.map(move => ({ uci: move.uci, san: move.san, games: count(move), frequency: totalGames ? count(move) / totalGames : null,
      whiteWins: move.white, draws: move.draws, blackWins: move.black, averageRating: move.averageRating ?? null })),
    otherGames: Math.max(0, totalGames - data.moves.reduce((sum, row) => sum + count(row), 0)),
    note: 'Frequencies are empirical proportions in the selected rated Lichess sample, not predictions for a specific opponent. Missing moves may be unrecorded or outside the returned top 12. Small samples are unreliable. Results are not engine evaluations.',
  };
}
const cache = new Map<string, { until: number; value: object }>();
let gate = Promise.resolve();
let nextRequest = 0;
let blockedUntil = 0;
export async function explore(fen: string, options: { moves?: string[]; ratings?: number[]; speeds?: string[] }, signal?: AbortSignal) {
  const board = new Chess(fen); for (const move of options.moves ?? []) board.move(move);
  const selectedRatings = [...new Set(options.ratings ?? ratings)].sort((a,b) => a-b);
  const selectedSpeeds = [...new Set(options.speeds ?? speeds)].sort();
  if (!selectedRatings.length || selectedRatings.some(r => !ratings.includes(r)) || !selectedSpeeds.length || selectedSpeeds.some(s => !speeds.includes(s))) throw new Error('Invalid Lichess filters');
  const url = new URL('https://explorer.lichess.org/lichess');
  url.search = new URLSearchParams({ variant: 'standard', fen: board.fen(), ratings: selectedRatings.join(','), speeds: selectedSpeeds.join(','), moves: '12', topGames: '0', recentGames: '0' }).toString();
  const key = url.toString();
  const previous = gate; let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    signal?.throwIfAborted();
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    if (Date.now() < blockedUntil) throw new Error('Lichess rate limit: wait at least one minute before trying again');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextRequest - Date.now())));
    signal?.throwIfAborted(); nextRequest = Date.now() + 1000;
    const token = lichessToken();
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), headers: { Accept: 'application/json', 'User-Agent': 'chess-companion-local/0.1', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (response.status === 429) { blockedUntil = Date.now() + Math.max(60000, (Number(response.headers.get('retry-after')) || 0) * 1000); throw new Error('Lichess rate limit: wait at least one minute before trying again'); }
    if (response.status === 401 || response.status === 403) throw new Error('Lichess explorer requires a valid personal access token. Configure LICHESS_TOKEN on the backend; never paste it into chat.');
    if (!response.ok) throw new Error(`Lichess explorer unavailable (HTTP ${response.status})`);
    const data = await response.json() as ExplorerData;
    if (!Array.isArray(data.moves)) throw new Error('Invalid Lichess explorer response');
    const result = { source: 'Lichess rated games', url: key, fen: board.fen(), filters: { ratings: selectedRatings, speeds: selectedSpeeds }, fetchedAt: new Date().toISOString(), ...summarize(data) };
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + 3600000, value: result });
    return result;
  } finally { release(); }
}
