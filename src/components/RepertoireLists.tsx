import { useState } from 'react';
import type { Finding } from '../../shared/consolidation';
import { isCommon, type Habit } from '../../shared/habits';
import type { RepertoireReport } from '../../shared/protocol';
import { formatPath } from '../../shared/repertoire';
import type { Audit, Verdict } from '../../shared/soundness';
import { useSettings } from '../settings';
import type { View } from './Repertoire';

/** Repertoire moves losing at least this many centipawns to the engine's choice are listed. */
export const AUDIT_THRESHOLD = 50;

export type Proposal = {
  finding: Finding;
  /** Null until the engine has searched every position involved. */
  verdict: Verdict | null;
  status: 'sound' | 'pending' | 'unsound';
  /** Positions that would no longer have to be known; negative when the change adds some. */
  saved: number;
  reach: number;
  dismissed: boolean;
  /** Set when the proposal comes from the player's own games rather than the repertoire's shape. */
  habit?: Habit;
};

/** A move with its number, given the half-moves played before it: "3. Nf3" or "3… d5". */
export const numbered = (ply: number, san: string) =>
  `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'} ${san}`;

/** Centipawns from the player's side as pawns: "+0.35", "−1.20", or "mate". */
function pawns(centipawns: number): string {
  if (Math.abs(centipawns) >= 9000) return centipawns > 0 ? 'winning mate' : 'mated';
  const sign = centipawns > 0 ? '+' : centipawns < 0 ? '−' : '';
  return sign + (Math.abs(centipawns) / 100).toFixed(2);
}

function share(report: RepertoireReport, key: string): string {
  const reach = report.reach[key] ?? 0;
  const text = reach >= 0.001 ? `${(reach * 100).toFixed(1)}%` : 'under 0.1%';
  return `${report.reachComplete ? '' : '≈ '}${text} of games`;
}

const pathOf = (report: RepertoireReport, key: string) => report.graph.nodes[key]?.path ?? [];

type ListProps = { report: RepertoireReport; onView: (view: View) => void };

export function ProposalList(
  props: ListProps & {
    proposals: Proposal[];
    tolerance: number;
    busy: boolean;
    onAccept: (findingId: string) => void;
    onDismiss: (findingId: string, dismissed: boolean) => void;
  },
) {
  const { report, proposals, tolerance, busy, onView, onAccept, onDismiss } = props;
  const [open, setOpen] = useState('');
  const [knownOnly, setKnownOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showUnsound, setShowUnsound] = useState(true);
  const hidden = proposals.filter(item => item.dismissed).length;
  const shown = proposals.filter(
    item =>
      (showDismissed || !item.dismissed) &&
      (!knownOnly || item.finding.openLines === 0) &&
      (showUnsound || item.status !== 'unsound'),
  );

  return (
    <>
      <div className="list-filters">
        <label className="switch-label">
          <input
            type="checkbox"
            className="switch"
            checked={knownOnly}
            onChange={event => setKnownOnly(event.target.checked)}
          />
          Only known positions
        </label>
        <label className="switch-label">
          <input
            type="checkbox"
            className="switch"
            checked={showUnsound}
            onChange={event => setShowUnsound(event.target.checked)}
          />
          Show unsound
        </label>
        {hidden > 0 && (
          <label className="switch-label">
            <input
              type="checkbox"
              className="switch"
              checked={showDismissed}
              onChange={event => setShowDismissed(event.target.checked)}
            />
            Dismissed ({hidden})
          </label>
        )}
      </div>
      {!shown.length && <p className="repertoire-empty">No proposals match.</p>}
      {shown.map(item => {
        const { finding, verdict, saved } = item;
        const path = pathOf(report, finding.key);
        const view = { path, current: finding.current, proposed: finding.proposed };
        const expanded = open === finding.id;
        return (
          <article
            key={finding.id}
            className={`finding ${item.status}${item.dismissed ? ' dismissed' : ''}`}
            aria-expanded={expanded}
          >
            <button
              className="finding-summary"
              onClick={() => {
                setOpen(expanded ? '' : finding.id);
                onView(view);
              }}
            >
              {item.habit ? (
                <span className="finding-saved" title="Games in which you played this move here">
                  ×{item.habit.count}
                </span>
              ) : (
                <span
                  className="finding-saved"
                  title="Change in positions you have to know; an upper bound while new lines are needed"
                >
                  {finding.openLines > 0 && saved > 0 && '≤ '}
                  {saved > 0 ? `−${saved}` : saved < 0 ? `+${-saved}` : '0'}
                </span>
              )}
              <span className="finding-move">
                <s>{numbered(path.length, finding.current)}</s> → {finding.proposed}
              </span>
              <span className="finding-eval">
                {verdict ? pawns(verdict.delta) : '…'}
                {item.status === 'unsound' && ' ⚠'}
              </span>
              <span className="finding-path">{formatPath(path) || 'First move'}</span>
              <span className="finding-tags">
                {item.habit && isCommon(item.habit) && item.status === 'sound' && (
                  <i className="suggested">suggested</i>
                )}
                {item.habit && (
                  <i>
                    repertoire move played {item.habit.followed}
                    {item.habit.followed === 1 ? ' time' : ' times'}
                  </i>
                )}
                {finding.peers && <i>usual move ×{finding.peers.count}</i>}
                {finding.direct && <i>known position</i>}
                {finding.openLines > 0 && (
                  <i className="warn">
                    {finding.openLines} new line{finding.openLines > 1 ? 's' : ''}
                  </i>
                )}
              </span>
            </button>
            {expanded && (
              <div className="finding-detail">
                {item.habit && (
                  <p>
                    You played {finding.proposed} here in{' '}
                    {item.habit.games.slice(0, 5).map((game, index) => (
                      <a key={game.url} href={game.url} target="_blank" rel="noreferrer">
                        {index > 0 && ', '}
                        {new Date(game.playedAt).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </a>
                    ))}
                    {item.habit.count > 5 && ` and ${item.habit.count - 5} more`}, and the
                    repertoire&rsquo;s {finding.current} in {item.habit.followed}{' '}
                    {item.habit.followed === 1 ? 'game' : 'games'}.
                  </p>
                )}
                <p>
                  Positions to know: {finding.decisionsBefore} → {finding.decisionsAfter}. This
                  position arises in {share(report, finding.key)}.
                </p>
                {verdict ? (
                  <p>
                    Stockfish scores your {finding.current} at {pawns(verdict.current)} and{' '}
                    {finding.proposed} at {pawns(verdict.proposed)}:{' '}
                    {item.status === 'sound'
                      ? `within your ${(tolerance / 100).toFixed(2)}-pawn tolerance.`
                      : `${pawns(verdict.delta)} pawns, outside your tolerance.`}
                  </p>
                ) : (
                  <p>Not yet checked by Stockfish.</p>
                )}
                {finding.peers && (
                  <p>
                    With your pieces arranged like this you play {finding.proposed} in{' '}
                    {finding.peers.count} positions and {finding.current} in{' '}
                    {finding.peers.currentCount}.
                  </p>
                )}
                {finding.direct && (
                  <p>
                    {finding.proposed} reaches a position you already know from{' '}
                    <em>{formatPath(pathOf(report, finding.after.key))}</em>.
                  </p>
                )}
                {finding.plan.length > 0 && (
                  <ul className="plan">
                    {finding.plan.map(line => {
                      const reply = numbered(path.length + 1, line.reply);
                      const answer = line.move && numbered(path.length + 2, line.move);
                      const moves = [
                        ...path,
                        finding.proposed,
                        line.reply,
                        ...(line.move ? [line.move] : []),
                      ];
                      return (
                        <li key={line.reply}>
                          <button onClick={() => onView({ path: moves })}>
                            {reply}
                            {answer && ` ${answer}`}
                          </button>{' '}
                          {line.joins ? (
                            <>
                              rejoins <em>{formatPath(pathOf(report, line.joins))}</em>
                            </>
                          ) : (
                            <span className="warn">needs a new line</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="finding-actions">
                  <button className="primary" disabled={busy} onClick={() => onAccept(finding.id)}>
                    Accept
                  </button>
                  <button disabled={busy} onClick={() => onDismiss(finding.id, !item.dismissed)}>
                    {item.dismissed ? 'Restore' : 'Dismiss'}
                  </button>
                  <button onClick={() => onView({ path: [...path, finding.proposed] })}>
                    Show after {finding.proposed}
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}

/**
 * The player's own games against the repertoire: a form to fetch them, how
 * they left it, and each move played instead of the repertoire's as a
 * proposal to adopt it.
 */
export function HabitList(
  props: Parameters<typeof ProposalList>[0] & { onSync: (username: string) => void },
) {
  const { report, busy, onSync } = props;
  const { habits } = report;
  const { settings, save } = useSettings();
  const [name, setName] = useState(() => habits?.username ?? settings.chesscomUsername);
  return (
    <>
      <form
        className="games-form habit-form"
        onSubmit={event => {
          event.preventDefault();
          if (!name.trim()) return;
          // The first player looked up is taken to be the user.
          if (!settings.chesscomUsername)
            void save({ chesscomUsername: name.trim() }).catch(() => {});
          onSync(name.trim());
        }}
      >
        <label>
          <span className="label">chess.com username</span>
          <input
            type="text"
            value={name}
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            placeholder="Username"
            onChange={event => setName(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Working…' : habits ? 'Refresh games' : 'Check my games'}
        </button>
      </form>
      {habits ? (
        <>
          <p className="repertoire-note">
            {habits.games} recent games as {report.side}, checked{' '}
            {new Date(habits.fetchedAt).toLocaleDateString()}: you left the repertoire first in{' '}
            {habits.exits.deviation}, your opponent in {habits.exits.uncovered}, and{' '}
            {habits.exits['line-end'] + habits.exits['game-end']} stayed in it to the end of the
            line. Below are the moves you played instead of the repertoire&rsquo;s. One is suggested
            when you played it more than once, at least as often as the repertoire move, and
            Stockfish scores it within your tolerance.
          </p>
          {habits.habits.length ? (
            <ProposalList {...props} />
          ) : (
            <p className="repertoire-empty">You never left the repertoire by your own move.</p>
          )}
        </>
      ) : (
        <p className="repertoire-empty">
          Fetch your recent chess.com games to see where you leave this repertoire, and which of
          your own moves are sound enough to adopt instead.
        </p>
      )}
    </>
  );
}

export function AuditList({ report, audits, onView }: ListProps & { audits: Audit[] }) {
  if (!Object.keys(report.evals).length) {
    return <p className="repertoire-empty">Run the analysis to check your moves with Stockfish.</p>;
  }
  if (!audits.length) {
    return (
      <p className="repertoire-empty">
        No repertoire move checked so far loses {AUDIT_THRESHOLD / 100} pawns or more to the
        engine's choice.
      </p>
    );
  }
  return audits.map(audit => {
    const path = pathOf(report, audit.key);
    return (
      <article key={audit.key + audit.san} className="finding unsound">
        <button
          className="finding-summary"
          onClick={() => onView({ path, current: audit.san, proposed: audit.best ?? undefined })}
        >
          <span className="finding-saved">{pawns(-audit.loss)}</span>
          <span className="finding-move">{numbered(path.length, audit.san)}</span>
          <span className="finding-eval">{pawns(audit.score)}</span>
          <span className="finding-path">{formatPath(path) || 'First move'}</span>
          <span className="finding-tags">
            {audit.best && <i>engine: {audit.best}</i>}
            <i>{share(report, audit.key)}</i>
          </span>
        </button>
      </article>
    );
  });
}

export function RuleList({ report, onView }: ListProps) {
  // Rules with exceptions first: those are the ones worth a look.
  const rules = [...report.rules].sort(
    (a, b) => Number(b.moves.length > 1) - Number(a.moves.length > 1),
  );
  return rules.map(rule => {
    const [usual, ...exceptions] = rule.moves;
    return (
      <article key={rule.signature} className="rule">
        <h3>
          {rule.setup} <span>→</span> {usual.san}
          <span className="count">
            {usual.keys.length} of {rule.total}
          </span>
        </h3>
        {exceptions.map(exception => (
          <p key={exception.san}>
            <strong>{exception.san}</strong>
            {exception.keys.map(key => {
              const path = pathOf(report, key);
              const proposal = report.findings.find(
                finding => finding.key === key && finding.proposed === usual.san,
              );
              return (
                <button
                  key={key}
                  onClick={() =>
                    onView({ path, current: exception.san, proposed: proposal?.proposed })
                  }
                >
                  {formatPath(path) || 'First move'}
                </button>
              );
            })}
          </p>
        ))}
        {!exceptions.length && (
          <p>
            <button
              onClick={() => onView({ path: pathOf(report, usual.keys[0]), current: usual.san })}
            >
              No exceptions
            </button>
          </p>
        )}
      </article>
    );
  });
}

export function AcceptedList(
  props: ListProps & { busy: boolean; onRevert: (changeId: string) => void },
) {
  const { report, busy, onView, onRevert } = props;
  if (!report.changes.length) {
    return (
      <p className="repertoire-empty">
        Changes you accept are recorded here as deviations from the imported PGN, so you can apply
        them to the original later.
      </p>
    );
  }
  return report.changes.map(change => (
    <article key={change.id} className={`finding${change.active ? '' : ' dismissed'}`}>
      <div className="finding-summary">
        <span className="finding-saved" />
        <button
          className="finding-move"
          onClick={() => onView({ path: change.path, current: change.to })}
        >
          <s>{numbered(change.path.length, change.from)}</s> → {change.to}
        </button>
        <button className="finding-eval" disabled={busy} onClick={() => onRevert(change.id)}>
          Revert
        </button>
        <span className="finding-path">{formatPath(change.path) || 'First move'}</span>
        <span className="finding-tags">
          <i>{new Date(change.acceptedAt).toLocaleDateString()}</i>
          {!change.active && <i className="warn">no longer applies</i>}
        </span>
      </div>
    </article>
  ));
}
