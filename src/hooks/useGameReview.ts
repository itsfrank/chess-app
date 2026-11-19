import { useEffect, useMemo, useState } from 'react';
import type { PositionEval } from '../../shared/protocol';
import { reviewGame } from '../../shared/quality';
import { streamGameReview } from '../api';

const NO_EVALS: (PositionEval | undefined)[] = [];
const NO_PLIES: number[] = [];

/**
 * Move labels and accuracy for a finished game. The engine pass starts at once
 * and fills in move by move; positions searched before come back immediately,
 * also when they were searched less deeply than is configured now.
 * `moves` must keep its identity for as long as the game is the same.
 */
export function useGameReview(moves: string[]) {
  const [evals, setEvals] = useState(NO_EVALS);
  /** Positions whose verdict comes from a shallower search than is configured. */
  const [stale, setStale] = useState(NO_PLIES);
  const [depth, setDepth] = useState(0);
  /** Opening half-moves known to be theory. */
  const [book, setBook] = useState(0);
  const [error, setError] = useState('');
  const [run, setRun] = useState({ attempt: 0, refresh: false });

  useEffect(() => {
    if (!moves.length) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamGameReview(moves, run.refresh, abort.signal)) {
          if ('book' in event) setBook(event.book);
          else if (!('ply' in event)) setDepth(event.depth);
          else {
            const { ply, stale: shallow, ...result } = event;
            setEvals(previous => {
              const next = previous.slice();
              next[ply] = result;
              return next;
            });
            setStale(previous =>
              shallow === previous.includes(ply)
                ? previous
                : shallow
                  ? [...previous, ply]
                  : previous.filter(other => other !== ply),
            );
          }
        }
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Request failed');
      }
    })();
    return () => abort.abort();
  }, [moves, run]);

  const review = useMemo(() => reviewGame(moves, evals, book), [moves, evals, book]);
  const restart = (refresh: boolean) => {
    setError('');
    setRun(previous => ({ attempt: previous.attempt + 1, refresh }));
  };
  return {
    review,
    /** How many positions were searched less deeply than `depth`, the configured one. */
    stale: stale.length,
    depth,
    /** Whether positions from a shallower search are being searched again. */
    refreshing: run.refresh && stale.length > 0,
    /** Why the pass stopped early, if it did. */
    error,
    retry: () => restart(run.refresh),
    /** Searches again every position that was searched less deeply than is configured. */
    refresh: () => restart(true),
  };
}
