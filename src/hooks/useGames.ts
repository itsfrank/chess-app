import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivedGame } from '../../shared/protocol';
import { fetchGames } from '../api';
import { useSettings } from '../settings';

/**
 * A chess.com player's recent games, newest first. The player from the
 * settings is listed to begin with and whenever that setting changes; another
 * player can be looked up without changing it.
 */
export function useGames() {
  const { settings, save } = useSettings();
  const mine = settings.chesscomUsername;
  const [username, setUsername] = useState(mine);
  const [games, setGames] = useState<ArchivedGame[]>([]);
  /** Where the next page starts; null when every game is listed. */
  const [older, setOlder] = useState<number | null>(null);
  /** The settings' player is looked up as soon as the screen is shown. */
  const [loading, setLoading] = useState(() => !!mine);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mineRef = useRef(mine);
  /** The settings' player as last listed here, so hiding and showing the screen keeps the list. */
  const applied = useRef('');

  /** Fetches the first page for `name`, or the page before `before` for the listed player. */
  const request = useCallback(
    async (name: string, before: number | null = null) => {
      controller.current?.abort();
      const abort = (controller.current = new AbortController());
      try {
        const page = await fetchGames(name, before, abort.signal);
        setUsername(page.username);
        setGames(previous => (before ? [...previous, ...page.games] : page.games));
        setOlder(page.older);
        // The first player looked up is taken to be the user.
        if (!mineRef.current) void save({ chesscomUsername: page.username }).catch(() => {});
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Request failed');
      } finally {
        if (controller.current === abort) setLoading(false);
      }
    },
    [save],
  );

  useEffect(() => {
    mineRef.current = mine;
    if (mine && applied.current !== mine) {
      applied.current = mine;
      void request(mine);
    }
  }, [mine, request]);
  useEffect(() => () => controller.current?.abort(), []);

  const load = (name: string, before: number | null = null) => {
    setLoading(true);
    setError('');
    return request(name, before);
  };
  return {
    username,
    games,
    loading,
    error,
    hasOlder: older !== null,
    load: (name: string) => load(name),
    loadOlder: () => older !== null && load(username, older),
  };
}
export type GamesState = ReturnType<typeof useGames>;
