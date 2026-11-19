import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Chess } from 'chess.js';
import { RATING_BUCKETS, type Annotation, type RepertoireReport } from '../../shared/protocol';
import { positionKey } from '../../shared/repertoire';
import { auditMoves, verdictOf } from '../../shared/soundness';
import { useRepertoire, type RepertoireState } from '../hooks/useRepertoire';
import { replay } from '../chess';
import { EvalBar } from './AnalysisPanel';
import { Board } from './Board';
import {
  AcceptedList,
  AuditList,
  ProposalList,
  RuleList,
  AUDIT_THRESHOLD,
  numbered,
  type Proposal,
} from './RepertoireLists';

const TOLERANCE_KEY = 'chess-app.repertoire-tolerance';
const CURRENT_COLOR = '#d9c48a';
const PROPOSED_COLOR = '#60a5fa';
type Tab = 'proposals' | 'unsound' | 'rules' | 'accepted';

/** What the board is showing: a line from the start, and the moves to draw from its end. */
export type View = { path: string[]; current?: string; proposed?: string };

function arrowsFor(fen: string, view: View): Annotation[] {
  const arrow = (san: string | undefined, color: string, id: string): Annotation[] => {
    if (!san) return [];
    try {
      const move = new Chess(fen).move(san);
      return [{ id, from: move.from, to: move.to, color }];
    } catch {
      return [];
    }
  };
  return [
    ...arrow(view.current, CURRENT_COLOR, 'repertoire-current'),
    ...arrow(view.proposed, PROPOSED_COLOR, 'repertoire-proposed'),
  ];
}

/**
 * The repertoire screen: the board on the left shows the position a proposal
 * is about, and the panel on the right lists proposals to simplify the
 * imported repertoire, moves the engine distrusts, the rules the repertoire
 * already follows, and the changes accepted so far.
 */
export function RepertoireScreen({ modeSwitch }: { modeSwitch: ReactNode }) {
  const state = useRepertoire();
  const { report } = state;
  const [view, setView] = useState<View>({ path: [] });
  const [tab, setTab] = useState<Tab>('proposals');
  const [tolerance, setTolerance] = useState(
    () => Number(localStorage.getItem(TOLERANCE_KEY)) || 25,
  );

  const proposals = useMemo<Proposal[]>(() => {
    if (!report) return [];
    const dismissed = new Set(report.dismissed);
    const rank = { sound: 0, pending: 1, unsound: 2 };
    return report.findings
      .map(finding => {
        const verdict = verdictOf(report.graph, report.evals, finding);
        const status = !verdict ? 'pending' : verdict.delta >= -tolerance ? 'sound' : 'unsound';
        return {
          finding,
          verdict,
          status: status as Proposal['status'],
          saved: finding.decisionsBefore - finding.decisionsAfter,
          reach: report.reach[finding.key] ?? 0,
          dismissed: dismissed.has(finding.id),
        };
      })
      .sort(
        (a, b) =>
          Number(a.dismissed) - Number(b.dismissed) ||
          rank[a.status] - rank[b.status] ||
          // A saving that depends on lines not yet prepared is only an upper bound.
          Number(a.finding.openLines > 0) - Number(b.finding.openLines > 0) ||
          b.saved - a.saved ||
          b.reach - a.reach,
      );
  }, [report, tolerance]);
  const audits = useMemo(
    () => (report ? auditMoves(report.graph, report.evals, AUDIT_THRESHOLD) : []),
    [report],
  );

  const game = useMemo(() => {
    try {
      return replay(view.path);
    } catch {
      return new Chess();
    }
  }, [view.path]);
  const fen = game.fen();
  const key = positionKey(fen);
  const node = report?.graph.nodes[key];
  const flipped = report?.side === 'black';

  const tabs: [Tab, string, number][] = report
    ? [
        ['proposals', 'Proposals', proposals.filter(item => !item.dismissed).length],
        ['unsound', 'Unsound', audits.length],
        ['rules', 'Rules', report.rules.length],
        ['accepted', 'Accepted', report.changes.length],
      ]
    : [];

  return (
    <main className="repertoire">
      <div className="workspace">
        <section className="board-section" aria-label="Repertoire position">
          <div className="stage">
            <PathLine
              path={view.path}
              onSelect={ply => setView({ path: view.path.slice(0, ply) })}
            />
            <Board
              id="repertoire-board"
              position={game}
              flipped={flipped}
              interactive={false}
              onMove={() => false}
              arrows={arrowsFor(fen, view)}
              activeArrow={null}
              candidates={[]}
              evalBar={<EvalBar score={report?.evals[key]?.evaluation} flipped={flipped} />}
            />
            <div className="continuations">
              <span className="label">
                {!report
                  ? ''
                  : node
                    ? node.moves.length
                      ? 'Continues'
                      : 'Line ends'
                    : 'Not in repertoire'}
              </span>
              {node?.moves.map(move => (
                <button key={move.san} onClick={() => setView({ path: [...view.path, move.san] })}>
                  {numbered(view.path.length, move.san)}
                </button>
              ))}
              {(view.current || view.proposed) && (
                <span className="arrow-legend">
                  <i style={{ background: CURRENT_COLOR }} /> current
                  <i style={{ background: PROPOSED_COLOR }} />{' '}
                  {tab === 'unsound' ? 'engine' : 'proposed'}
                </span>
              )}
            </div>
          </div>
        </section>
        <section className="repertoire-panel" aria-label="Repertoire">
          <Header state={state} tolerance={tolerance} onTolerance={setTolerance} />
          {state.error && (
            <p className="repertoire-error" role="alert">
              {state.error}
            </p>
          )}
          {report ? (
            <>
              <div className="analysis-tabs" role="tablist" aria-label="Repertoire views">
                {tabs.map(([name, title, count]) => (
                  <button
                    key={name}
                    role="tab"
                    aria-selected={tab === name}
                    onClick={() => setTab(name)}
                  >
                    {title} <span className="count">{count}</span>
                  </button>
                ))}
              </div>
              <div className="repertoire-list" role="tabpanel">
                {tab === 'proposals' && (
                  <ProposalList
                    report={report}
                    proposals={proposals}
                    tolerance={tolerance}
                    busy={state.busy}
                    onView={setView}
                    onAccept={state.accept}
                    onDismiss={state.dismiss}
                  />
                )}
                {tab === 'unsound' && (
                  <AuditList report={report} audits={audits} onView={setView} />
                )}
                {tab === 'rules' && <RuleList report={report} onView={setView} />}
                {tab === 'accepted' && (
                  <AcceptedList
                    report={report}
                    busy={state.busy}
                    onView={setView}
                    onRevert={state.revert}
                  />
                )}
              </div>
            </>
          ) : (
            <p className="repertoire-empty">
              {state.list === null
                ? 'Loading…'
                : state.list.length
                  ? 'Loading repertoire…'
                  : 'Import a PGN export of your repertoire, for example from Chessbook, to look for ways to simplify it.'}
            </p>
          )}
        </section>
      </div>
      <footer className="status-bar">
        {modeSwitch}
        <span>FEN</span>
        <code>{fen}</code>
        {report && <span className="usage">{progressText(report)}</span>}
      </footer>
    </main>
  );
}

function progressText({ job, engineDepth }: RepertoireReport): string {
  const engine = `Stockfish depth ${engineDepth} · ${job.evalDone}/${job.evalTotal} positions`;
  const lichess = `Lichess ${job.frequencyDone}/${job.frequencyTotal}`;
  return `${job.running ? 'Analysing · ' : ''}${engine} · ${lichess}`;
}

/** The moves leading to the shown position; selecting one steps back to it. */
function PathLine({ path, onSelect }: { path: string[]; onSelect: (ply: number) => void }) {
  return (
    <div className="path-line">
      <button aria-current={path.length === 0 ? 'step' : undefined} onClick={() => onSelect(0)}>
        Start
      </button>
      {path.map((san, index) => (
        <button
          key={index}
          aria-current={index === path.length - 1 ? 'step' : undefined}
          onClick={() => onSelect(index + 1)}
        >
          {index % 2 === 0 ? `${index / 2 + 1}. ` : ''}
          {san}
        </button>
      ))}
    </div>
  );
}

/** Upper edge of a rating bucket as text: "1599", or "2500+" for the last one. */
const bucketEnd = (bucket: number) => {
  const next = RATING_BUCKETS[RATING_BUCKETS.indexOf(bucket) + 1];
  return next ? String(next - 1) : `${bucket}+`;
};

/** Repertoire choice and import, its size, and the controls for the background analysis. */
function Header(props: {
  state: RepertoireState;
  tolerance: number;
  onTolerance: (centipawns: number) => void;
}) {
  const { state, tolerance, onTolerance } = props;
  const { report, list } = state;
  const file = useRef<HTMLInputElement>(null);
  /** A rating range chosen but not yet applied by running the analysis. */
  const [draft, setDraft] = useState<{ id: string; ratings: number[] } | null>(null);
  const ratings = (draft?.id === report?.id && draft?.ratings) || report?.settings.ratings || [];
  const [low, high] = [ratings[0], ratings.at(-1)!];
  const setRange = (from: number, to: number) =>
    report &&
    setDraft({
      id: report.id,
      ratings: RATING_BUCKETS.filter(
        bucket => bucket >= Math.min(from, to) && bucket <= Math.max(from, to),
      ),
    });
  const changed = !!report && ratings.join() !== report.settings.ratings.join();
  const job = report?.job;
  const complete =
    !!job && job.evalDone === job.evalTotal && job.frequencyDone === job.frequencyTotal;

  return (
    <header className="repertoire-header">
      <div className="repertoire-choice">
        {list && list.length > 0 && (
          <select
            aria-label="Repertoire"
            value={state.id}
            onChange={event => state.select(event.target.value)}
          >
            {list.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <button disabled={state.busy} onClick={() => file.current?.click()}>
          Import PGN
        </button>
        {report && (
          <button
            disabled={state.busy}
            onClick={() =>
              window.confirm(`Remove “${report.name}” and its accepted changes?`) && state.remove()
            }
          >
            Remove
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept=".pgn,text/plain"
          hidden
          onChange={async event => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (chosen) await state.importPgn(await chosen.text());
          }}
        />
      </div>
      {report && job && (
        <>
          <p className="repertoire-size">
            <strong>{report.decisions}</strong> positions to know as {report.side}
            {report.decisions !== report.imported.decisions &&
              ` · ${report.imported.decisions} as imported`}
            <span> · {Object.keys(report.graph.nodes).length} positions in all</span>
          </p>
          <div className="repertoire-settings">
            <label>
              <span className="label">Opponents</span>
              <select
                aria-label="Lowest opponent rating"
                value={low}
                onChange={event => setRange(Number(event.target.value), high)}
              >
                {RATING_BUCKETS.map(bucket => (
                  <option key={bucket} value={bucket}>
                    {bucket}
                  </option>
                ))}
              </select>
              –
              <select
                aria-label="Highest opponent rating"
                value={high}
                onChange={event => setRange(low, Number(event.target.value))}
              >
                {RATING_BUCKETS.map(bucket => (
                  <option key={bucket} value={bucket}>
                    {bucketEnd(bucket)}
                  </option>
                ))}
              </select>
            </label>
            <label title="A proposal counts as sound when it scores at most this much worse than your current move.">
              <span className="label">Tolerance</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={tolerance / 100}
                onChange={event => {
                  const centipawns = Math.round(Number(event.target.value) * 100);
                  localStorage.setItem(TOLERANCE_KEY, String(centipawns));
                  onTolerance(centipawns);
                }}
              />
              pawns
            </label>
            {job.running ? (
              <button disabled={state.busy} onClick={state.stop}>
                Stop
              </button>
            ) : (
              (!complete || changed) && (
                <button
                  className="primary"
                  disabled={state.busy}
                  onClick={() => state.analyze(changed ? ratings : undefined)}
                >
                  {changed ? 'Apply range' : job.evalDone ? 'Resume analysis' : 'Analyse'}
                </button>
              )
            )}
          </div>
          {job.error && <p className="repertoire-error">{job.error}</p>}
          {!job.running && !complete && !job.error && (
            <p className="repertoire-note">
              Proposals are structural until analysed: Stockfish has not checked them and line
              frequencies are estimates.
            </p>
          )}
        </>
      )}
    </header>
  );
}
