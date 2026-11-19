import { expect, it } from 'vitest';
import { findConsolidations } from './consolidation.ts';
import { applyChange, buildGraph, decisionCount, formatPath, reaches } from './repertoire.ts';
import { auditMoves, reachProbabilities, verdictOf } from './soundness.ts';

const at = (graph: ReturnType<typeof buildGraph>, path: string) =>
  Object.values(graph.nodes).find(node => node.path.join(' ') === path)!;

it('folds move orders that reach the same position into one node', () => {
  const graph = buildGraph(`[Event "x"]
1. d4 d5 {main} (1... e6 2. Nf3 d5 3. c4 Nf6 4. g3) 2. c4 e6 3. Nf3 $1 Nf6 4. g3!? *`);
  expect(graph.side).toBe('white');
  // Eight positions in the main line, plus three on the way round through 1...e6.
  expect(Object.keys(graph.nodes)).toHaveLength(11);
  expect(decisionCount(graph)).toBe(6);
  expect(at(graph, 'd4 d5 c4 e6 Nf3').moves.map(move => move.san)).toEqual(['Nf6']);
  expect(formatPath(['d4', 'd5', 'c4'])).toBe('1. d4 d5 2. c4');
});

it('infers a Black repertoire and rejects broken PGNs', () => {
  expect(buildGraph('1. e4 (1. d4 d5) c5 2. Nf3 (2. c3 Nc6) Nc6').side).toBe('black');
  expect(() => buildGraph('1. e4 e5 (1... c5')).toThrow('Unbalanced');
  expect(() => buildGraph('[Event "empty"]\n*')).toThrow('no moves');
});

it('proposes a move that returns to a known position, and one that only changes the order', () => {
  const graph = buildGraph(
    '1. d4 d5 (1... Nf6 2. Nf3 d5 3. c4 e6 4. g3) (1... e6 2. Nf3) (1... g6 2. Nf3) (1... Nc6 2. c4 d5 3. Nf3) 2. c4 Nf6 (2... Nc6 3. Nf3) 3. cxd5 Nxd5 4. e4',
  );
  const { findings } = findConsolidations(graph);
  const direct = findings.find(item => item.current === 'cxd5' && item.proposed === 'Nf3')!;
  expect(direct).toMatchObject({ direct: true, plan: [], openLines: 0 });
  expect(direct.decisionsBefore - direct.decisionsAfter).toBe(1);

  // After 1...Nc6, 2.Nf3 d5 3.c4 reaches the same position as 2.c4 d5 3.Nf3. It costs a
  // position, because 2.c4 d5 is also reached through 1...d5, but 2.Nf3 is the usual move here.
  const swap = findings.find(
    item => item.key === at(graph, 'd4 Nc6').key && item.proposed === 'Nf3',
  )!;
  expect(swap.plan).toEqual([
    { reply: 'd5', move: 'c4', joins: at(graph, 'd4 d5 c4 Nc6 Nf3').key },
  ]);

  expect(swap.decisionsAfter).toBe(swap.decisionsBefore + 1);
  expect(swap.peers).toMatchObject({ count: 3, currentCount: 2 });

  const changed = applyChange(graph, { ...swap, from: swap.current, to: swap.proposed })!;
  expect(at(changed, 'd4 Nc6').moves.map(move => move.san)).toEqual(['Nf3']);
  expect(reaches(changed, changed.root, at(graph, 'd4 Nc6 c4').key)).toBe(false);
  expect(applyChange(changed, { ...swap, from: swap.current, to: swap.proposed })).toBeNull();
});

it('reports the usual move for a setup and proposes it where it is not played', () => {
  const graph = buildGraph('1. d4 Nf6 (1... e6 2. Nf3) (1... g6 2. Nf3) (1... d5 2. c4) 2. Nf3');
  const { rules, findings } = findConsolidations(graph);
  expect(rules[0]).toMatchObject({ setup: 'd4', total: 4 });
  expect(rules[0].moves.map(move => [move.san, move.keys.length])).toEqual([
    ['Nf3', 3],
    ['c4', 1],
  ]);
  const usual = findings.find(item => item.current === 'c4' && item.proposed === 'Nf3')!;
  expect(usual.peers).toMatchObject({ count: 3, currentCount: 1 });
});

it('scores proposals and audits repertoire moves from stored evaluations', () => {
  const graph = buildGraph('1. e4 c5 (1... e5 2. Nf3) 2. Nf3', 'black');
  const cp = (value: number, best: string | null = null) => ({
    evaluation: { type: 'cp' as const, value },
    best,
    depth: 20,
  });
  const afterE4 = at(graph, 'e4');
  const evals = {
    [afterE4.key]: cp(30, 'e5'),
    [at(graph, 'e4 c5').key]: cp(90),
    [at(graph, 'e4 e5').key]: cp(30),
  };
  // White's +0.9 after 1...c5 is 60 centipawns worse for Black than the engine's 1...e5.
  expect(auditMoves(graph, evals, 50)).toEqual([
    { key: afterE4.key, san: 'c5', best: 'e5', loss: 60, score: -90 },
  ]);
  expect(auditMoves(graph, evals, 80)).toEqual([]);

  const finding = {
    key: afterE4.key,
    current: 'c5',
    proposed: 'e5',
    after: { key: at(graph, 'e4 e5').key, fen: '' },
    plan: [],
  } as never;
  expect(verdictOf(graph, evals, finding)).toEqual({ current: -90, proposed: -30, delta: 60 });
  expect(verdictOf(graph, {}, finding)).toBeNull();

  const reach = reachProbabilities(graph, { [graph.root]: { e4: 0.6 } });
  expect(reach[afterE4.key]).toBe(0.6);
  expect(reach[at(graph, 'e4 c5').key]).toBe(0.3);
});
