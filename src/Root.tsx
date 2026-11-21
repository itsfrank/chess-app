import { Activity, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDrillDue } from '../shared/drills';
import type { DrillCard } from '../shared/protocol';
import { drills as drillsApi } from './api';
import { App } from './App';
import { DrillsScreen } from './components/Drills';
import { GamesScreen } from './components/Games';
import { RepertoireScreen } from './components/Repertoire';
import { SettingsDialog } from './components/Settings';
import { SettingsContext, useSettingsLoader } from './settings';
import type { SparRequest } from './spar';

type Mode = 'board' | 'games' | 'drills' | 'repertoire';
const MODES: [Mode, string][] = [
  ['board', 'Board'],
  ['games', 'My games'],
  ['drills', 'Drills'],
  ['repertoire', 'Repertoire'],
];
const MODE_KEY = 'chess-app.mode';

/**
 * Switches between the board with its companion, the user's chess.com games,
 * spaced-repetition mistake drills, and the repertoire screen, and holds the settings they share.
 */
export function Root() {
  const [mode, setMode] = useState<Mode>(() => {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.find(([name]) => name === stored)?.[0] ?? 'board';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dueDrills, setDueDrills] = useState(0);
  const [drillsRefresh, setDrillsRefresh] = useState(0);
  const [sparSeed, setSparSeed] = useState<SparRequest | null>(null);
  const sparCounter = useRef(0);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const loaded = useSettingsLoader();
  const settings = useMemo(
    () => loaded && { ...loaded, open: openSettings },
    [loaded, openSettings],
  );

  const syncDueCount = useCallback((cards: DrillCard[]) => {
    setDueDrills(cards.filter(card => isDrillDue(card)).length);
  }, []);

  useEffect(() => {
    let active = true;
    drillsApi
      .list()
      .then(cards => {
        if (active) syncDueCount(cards);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [syncDueCount]);

  const selectMode = useCallback((next: Mode) => {
    localStorage.setItem(MODE_KEY, next);
    setMode(next);
  }, []);

  const handleSpar = useCallback(
    (request: Omit<SparRequest, 'id'>) => {
      const id = ++sparCounter.current;
      setSparSeed({ ...request, id });
      selectMode('board');
    },
    [selectMode],
  );

  const handleDrillsAdded = useCallback(
    (cards: DrillCard[]) => {
      syncDueCount(cards);
      setDrillsRefresh(count => count + 1);
    },
    [syncDueCount],
  );

  // The screens read the settings as they mount, so they wait for them.
  if (!settings) return null;

  const modeSwitch = (
    <nav className="mode-switch" aria-label="Mode">
      {MODES.map(([name, title]) => (
        <button
          key={name}
          aria-current={mode === name ? 'page' : undefined}
          onClick={() => selectMode(name)}
        >
          {name === 'drills' && dueDrills > 0 ? `${title} (${dueDrills})` : title}
        </button>
      ))}
      <button aria-haspopup="dialog" onClick={openSettings}>
        Settings
      </button>
    </nav>
  );
  // The hidden screen keeps its state (the game, the conversation) but not its key handlers.
  return (
    <SettingsContext value={settings}>
      <Activity mode={mode === 'board' ? 'visible' : 'hidden'}>
        <App key={sparSeed?.id ?? 0} modeSwitch={modeSwitch} spar={sparSeed} />
      </Activity>
      <Activity mode={mode === 'games' ? 'visible' : 'hidden'}>
        <GamesScreen
          modeSwitch={modeSwitch}
          onSpar={handleSpar}
          onDrillsAdded={handleDrillsAdded}
        />
      </Activity>
      <Activity mode={mode === 'drills' ? 'visible' : 'hidden'}>
        <DrillsScreen
          modeSwitch={modeSwitch}
          refreshSignal={drillsRefresh}
          onCardsChange={syncDueCount}
          onSpar={handleSpar}
          onGoToGames={() => selectMode('games')}
        />
      </Activity>
      <Activity mode={mode === 'repertoire' ? 'visible' : 'hidden'}>
        <RepertoireScreen modeSwitch={modeSwitch} />
      </Activity>
      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
    </SettingsContext>
  );
}
