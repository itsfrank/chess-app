import { useEffect, useState } from 'react';
import type { PlayerProfile, RecordSplit } from '../../shared/protocol';
import { fetchProfile } from '../api';

const pct = (part: number, total: number) =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';

const splitText = (split: RecordSplit) => `${split.wins}–${split.draws}–${split.losses}`;

/** Compact collapsible summary of cross-game patterns above the games list. */
export function PlayerProfileCard(props: { username: string; refreshKey: number }) {
  const { username, refreshKey } = props;
  const requestKey = `${username}:${refreshKey}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    username: string;
    profile: PlayerProfile | null;
  }>({ key: '', username: '', profile: null });
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!username) return;
    const controller = new AbortController();
    fetchProfile(username, refreshKey > 0, controller.signal)
      .then(data => {
        if (!controller.signal.aborted) {
          setLoaded({ key: requestKey, username, profile: data });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded(prev =>
            prev.username === username
              ? { ...prev, key: requestKey }
              : { key: requestKey, username, profile: null },
          );
        }
      });
    return () => controller.abort();
  }, [username, refreshKey, requestKey]);

  const profile = loaded.username === username ? loaded.profile : null;
  const loading = Boolean(username) && loaded.key !== requestKey;

  if (!username || (!profile && !loading)) return null;
  if (!profile) {
    return (
      <section className="profile-card" aria-label="Player patterns">
        <div className="profile-header">
          <span className="label">Your patterns</span>
          <span className="profile-meta">Analyzing recent games…</span>
        </div>
      </section>
    );
  }
  if (!profile.gamesAnalyzed) return null;

  const {
    overall,
    white,
    black,
    timeoutLosses,
    reviewedGames,
    avgAccuracy,
    phaseErrors,
    clockHabits,
  } = profile;
  const totalPhase = phaseErrors.opening + phaseErrors.middlegame + phaseErrors.endgame;

  return (
    <section className="profile-card" aria-label="Player patterns">
      <div className="profile-header">
        <button
          type="button"
          className="profile-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="label">Your patterns</span>
          <span className="profile-meta">
            Last {profile.gamesAnalyzed} games · {splitText(overall)}
            {avgAccuracy.overall !== null && ` · ${avgAccuracy.overall.toFixed(1)}% acc`}
          </span>
        </button>
      </div>
      {open && (
        <div className="profile-body">
          <div className="profile-grid">
            <div className="profile-stat">
              <span className="label">White / Black</span>
              <strong>
                {splitText(white)} / {splitText(black)}
              </strong>
            </div>
            {overall.losses > 0 && (
              <div className="profile-stat">
                <span className="label">Losses on time</span>
                <strong className={timeoutLosses / overall.losses >= 0.25 ? 'warn' : undefined}>
                  {timeoutLosses}/{overall.losses} ({pct(timeoutLosses, overall.losses)})
                </strong>
              </div>
            )}
            {reviewedGames > 0 && (
              <div className="profile-stat">
                <span className="label">Reviewed ({reviewedGames})</span>
                <strong>
                  {avgAccuracy.overall !== null ? `${avgAccuracy.overall.toFixed(1)}%` : '—'}
                  <small>
                    {' '}
                    ({profile.errorCounts.blunders}B · {profile.errorCounts.mistakes}M)
                  </small>
                </strong>
              </div>
            )}
            {totalPhase > 0 && (
              <div className="profile-stat">
                <span className="label">Errors by phase</span>
                <strong>
                  Open {phaseErrors.opening} · Mid {phaseErrors.middlegame} · End{' '}
                  {phaseErrors.endgame}
                </strong>
              </div>
            )}
          </div>
          {clockHabits.timedErrors > 0 && (
            <p className="profile-note">
              <strong>Clock habits:</strong> {clockHabits.impulsiveErrors} fast/impulsive ·{' '}
              {clockHabits.timeTroubleErrors} in time trouble · {clockHabits.deepThinkErrors} after
              long thinks ({clockHabits.timedErrors} timed errors)
            </p>
          )}
          {profile.weakestOpenings.length > 0 && (
            <p className="profile-note">
              <strong>Leaky openings:</strong>{' '}
              {profile.weakestOpenings
                .slice(0, 3)
                .map(stat => `${stat.name} (${stat.color[0].toUpperCase()} ${splitText(stat)})`)
                .join(' · ')}
            </p>
          )}
          {reviewedGames === 0 && (
            <p className="profile-note">
              Open a game to run Stockfish review — accuracy, phase leaks, and clock habits will
              aggregate here automatically.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
