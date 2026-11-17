import { useEffect, useRef, useState } from 'react';
import { OPPONENT_ELOS, type PlayerColor } from '../../shared/protocol';
import type { Opponent } from '../hooks/useOpponent';

type Mode = 'analysis' | 'maia';
const MODES: [Mode, string][] = [
  ['analysis', 'Analysis board'],
  ['maia', 'Play Maia3'],
];
const SIDES: [PlayerColor, string][] = [
  ['white', 'White'],
  ['black', 'Black'],
];

/**
 * The "New game" button and the popover that chooses what the next game will
 * be. The choices are remembered, so starting again repeats the last setup.
 */
export function GameSetup(props: {
  /** Whether a game is in progress that starting a new one would discard. */
  confirm: boolean;
  /** Starts a game against `opponent`, or a free analysis board when null. */
  onStart: (opponent: Opponent | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('analysis');
  const [color, setColor] = useState<PlayerColor>('white');
  const [elo, setElo] = useState<number>(1500);
  const root = useRef<HTMLDivElement>(null);
  const maia = mode === 'maia';

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const start = () => {
    if (props.confirm && !window.confirm('Start a new game? The current board will be cleared.'))
      return;
    props.onStart(maia ? { color, elo } : null);
    setOpen(false);
  };

  return (
    <div className="game-setup" ref={root}>
      <button
        className="new-game"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        New game
      </button>
      {open && (
        <div className="setup-popover" role="dialog" aria-label="Game setup">
          <Choice label="Mode" options={MODES} value={mode} onChange={setMode} />
          {maia && (
            <>
              <Choice label="Your side" options={SIDES} value={color} onChange={setColor} />
              <label className="setup-field">
                <span className="label">Rating</span>
                <select
                  aria-label="Opponent rating"
                  value={elo}
                  onChange={event => setElo(Number(event.target.value))}
                >
                  {OPPONENT_ELOS.map(rating => (
                    <option key={rating} value={rating}>
                      {rating} Elo
                    </option>
                  ))}
                </select>
              </label>
              <small>Maia3 plays human-like moves. The rating is a style target.</small>
            </>
          )}
          <button className="start-game" onClick={start}>
            Start game
          </button>
        </div>
      )}
    </div>
  );
}

/** A labelled row of mutually exclusive options. */
function Choice<T extends string>(props: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="setup-field" role="group" aria-label={props.label}>
      <span className="label">{props.label}</span>
      <div className="segmented">
        {props.options.map(([value, title]) => (
          <button
            key={value}
            aria-pressed={props.value === value}
            onClick={() => props.onChange(value)}
          >
            {title}
          </button>
        ))}
      </div>
    </div>
  );
}
