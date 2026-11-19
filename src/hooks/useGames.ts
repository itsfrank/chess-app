import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivedGame } from '../../shared/protocol';
import { fetchGames } from '../api';

const USERNAME_KEY = 'chess-app.chesscom-username';

/** A chess.com player's recent games, newest first. The username is remembered between visits. */
export function useGames() {
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) ?? '');
  const [games, setGames] = useState<ArchivedGame[]>([]);
  /** Where the next page starts; null when every game is listed. */
  const [older, setOlder] = useState<number | null>(null);
  /** A remembered username is looked up as soon as the screen is shown. */
  const [loading, setLoading] = useState(() => !!username);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  /** Fetches the first page for `name`, or the page before `before` for the listed player. */
  const request = useCallback(async (name: string, before: number | null = null) => {
    controller.current?.abort();
    const abort = (controller.current = new AbortController());
    try {
      const page = await fetchGames(name, before, abort.signal);
      localStorage.setItem(USERNAME_KEY, page.username);
      setUsername(page.username);
      setGames(previous => (before ? [...previous, ...page.games] : page.games));
      setOlder(page.older);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Request failed');
    } finally {
      if (controller.current === abort) setLoading(false);
    }
  }, []);

  const listed = games.length > 0;
  useEffect(() => {
    // The first time the screen is shown; afterwards the list changes only when asked.
    if (username && !listed) void request(username);
    return () => controller.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
