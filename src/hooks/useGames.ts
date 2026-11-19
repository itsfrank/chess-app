import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivedGame } from '../../shared/protocol';
import { fetchGames } from '../api';
import { useSettings } from '../settings';

/**
 * The recent games of the chess.com player named in the settings, newest
 * first. They are listed when the screen first shows and whenever that
 * setting changes.
 */
export function useGames() {
  const username = useSettings().settings.chesscomUsername;
  const [listed, setListed] = useState<{ username: string; games: ArchivedGame[] }>({
    username: '',
    games: [],
  });
  /** Where the next page starts; null when every game is listed. */
  const [older, setOlder] = useState<number | null>(null);
  /** The settings' player is looked up as soon as the screen is shown. */
  const [loading, setLoading] = useState(() => !!username);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  /** The player last listed, so that hiding and showing the screen keeps the list. */
  const applied = useRef('');

  /** Fetches the first page for `name`, or the page before `before`. */
  const request = useCallback(async (name: string, before: number | null = null) => {
    controller.current?.abort();
    const abort = (controller.current = new AbortController());
    try {
      const page = await fetchGames(name, before, abort.signal);
      setListed(previous => ({
        username: name,
        games: before ? [...previous.games, ...page.games] : page.games,
      }));
      setOlder(page.older);
      setError('');
    } catch (failure) {
      if (abort.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : 'Request failed');
      if (!before) setListed({ username: name, games: [] });
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (username && applied.current !== username) {
      applied.current = username;
      void request(username);
    }
  }, [username, request]);
  useEffect(
    () => () => {
      // A lookup cut short by the screen being hidden starts again when it is shown.
      if (!controller.current) return;
      controller.current.abort();
      controller.current = null;
      applied.current = '';
    },
    [],
  );

  const load = (before: number | null = null) => {
    setLoading(true);
    return request(username, before);
  };
  // Another player's games are never shown under the current name.
  const current = listed.username === username;
  return {
    username,
    games: current ? listed.games : [],
    loading: loading || (!!username && !current),
    error: current ? error : '',
    hasOlder: current && older !== null,
    refresh: () => load(),
    loadOlder: () => older !== null && load(older),
  };
}
export type GamesState = ReturnType<typeof useGames>;
