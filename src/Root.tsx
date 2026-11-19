import { Activity, useState } from 'react';
import { App } from './App';
import { GamesScreen } from './components/Games';
import { RepertoireScreen } from './components/Repertoire';

type Mode = 'board' | 'games' | 'repertoire';
const MODES: [Mode, string][] = [
  ['board', 'Board'],
  ['games', 'My games'],
  ['repertoire', 'Repertoire'],
];
const MODE_KEY = 'chess-app.mode';

/** Switches between the board with its companion, the user's chess.com games, and the repertoire screen. */
export function Root() {
  const [mode, setMode] = useState<Mode>(() => {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.find(([name]) => name === stored)?.[0] ?? 'board';
  });
  const modeSwitch = (
    <nav className="mode-switch" aria-label="Mode">
      {MODES.map(([name, title]) => (
        <button
          key={name}
          aria-current={mode === name ? 'page' : undefined}
          onClick={() => {
            localStorage.setItem(MODE_KEY, name);
            setMode(name);
          }}
        >
          {title}
        </button>
      ))}
    </nav>
  );
  // The hidden screen keeps its state (the game, the conversation) but not its key handlers.
  return (
    <>
      <Activity mode={mode === 'board' ? 'visible' : 'hidden'}>
        <App modeSwitch={modeSwitch} />
      </Activity>
      <Activity mode={mode === 'games' ? 'visible' : 'hidden'}>
        <GamesScreen modeSwitch={modeSwitch} />
      </Activity>
      <Activity mode={mode === 'repertoire' ? 'visible' : 'hidden'}>
        <RepertoireScreen modeSwitch={modeSwitch} />
      </Activity>
    </>
  );
}
