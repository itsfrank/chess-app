import { buildPlayerProfile, profileDigest } from '../shared/profile.ts';
import type { ArchivedGame, GameArchivePage, PlayerProfile } from '../shared/protocol.ts';
import type { GameReview } from '../shared/quality.ts';
import { listGames } from './chesscom.ts';

const PROFILE_TTL_MS = 120_000;
const PROFILE_PAGES = 2;

export type ProfileServiceOptions = {
  fetchGames?: (
    username: string,
    before?: number,
    signal?: AbortSignal,
  ) => Promise<GameArchivePage>;
  cachedReview?: (moves: string[]) => GameReview | null;
};

type CachedEntry = {
  until: number;
  profile: PlayerProfile;
};

/**
 * Builds and caches a cross-game player profile from recent chess.com games plus any
 * Stockfish game reviews already stored on disk.
 */
export class ProfileService {
  private readonly fetchGames: NonNullable<ProfileServiceOptions['fetchGames']>;
  private readonly cachedReview: NonNullable<ProfileServiceOptions['cachedReview']>;
  private readonly cache = new Map<string, CachedEntry>();

  constructor(options: ProfileServiceOptions = {}) {
    this.fetchGames = options.fetchGames ?? listGames;
    this.cachedReview = options.cachedReview ?? (() => null);
  }

  /** Fetches recent games (up to ~100) and builds a cross-game profile for `username`. */
  async get(username: string, signal?: AbortSignal, refresh = false): Promise<PlayerProfile> {
    const key = username.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.until > Date.now()) return cached.profile;

    const games: ArchivedGame[] = [];
    let before: number | undefined;
    let displayName = username.trim();
    for (let page = 0; page < PROFILE_PAGES; page++) {
      const result = await this.fetchGames(key, before, signal);
      if (page === 0) displayName = result.username;
      games.push(...result.games);
      if (result.older === null) break;
      before = result.older;
    }

    const reviews = new Map<string, GameReview>();
    for (const game of games) {
      const review = this.cachedReview(game.moves);
      if (review) reviews.set(game.url, review);
    }

    const profile = buildPlayerProfile(displayName, games, reviews);
    this.cache.set(key, { until: Date.now() + PROFILE_TTL_MS, profile });
    return profile;
  }

  /**
   * Returns a compact digest of the last built profile for `username` without doing
   * network I/O, suitable for injecting into live coach turns.
   */
  cachedDigest(username: string) {
    const key = username.trim().toLowerCase();
    if (!key) return null;
    const entry = this.cache.get(key);
    return entry ? profileDigest(entry.profile) : null;
  }
}
