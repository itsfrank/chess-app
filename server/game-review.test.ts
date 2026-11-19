import { Chess } from 'chess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { PositionEval } from '../shared/protocol.ts';
import { positionKey } from '../shared/repertoire.ts';
import { GameReviewService, parseReviewRequest } from './game-review.ts';

/** An evaluator that scores positions from a table by the number of moves played. */
function fakeEvaluator(scores: number[], best: string[]) {
  const cache = new Map<string, PositionEval>();
  const log = { searched: 0, released: 0 };
  const evaluator = {
    cached: (key: string) => cache.get(key),
    evaluate: async (fen: string) => {
      const board = new Chess(fen);
      const ply = (board.moveNumber() - 1) * 2 + (board.turn() === 'b' ? 1 : 0);
      const result: PositionEval = {
        evaluation: { type: 'cp', value: scores[ply] },
        best: best[ply] ?? null,
        depth: 16,
      };
      log.searched++;
      cache.set(positionKey(fen), result);
      return result;
    },
    release: () => void log.released++,
    dispose: () => {},
  };
  return { evaluator, log };
}

const moves = ['e4', 'e5', 'Ke2', 'Nc6'];
const dir = mkdtempSync(join(tmpdir(), 'chess-app-review-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const bookFile = () => join(dir, `book-${files++}.json`);
const noBook = { loadBook: async () => [], bookFile: bookFile() };

it('accepts only legal games', () => {
  expect(parseReviewRequest({ moves })).toEqual(moves);
  for (const bad of [null, {}, { moves: [] }, { moves: ['e5'] }, { moves: [1] }, { moves: 'e4' }])
    expect(() => parseReviewRequest(bad)).toThrow('Invalid game');
});

it('evaluates every position in order, then summarises the game for the companion', async () => {
  const { evaluator, log } = fakeEvaluator([30, 30, 35, -120, -110], ['e4', 'c5', 'Nf3', 'Nc6']);
  const service = new GameReviewService({ evaluator, ...noBook });
  expect(service.summary(moves)).toBeNull();

  const plies: number[] = [];
  await service.evaluate(moves, new AbortController().signal, ply => plies.push(ply));
  expect(plies).toEqual([0, 1, 2, 3, 4]);
  expect(log).toEqual({ searched: 5, released: 1 });

  const summary = service.summary(moves)!;
  expect(summary.white).toMatchObject({ best: 1, mistake: 1 });
  expect(summary.black).toMatchObject({ accuracy: 99, excellent: 1, best: 1 });
  expect(summary.errors).toEqual([
    '2. Ke2: mistake, winning chances 53% to 39%, engine preferred Nf3',
  ]);
});

it('stops when the request is aborted', async () => {
  const { evaluator, log } = fakeEvaluator([0, 0, 0, 0, 0], []);
  const service = new GameReviewService({ evaluator, ...noBook });
  const abort = new AbortController();
  const run = service.evaluate(moves, abort.signal, ply => ply === 1 && abort.abort());
  await expect(run).rejects.toThrow();
  expect(log).toEqual({ searched: 2, released: 1 });
});

it('labels the opening as book as far as the explorer knows the moves, once per position', async () => {
  const { evaluator } = fakeEvaluator([30, 30, 35, -120, -110], ['d4', 'c5', 'Nf3', 'Nc6']);
  const lookups: string[] = [];
  const loadBook = async (fen: string) => {
    lookups.push(fen);
    return lookups.length < 3 ? ['e4', 'e5', 'Nf3'] : [];
  };
  const service = new GameReviewService({ evaluator, loadBook, bookFile: bookFile() });
  const book: number[] = [];
  const run = () =>
    service.evaluate(
      moves,
      new AbortController().signal,
      () => {},
      plies => book.push(plies),
    );
  await run();
  // 1. e4 e5 are known; 2. Ke2 is not, so the lookups stop there.
  expect(book).toEqual([1, 2]);
  expect(lookups).toHaveLength(3);
  expect(service.summary(moves)).toMatchObject({ bookUntil: '1… e5', white: { book: 1, best: 0 } });

  await run();
  expect(lookups).toHaveLength(3);
});

it('still reviews the game when the explorer fails', async () => {
  const { evaluator } = fakeEvaluator([30, 30, 35, -120, -110], []);
  const loadBook = async () => Promise.reject(new Error('no token'));
  const service = new GameReviewService({ evaluator, loadBook, bookFile: bookFile() });
  const plies: number[] = [];
  await service.evaluate(moves, new AbortController().signal, ply => plies.push(ply));
  expect(plies).toHaveLength(5);
  expect(service.summary(moves)).toMatchObject({ bookUntil: null });
});
