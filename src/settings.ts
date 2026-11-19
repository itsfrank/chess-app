import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type SettingsInfo } from '../shared/protocol';
import { fetchSettings, saveSettings } from './api';

/** Where the chess.com username lived before the backend kept the settings. */
const LEGACY_USERNAME_KEY = 'chess-app.chesscom-username';

export type SettingsState = {
  settings: Settings;
  models: SettingsInfo['models'];
  /** Saves some settings; rejects with the backend's message when one is invalid. */
  save: (changes: Partial<Settings>) => Promise<void>;
  /** Opens the settings dialog. */
  open: () => void;
};

export const SettingsContext = createContext<SettingsState>({
  settings: DEFAULT_SETTINGS,
  models: [],
  save: async () => {},
  open: () => {},
});
export const useSettings = () => useContext(SettingsContext);

/**
 * Loads the settings once for the whole app. `state` is null until they have
 * arrived; if the backend cannot be reached the defaults stand in.
 */
export function useSettingsLoader(): Omit<SettingsState, 'open'> | null {
  const [info, setInfo] = useState<SettingsInfo | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      let loaded: SettingsInfo = { settings: DEFAULT_SETTINGS, models: [] };
      try {
        loaded = await fetchSettings();
        const remembered = localStorage.getItem(LEGACY_USERNAME_KEY);
        if (!loaded.settings.chesscomUsername && remembered)
          loaded = await saveSettings({ chesscomUsername: remembered });
        localStorage.removeItem(LEGACY_USERNAME_KEY);
      } catch {
        // Every screen still works on the defaults; saving will report the problem.
      }
      if (current) setInfo(loaded);
    })();
    return () => {
      current = false;
    };
  }, []);

  const save = useCallback(async (changes: Partial<Settings>) => {
    setInfo(await saveSettings(changes));
  }, []);
  return info && { ...info, save };
}
