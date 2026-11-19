import { useCallback, useEffect, useState } from 'react';
import type { RepertoireReport, RepertoireSummary } from '../../shared/protocol';
import { repertoires } from '../api';

const SELECTED_KEY = 'chess-app.repertoire';
const POLL_MS = 2500;
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/**
 * The imported repertoires and the report for the selected one. While its
 * background analysis runs the report is refreshed every few seconds.
 */
export function useRepertoire() {
  const [list, setList] = useState<RepertoireSummary[] | null>(null);
  const [id, setId] = useState(() => localStorage.getItem(SELECTED_KEY) ?? '');
  const [report, setReport] = useState<RepertoireReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const select = useCallback((next: string) => {
    localStorage.setItem(SELECTED_KEY, next);
    setId(next);
  }, []);

  useEffect(() => {
    let current = true;
    repertoires.list().then(
      found => {
        if (!current) return;
        setList(found);
        // Fall back to the first repertoire when the remembered one is gone.
        if (!found.some(item => item.id === id)) select(found[0]?.id ?? '');
      },
      failure => current && setError(message(failure)),
    );
    return () => {
      current = false;
    };
    // Only on mount: later changes to the list are applied by the actions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = report?.id === id ? report : null;
  const running = shown?.job.running ?? false;
  useEffect(() => {
    if (!id) return;
    let current = true;
    const load = () =>
      repertoires.get(id).then(
        next => current && setReport(next),
        failure => current && setError(message(failure)),
      );
    if (!running) {
      void load();
      return () => {
        current = false;
      };
    }
    const timer = setInterval(load, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [id, running]);

  /** Runs a request that answers with the updated report. */
  const act = useCallback(async (request: () => Promise<RepertoireReport>) => {
    setBusy(true);
    setError('');
    try {
      const next = await request();
      setReport(next);
      setList(await repertoires.list());
      return next;
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    list,
    id,
    select,
    report: shown,
    error,
    busy,
    importPgn: async (pgn: string) => {
      const next = await act(() => repertoires.import(pgn));
      if (next) select(next.id);
    },
    remove: async () => {
      setBusy(true);
      try {
        await repertoires.remove(id);
        const remaining = await repertoires.list();
        setList(remaining);
        setReport(null);
        select(remaining[0]?.id ?? '');
      } catch (failure) {
        setError(message(failure));
      } finally {
        setBusy(false);
      }
    },
    accept: (findingId: string) => act(() => repertoires.accept(id, { findingId })),
    revert: (changeId: string) => act(() => repertoires.revert(id, { changeId })),
    dismiss: (findingId: string, dismissed: boolean) =>
      act(() => repertoires.dismiss(id, { findingId, dismissed })),
    analyze: (ratings?: number[]) => act(() => repertoires.analyze(id, { ratings })),
    stop: () => act(() => repertoires.stop(id, {})),
  };
}
export type RepertoireState = ReturnType<typeof useRepertoire>;
