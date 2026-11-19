import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/protocol.ts';
import { mergeSettings, SettingsStore } from './settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'chess-app-settings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('applies valid changes and names the setting that is not', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    effort: 'high',
    analysisSeconds: 2.74,
    repertoireDepth: 20,
  });
  expect(merged).toEqual({
    ...DEFAULT_SETTINGS,
    effort: 'high',
    analysisSeconds: 2.5,
    repertoireDepth: 20,
  });
  for (const [bad, name] of [
    [{ chesscomUsername: 'a b' }, 'chess.com username'],
    [{ model: '../x' }, 'model'],
    [{ effort: 'extreme' }, 'effort'],
    [{ gameReviewDepth: 7 }, 'gameReviewDepth'],
    [{ analysisSeconds: '2' }, 'analysisSeconds'],
  ] as const) {
    expect(() => mergeSettings(DEFAULT_SETTINGS, bad)).toThrow(`Invalid setting: ${name}`);
  }
  expect(() => mergeSettings(DEFAULT_SETTINGS, null)).toThrow('Invalid settings');
});

it('only accepts a model the login can use, but keeps the one already set', () => {
  const models = ['gpt-6-luna'];
  expect(mergeSettings(DEFAULT_SETTINGS, { model: 'gpt-6-luna' }, models).model).toBe('gpt-6-luna');
  expect(() => mergeSettings(DEFAULT_SETTINGS, { model: 'gpt-9' }, models)).toThrow(
    'not available',
  );
  expect(mergeSettings(DEFAULT_SETTINGS, { model: DEFAULT_SETTINGS.model }, models)).toEqual(
    DEFAULT_SETTINGS,
  );
});

it('persists changes and fills in settings missing from an older file', () => {
  const file = join(dir, 'settings.json');
  expect(new SettingsStore(file).current).toEqual(DEFAULT_SETTINGS);
  new SettingsStore(file).update({ chesscomUsername: 'frk', gameReviewDepth: 12 });
  expect(new SettingsStore(file).current).toMatchObject({
    chesscomUsername: 'frk',
    gameReviewDepth: 12,
    repertoireDepth: DEFAULT_SETTINGS.repertoireDepth,
  });

  writeFileSync(file, JSON.stringify({ effort: 'low' }));
  expect(new SettingsStore(file).current).toEqual({ ...DEFAULT_SETTINGS, effort: 'low' });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ effort: 'low' });
});
