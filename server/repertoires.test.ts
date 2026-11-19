import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { PositionEval } from '../shared/protocol.ts';
import { RepertoireService, type FrequencyLoader } from './repertoires.ts';

const dir = mkdtempSync(join(tmpdir(), 'chess-app-repertoires-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** White meets 1...Nf6 with 2.Nf3 and 3.c4, but takes on d5 in the other move order. */
const PGN = `[Event "Test"]

1. d4 d5 (1... Nf6 2. Nf3 d5 3. c4 e6 4. g3) 2. c4 Nf6 3. cxd5 Nxd5 4. e4 *`;

function service(loadFrequencies: FrequencyLoader = async () => ({ d5: 0.5, Nf6: 0.25 })) {
  const evals = new Map<string, PositionEval>();
  const evaluator = {
    cached: (key: string) => evals.get(key),
    evaluate: async (fen: string) => {
      const result: PositionEval = { evaluation: { type: 'cp', value: 20 }, best: null, depth: 1 };
      evals.set(fen.split(' ').slice(0, 4).join(' '), result);
      return result;
    },
    release: () => {},
    dispose: () => {},
  };
  return new RepertoireService({
    dir,
    evaluator,
    frequencyFile: join(dir, 'frequencies.json'),
    loadFrequencies,
    rateLimitWaitMs: 5,
    frequencySpacingMs: 0,
  });
}

it('imports a PGN, applies an accepted proposal and restores the import when it is reverted', () => {
  const repertoires = service();
  const imported = repertoires.import({ pgn: PGN });
  expect(imported).toMatchObject({ name: 'Test', side: 'white', decisions: 7, accepted: 0 });

  const merge = imported.findings.find(item => item.current === 'cxd5' && item.proposed === 'Nf3')!;
  expect(merge.direct).toBe(true);
  const accepted = repertoires.accept(imported.id, merge.id);
  expect(accepted.decisions).toBe(6);
  expect(accepted.imported.decisions).toBe(7);
  expect(accepted.changes).toMatchObject([
    { from: 'cxd5', to: 'Nf3', active: true, path: ['d4', 'd5', 'c4', 'Nf6'] },
  ]);
  expect(repertoires.list()).toMatchObject([{ id: imported.id, accepted: 1, decisions: 6 }]);

  const reverted = repertoires.revert(imported.id, accepted.changes[0].id);
  expect(reverted.decisions).toBe(7);
  expect(() => repertoires.accept(imported.id, 'missing')).toThrow('no longer applies');
});

it('evaluates every position and weights lines by how often opponents play them', async () => {
  const repertoires = service();
  const { id, job } = repertoires.import({ pgn: PGN });
  expect(job).toMatchObject({ running: false, evalDone: 0 });

  expect(repertoires.analyze(id, [1400, 1600]).job.running).toBe(true);
  await expect.poll(() => repertoires.report(id).job.running).toBe(false);
  const report = repertoires.report(id);
  expect(report.settings.ratings).toEqual([1400, 1600]);
  expect(report.job).toMatchObject({ evalDone: report.job.evalTotal, error: null });
  expect(report.reachComplete).toBe(true);
  const afterD5 = Object.values(report.graph.nodes).find(node => node.path.join(' ') === 'd4 d5')!;
  expect(report.reach[afterD5.key]).toBe(0.5);
  expect(() => repertoires.analyze(id, [1234])).toThrow('Invalid rating range');
});

it('waits out the explorer rate limit instead of abandoning the frequencies', async () => {
  let calls = 0;
  const repertoires = service(async () => {
    if (++calls === 2) throw new Error('Lichess rate limit: wait at least one minute');
    return { d5: 1 };
  });
  const { id } = repertoires.import({ pgn: PGN });
  repertoires.analyze(id);
  await expect.poll(() => repertoires.report(id).job.running).toBe(false);
  expect(repertoires.report(id)).toMatchObject({ reachComplete: true, job: { error: null } });
});

it('rejects PGNs it cannot read and unknown repertoires', () => {
  const repertoires = service();
  expect(() => repertoires.import({ pgn: '1. e4 e5 2. Ke3' })).toThrow('Illegal move Ke3');
  expect(() => repertoires.import({ pgn: '' })).toThrow('Missing PGN');
  expect(() => repertoires.report('../usage')).toThrow('Repertoire not found');
});
