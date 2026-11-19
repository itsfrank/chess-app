import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  expect(new Evaluator(file, () => 18).cached(positionKey(mated))?.depth).toBe(0);
  // Results are kept per depth, so another depth starts without them.
  expect(new Evaluator(file, () => 12).cached(positionKey(mated))).toBeUndefined();
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
