import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { afterAll, expect, it } from 'vitest';
import { positionKey } from '../shared/repertoire.ts';
import { Evaluator, parseEval } from './evaluator.ts';

const dir = mkdtempSync(join(tmpdir(), 'chess-app-evaluator-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

it('takes the last exact score, from White’s perspective, with the engine’s move in SAN', () => {
  const lines = [
    'info depth 17 seldepth 20 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv g8f6',
    'info depth 18 seldepth 22 multipv 1 score cp 35 nodes 1 nps 1 time 1 pv e7e5 g1f3',
    'info depth 19 seldepth 22 multipv 1 score cp 60 lowerbound nodes 1 nps 1 time 1 pv c7c5',
    'info depth 19 currmove e7e5 currmovenumber 1',
  ];
  expect(parseEval(lines, afterE4)).toEqual({
    evaluation: { type: 'cp', value: -35 },
    best: 'e5',
    depth: 18,
  });
  expect(parseEval(['info depth 5 score mate 3 nodes 1 pv e7e5'], afterE4)?.evaluation).toEqual({
    type: 'mate',
    value: -3,
  });
  expect(parseEval([], afterE4)).toBeUndefined();

  const two = [
    'info depth 16 seldepth 20 multipv 1 score cp 30 nodes 1 nps 1 time 1 pv e7e5',
    'info depth 16 seldepth 20 multipv 2 score cp 90 nodes 1 nps 1 time 1 pv c7c5',
  ];
  expect(parseEval(two, afterE4)).toEqual({
    evaluation: { type: 'cp', value: -30 },
    best: 'e5',
    depth: 16,
    second: { type: 'cp', value: -90 },
  });
});

it('scores finished games without an engine and remembers them', async () => {
  const file = join(dir, 'evals.json');
  const evaluator = new Evaluator(file, () => 18);
  const mated = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
  expect(await evaluator.evaluate(mated)).toEqual({
    evaluation: { type: 'mate', value: 0, winner: 'white' },
    best: null,
    depth: 0,
  });
  evaluator.dispose();
  expect(existsSync(file)).toBe(true);
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toHaveLength(1);
  // A finished game has nothing to search, so its verdict holds at any depth.
  const deeper = new Evaluator(file, () => 24);
  expect(deeper.cached(positionKey(mated))?.depth).toBe(0);
  expect(deeper.current(positionKey(mated))).toBe(true);
});

it.runIf(process.env.TEST_STOCKFISH === '1')(
  'searches positions one after another with a live engine',
  async () => {
    const evaluator = new Evaluator(join(dir, 'live.json'), () => 18);
    const [start, sicilian] = await Promise.all([
      evaluator.evaluate(new Chess().fen()),
      evaluator.evaluate(afterE4),
    ]);
    evaluator.dispose();
    for (const [result, fen] of [
      [start, new Chess().fen()],
      [sicilian, afterE4],
    ] as const) {
      expect(result.depth).toBeGreaterThan(10);
      expect(Math.abs(result.evaluation.value)).toBeLessThan(150);
      expect(() => new Chess(fen).move(result.best!)).not.toThrow();
    }
  },
  60000,
);

it('serves the deepest stored result and calls it current only when it is deep enough', () => {
  const file = join(dir, 'depths.json');
  const key = positionKey(afterE4);
  const at = (depth: number, value: number) => ({
    evaluation: { type: 'cp', value },
    best: 'e5',
    depth,
  });
  writeFileSync(
    file,
    JSON.stringify({
      [`${key}|12`]: at(12, 40),
      [`${key}|18`]: at(18, 25),
      'other|14|pv2': at(14, 0),
    }),
  );
  const configured = { depth: 16 };
  const evaluator = new Evaluator(file, () => configured.depth);
  expect(evaluator.cached(key)?.evaluation).toEqual({ type: 'cp', value: 25 });
  // Searched deeper than asked: never in need of another search.
  expect(evaluator.current(key)).toBe(true);
  configured.depth = 18;
  expect(evaluator.current(key)).toBe(true);
  // Still served when the configured depth passes it, but no longer current.
  configured.depth = 20;
  expect(evaluator.cached(key)?.depth).toBe(18);
  expect(evaluator.current(key)).toBe(false);
  // Results that carry a second line belong to another kind of search.
  expect(evaluator.cached('other')).toBeUndefined();
  expect(evaluator.current('unknown')).toBe(false);
});
