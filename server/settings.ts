import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_SETTINGS,
  EFFORTS,
  SETTING_LIMITS,
  type Effort,
  type Settings,
} from '../shared/protocol.ts';
import { HttpError } from './http.ts';

const NUMBERS = Object.keys(SETTING_LIMITS) as (keyof typeof SETTING_LIMITS)[];

/**
 * A complete, valid copy of `current` with the fields of `input` applied.
 * Unknown fields are ignored; an invalid value is an error naming the setting.
 */
export function mergeSettings(current: Settings, input: unknown, models?: string[]): Settings {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid settings');
  const patch = input as Record<string, unknown>;
  const next = { ...current };
  const invalid = (name: string) => new HttpError(400, `Invalid setting: ${name}`);

  if (patch.chesscomUsername !== undefined) {
    const name = patch.chesscomUsername;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{0,50}$/.test(name.trim()))
      throw invalid('chess.com username');
    next.chesscomUsername = name.trim();
  }
  if (patch.model !== undefined) {
    const model = patch.model;
    if (typeof model !== 'string' || !/^[\w.-]{1,60}$/.test(model)) throw invalid('model');
    if (model !== current.model && models?.length && !models.includes(model))
      throw new HttpError(400, `Model ${model} is not available with your Pi login`);
    next.model = model;
  }
  if (patch.effort !== undefined) {
    if (!EFFORTS.includes(patch.effort as Effort)) throw invalid('effort');
    next.effort = patch.effort as Effort;
  }
  for (const name of NUMBERS) {
    const value = patch[name];
    if (value === undefined) continue;
    const { min, max, step } = SETTING_LIMITS[name];
    if (typeof value !== 'number' || !(value >= min && value <= max)) throw invalid(name);
    next[name] = Math.round(value / step) * step;
  }
  return next;
}

/** The app's settings, read once and written through on every change. Without a file they last for the process. */
export class SettingsStore {
  private value: Settings = DEFAULT_SETTINGS;
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      // Merging validates what is on disk and fills in settings added since it was written.
      this.value = mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get current(): Settings {
    return this.value;
  }

  /** Applies a partial update; `models` limits which model may be chosen. */
  update(input: unknown, models?: string[]): Settings {
    this.value = mergeSettings(this.value, input, models);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.value, null, 2), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    }
    return this.value;
  }
}
