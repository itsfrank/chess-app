import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Totals } from '../shared/protocol.ts';
import { USAGE_FILE } from './config.ts';

export const emptyTotals = (): Totals => ({ tokens: 0, cost: 0 });

const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A missing file means no usage yet; a corrupt one is an error rather than a silent reset. */
export function loadTotals(file = USAGE_FILE): Totals {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTotals();
    throw error;
  }
  const value = JSON.parse(text);
  if (!isCount(value?.tokens) || !isCount(value?.cost)) throw new Error('Invalid usage totals');
  return { tokens: value.tokens, cost: value.cost };
}

/** Writes via a temporary file so a crash cannot leave a half-written total. */
export function saveTotals(value: Totals, file = USAGE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
