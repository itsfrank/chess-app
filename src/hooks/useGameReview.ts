import { useEffect, useMemo, useState } from 'react';
import type { PositionEval } from '../../shared/protocol';
import { reviewGame } from '../../shared/quality';
import { streamGameReview } from '../api';

const NO_EVALS: (PositionEval | undefined)[] = [];

/**
 * Move labels and accuracy for a finished game. The engine pass starts at once
 * and fills in move by move; positions searched before come back immediately.
 * `moves` must keep its identity for as long as the game is the same.
 */
export function useGameReview(moves: string[]) {
  const [evals, setEvals] = useState(NO_EVALS);
  /** Opening half-moves known to be theory. */
  const [book, setBook] = useState(0);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!moves.length) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamGameReview(moves, abort.signal)) {
          if ('book' in event) {
            setBook(event.book);
            continue;
          }
          const { ply, ...result } = event;
          setEvals(previous => {
            const next = previous.slice();
            next[ply] = result;
            return next;
          });
        }
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Request failed');
      }
    })();
    return () => abort.abort();
  }, [moves, attempt]);

  const review = useMemo(() => reviewGame(moves, evals, book), [moves, evals, book]);
  return {
    review,
    /** Why the pass stopped early, if it did. */
    error,
    retry: () => {
      setError('');
      setAttempt(count => count + 1);
    },
  };
}
