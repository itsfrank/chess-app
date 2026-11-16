import { useState } from 'react';
import { OPPONENT_ELOS, type PlayerColor } from '../../shared/protocol';
import type { Opponent } from '../hooks/useOpponent';
import { Icon } from './Icon';

/** Chooses what the next game will be. Nothing applies until "New game" is pressed. */
export function GameSetup(props: {
  /** Whether a game is in progress that "New game" would discard. */
  confirm: boolean;
  /** Starts a game against `opponent`, or a free analysis board when null. */
  onStart: (opponent: Opponent | null) => void;
}) {
  const [mode, setMode] = useState<'analysis' | 'maia'>('analysis');
  const [color, setColor] = useState<PlayerColor>('white');
  const [elo, setElo] = useState<number>(1500);
  const maia = mode === 'maia';

  const start = () => {
    if (props.confirm && !window.confirm('Start a new game? The current board will be cleared.'))
      return;
    props.onStart(maia ? { color, elo } : null);
  };

  return (
    <div className="opponent-setup" aria-label="Game setup">
      <div className="setup-fields">
        <label>
          <span>Mode</span>
          <select
            aria-label="Game mode"
            value={mode}
            onChange={event => setMode(event.target.value as typeof mode)}
          >
            <option value="analysis">Analysis board</option>
            <option value="maia">Play Maia3</option>
          </select>
        </label>
        <label>
          <span>Your side</span>
          <select
            aria-label="Your side"
            disabled={!maia}
            value={color}
            onChange={event => setColor(event.target.value as PlayerColor)}
          >
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
        <label>
          <span>Rating</span>
          <select
            aria-label="Opponent rating"
            disabled={!maia}
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
        <button onClick={start}>
          <Icon name="plus" size={16} />
          New game
        </button>
      </div>
      <small title="Maia3 plays human-like moves. Rating is a style target, not a certified strength.">
        Settings apply to new games · Maia3 rating is a style target
      </small>
    </div>
  );
}
