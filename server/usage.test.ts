import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadTotals, saveTotals } from './usage';

it('loads persisted totals independently of in-memory state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chess-usage-'));
  try {
    const file = join(dir, 'data', 'usage.json');
    expect(loadTotals(file)).toEqual({ tokens: 0, cost: 0 });
    saveTotals({ tokens: 1000, cost: .0123 }, file);
    expect(loadTotals(file)).toEqual({ tokens: 1000, cost: .0123 });
    saveTotals({ tokens: 2000, cost: .0246 }, file);
    expect(loadTotals(file)).toEqual({ tokens: 2000, cost: .0246 });
    writeFileSync(file, '{bad json');
    expect(() => loadTotals(file)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
