import { useEffect, useMemo, useState } from 'react';
import type { ArchivedGame, RepertoireReport } from '../../shared/protocol';
import { traceGame, type Trace } from '../../shared/habits';
import { repertoires } from '../api';

/**
 * Where a game left the user's repertoire for the colour they had. With
 * several repertoires for that colour, the one the game followed longest.
 * Null without a repertoire, or while they load.
 */
export function useRepertoireTrace(
  game: ArchivedGame | null,
): { name: string; trace: Trace } | null {
  const side = game?.playerColor;
  const [loaded, setLoaded] = useState<RepertoireReport[]>([]);

  useEffect(() => {
    if (!side) return;
    let current = true;
    void (async () => {
      try {
        const mine = (await repertoires.list()).filter(item => item.side === side);
        const reports = await Promise.all(mine.map(item => repertoires.get(item.id)));
        if (current) setLoaded(reports);
      } catch {
        // The note is a refinement; the review works without it.
      }
    })();
    return () => {
      current = false;
    };
  }, [side]);

  return useMemo(() => {
    if (!game) return null;
    const traces = loaded
      .filter(report => report.side === game.playerColor)
      .map(report => ({ name: report.name, trace: traceGame(report.graph, game.moves) }));
    return traces.sort((a, b) => b.trace.plies - a.trace.plies)[0] ?? null;
  }, [game, loaded]);
}
