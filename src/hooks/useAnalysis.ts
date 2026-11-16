import { useEffect, useState } from 'react';
import type { Analysis, ExplorerResult } from '../../shared/protocol';
import { fetchAnalysis, fetchExplorer } from '../api';

/** What is known about `fen`: neither field while loading, then exactly one. */
export type PositionResult<T> = { fen: string; data?: T; error?: string };
export type AnalysisTab = 'engine' | 'explorer';

/** Wait this long on a position before looking it up, so stepping through history stays cheap. */
const SETTLE_MS = 250;

function usePositionLookup<T>(
  fen: string,
  load: (fen: string, signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  attempt: number,
): PositionResult<T> {
  const [result, setResult] = useState<PositionResult<T>>({ fen: '' });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      load(fen, controller.signal).then(
        data => setResult({ fen, data }),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ fen, error: error instanceof Error ? error.message : 'Request failed' });
        },
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fen, load, enabled, attempt]);
  // A result for another position is stale: report this one as still loading.
  return result.fen === fen ? result : { fen };
}

/**
 * Engine lines and explorer statistics for the position on the board. The
 * engine always runs because the evaluation bar needs it; the explorer is only
 * queried while its tab is open.
 */
export function useAnalysis(fen: string) {
  const [tab, setTab] = useState<AnalysisTab>('engine');
  const [showArrows, setShowArrows] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const engine = usePositionLookup<Analysis>(fen, fetchAnalysis, true, attempt);
  const explorer = usePositionLookup<ExplorerResult>(
    fen,
    fetchExplorer,
    tab === 'explorer',
    attempt,
  );
  return {
    engine,
    explorer,
    tab,
    setTab,
    showArrows,
    setShowArrows,
    retry: () => setAttempt(n => n + 1),
    /** SAN of the moves listed in the open tab, best or most played first. */
    candidates:
      (tab === 'engine' ? engine.data?.moves : explorer.data?.moves)?.map(move => move.san) ?? [],
  };
}
export type AnalysisState = ReturnType<typeof useAnalysis>;
