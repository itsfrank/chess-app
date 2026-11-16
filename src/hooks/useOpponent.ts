import { useEffect, useEffectEvent, useState } from 'react';
import { Chess } from 'chess.js';
import type { PlayerColor, Snapshot } from '../../shared/protocol';
import { requestOpponentMove } from '../api';

export type Opponent = { color: PlayerColor; elo: number };

const TIMEOUT_MS = 60_000;

/**
 * Asks Maia3 for a move whenever `enabled` (it is the engine's turn in a live
 * game) and reports it through `onMove`. Any change to the position, opponent
 * or `enabled` cancels the request in flight, so a stale reply is never played.
 */
export function useOpponent(options: {
  snapshot: Snapshot;
  opponent: Opponent | null;
  enabled: boolean;
  onMove: (san: string) => void;
}) {
  const { snapshot, opponent, enabled } = options;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const onMove = useEffectEvent(options.onMove);

  useEffect(() => {
    if (!enabled || !opponent) return;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);

    requestOpponentMove(
      { ...snapshot, playerColor: opponent.color, elo: opponent.elo },
      controller.signal,
    )
      .then(reply => {
        if (controller.signal.aborted) return;
        const board = new Chess(snapshot.fen);
        const move = board.move(reply.move);
        if (board.fen() !== reply.fen) throw new Error('Maia3 returned an inconsistent position');
        onMove(move.san);
      })
      .catch((failure: unknown) => {
        if (timedOut) setError('Maia3 took too long. Please retry.');
        else if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
      setError('');
    };
  }, [enabled, opponent, snapshot, attempt]);

  return {
    thinking: enabled && !error,
    error,
    retry: () => setAttempt(n => n + 1),
  };
}
