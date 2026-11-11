import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export type Totals = { tokens: number; cost: number };
export const emptyTotals = (): Totals => ({ tokens: 0, cost: 0 });
const directory = join(process.cwd(), '.data');
const path = join(directory, 'usage.json');
export function loadTotals(file = path): Totals {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(value.tokens) || value.tokens < 0 || !Number.isFinite(value.cost) || value.cost < 0) throw new Error('Invalid usage totals');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTotals();
    throw error;
  }
}
export function saveTotals(value: Totals, file = path) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
