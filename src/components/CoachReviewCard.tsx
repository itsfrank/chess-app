import { numberedMove, type TurningPoint } from '../../shared/quality';

export type CoachSession = {
  points: TurningPoint[];
  /** Current turning-point index; equals `points.length` on the summary screen. */
  step: number;
  phase: 'think' | 'revealed';
  /** The player's candidate move (SAN) played on the board before revealing. */
  attempt: string | null;
  /** Optional explanation of what the player was aiming for. */
  note: string;
  /** Number of turning points where the player found the engine's top move. */
  hits: number;
};

/** Guided "Think First" card shown above the companion while stepping through key turning points. */
export function CoachReviewCard(props: {
  session: CoachSession;
  onNoteChange: (note: string) => void;
  onResetAttempt: () => void;
  onReveal: (withAttempt: boolean) => void;
  onNext: () => void;
  onJumpToPoint: (index: number) => void;
  onSaveDrill?: (point: TurningPoint) => void;
  isDrillSaved?: (index: number) => boolean;
  onSparPoint?: (point: TurningPoint) => void;
  onExit: () => void;
}) {
  const {
    session,
    onNoteChange,
    onResetAttempt,
    onReveal,
    onNext,
    onJumpToPoint,
    onSaveDrill,
    isDrillSaved,
    onSparPoint,
    onExit,
  } = props;
  const { points, step, phase, attempt, note, hits } = session;

  if (step >= points.length) {
    return (
      <section className="coach-card" aria-label="Coach review summary">
        <div className="coach-card-head">
          <span className="label">Coach review complete</span>
          <button type="button" className="coach-link" onClick={onExit}>
            Done
          </button>
        </div>
        <p className="coach-summary-text">
          You found the top engine move on{' '}
          <strong>
            {hits} of {points.length}
          </strong>{' '}
          key {points.length === 1 ? 'moment' : 'moments'}.
        </p>
        <div className="coach-moment-chips">
          {points.map(point => (
            <button
              key={point.index}
              type="button"
              className={`coach-chip quality-${point.review.quality.id}`}
              title={`Jump to ${numberedMove(point.index, point.played)}`}
              onClick={() => onJumpToPoint(point.index)}
            >
              {numberedMove(point.index, point.played)}
              {point.best && ` → ${point.best}`}
            </button>
          ))}
        </div>
      </section>
    );
  }

  const point = points[step];
  const gameMove = numberedMove(point.index, point.played);
  const sideToMove = point.index % 2 === 0 ? 'White' : 'Black';
  const isLast = step === points.length - 1;
  const matchedBest = Boolean(attempt && point.best && attempt === point.best);
  const saved = isDrillSaved?.(point.index) ?? false;

  return (
    <section className="coach-card" aria-label="Guided coach review">
      <div className="coach-card-head">
        <span className="label">
          Moment {step + 1} of {points.length} · {sideToMove} to move
        </span>
        <span className={`coach-tag quality-${point.review.quality.id}`}>
          {point.review.quality.label}
        </span>
        <button type="button" className="coach-link" onClick={onExit}>
          Exit
        </button>
      </div>

      {phase === 'think' ? (
        <>
          <p className="coach-prompt">
            In the game you played <strong>{gameMove}</strong>. Before checking Stockfish, play a
            better move on the board.
          </p>
          {attempt ? (
            <form
              className="coach-attempt-form"
              onSubmit={event => {
                event.preventDefault();
                onReveal(true);
              }}
            >
              <div className="coach-attempt-row">
                <span>
                  Your try: <strong>{numberedMove(point.index, attempt)}</strong>
                </span>
                <button type="button" className="coach-link" onClick={onResetAttempt}>
                  Try another
                </button>
              </div>
              <div className="coach-idea-row">
                <input
                  type="text"
                  value={note}
                  maxLength={240}
                  placeholder="What's your idea? (optional)"
                  aria-label="Your idea for this move"
                  onChange={event => onNoteChange(event.target.value)}
                />
                <button type="submit" className="coach-primary">
                  Check with coach
                </button>
              </div>
            </form>
          ) : (
            <div className="coach-actions">
              <span className="coach-hint">
                Eval bar and engine lines are hidden until you commit.
              </span>
              <button type="button" className="coach-link" onClick={() => onReveal(false)}>
                Reveal answer
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="coach-verdict">
            {matchedBest ? (
              <strong className="coach-hit">★ Exact engine move ({attempt})!</strong>
            ) : attempt === point.played ? (
              <>
                Same move as in the game (<strong>{attempt}</strong>). Engine prefers{' '}
                <strong>{point.best ?? 'another line'}</strong>.
              </>
            ) : attempt ? (
              <>
                You tried <strong>{attempt}</strong> · Game: <strong>{point.played}</strong> ·
                Engine: <strong>{point.best ?? '—'}</strong>
              </>
            ) : (
              <>
                Game: <strong>{gameMove}</strong> · Engine prefers{' '}
                <strong>{point.best ?? '—'}</strong>
              </>
            )}
          </p>
          <div className="coach-actions">
            <div className="coach-action-group">
              {onSaveDrill && point.best && (
                <button
                  type="button"
                  className="coach-link"
                  disabled={saved}
                  onClick={() => onSaveDrill(point)}
                >
                  {saved ? 'Saved to drills' : 'Save drill'}
                </button>
              )}
              {onSparPoint && (
                <button type="button" className="coach-link" onClick={() => onSparPoint(point)}>
                  Spar vs Maia3
                </button>
              )}
            </div>
            <button type="button" className="coach-primary" onClick={onNext}>
              {isLast ? 'Finish review' : 'Next moment →'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
