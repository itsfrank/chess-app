import type { Analysis, ExplorerResult } from '../../shared/protocol';
import { formatLine, lineColors, scoreText, whiteShare } from '../analysis';
import type { AnalysisState, AnalysisTab, PositionResult } from '../hooks/useAnalysis';

const TABS: [AnalysisTab, string][] = [
  ['engine', 'Engine'],
  ['explorer', 'Explorer'],
];
const SHOWN_LINES = lineColors.length;

/** Vertical bar beside the board showing the engine's evaluation from White's perspective. */
export function EvalBar({
  result,
  flipped,
}: {
  result: PositionResult<Analysis>;
  flipped: boolean;
}) {
  const score = result.data?.evaluation;
  const decided = score?.type === 'mate' && score.value === 0;
  const label = !score
    ? '—'
    : decided
      ? score.winner === 'white'
        ? '1–0'
        : '0–1'
      : scoreText(score);
  const description = score ? `White evaluation: ${scoreText(score)}` : 'Evaluation unavailable';
  return (
    <div className="eval-bar" role="img" aria-label={description} title={description}>
      {/* White's share grows from White's side of the board. */}
      <div
        className="eval-white"
        style={{ height: `${whiteShare(score)}%`, [flipped ? 'top' : 'bottom']: 0 }}
      />
      <span className={flipped ? 'eval-label flipped' : 'eval-label'}>{label}</span>
    </div>
  );
}

/** Tabbed panel above the chat: Stockfish's top lines or the most played Lichess moves. */
export function AnalysisPanel({ analysis, fen }: { analysis: AnalysisState; fen: string }) {
  const { tab, setTab, engine, explorer, retry, showArrows, setShowArrows } = analysis;
  const result = tab === 'engine' ? engine : explorer;
  const source =
    tab === 'explorer'
      ? 'Lichess · rated games'
      : engine.data
        ? `Stockfish · depth ${engine.data.depth}`
        : 'Stockfish';

  return (
    <section className="analysis-panel" aria-label="Position analysis">
      <div className="analysis-tabs" role="tablist" aria-label="Position analysis">
        {TABS.map(([name, title]) => (
          <button
            key={name}
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            onClick={() => setTab(name)}
          >
            {title}
          </button>
        ))}
        <span>{source}</span>
      </div>
      <div className="analysis-options">
        <span>{tab === 'engine' ? 'Top engine lines' : 'Most played moves'}</span>
        <label>
          <input
            type="checkbox"
            checked={showArrows}
            onChange={event => setShowArrows(event.target.checked)}
          />{' '}
          Show arrows
        </label>
      </div>
      <div
        className="analysis-body"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {result.error ? (
          <div className="analysis-message">
            {result.error} <button onClick={retry}>Retry</button>
          </div>
        ) : !result.data ? (
          <div className="analysis-message">
            {tab === 'engine' ? 'Analyzing position…' : 'Loading Lichess moves…'}
          </div>
        ) : tab === 'engine' ? (
          <EngineLines fen={fen} analysis={engine.data!} />
        ) : (
          <ExplorerMoves explorer={explorer.data!} />
        )}
      </div>
    </section>
  );
}

function EngineLines({ fen, analysis }: { fen: string; analysis: Analysis }) {
  if (!analysis.moves.length)
    return <div className="analysis-message">Game over · no legal moves</div>;
  return analysis.moves.slice(0, SHOWN_LINES).map((line, index) => (
    <div className="analysis-line engine-line" key={index}>
      <i style={{ background: lineColors[index] }} aria-hidden="true" />
      <b>{scoreText(line.evaluation)}</b>
      <span>
        {formatLine(fen, line.continuation).map((move, ply) => (
          <span key={ply} className={ply === 0 ? 'first-move' : undefined}>
            {move}{' '}
          </span>
        ))}
      </span>
    </div>
  ));
}

function ExplorerMoves({ explorer }: { explorer: ExplorerResult }) {
  return (
    <>
      {explorer.opening && <div className="analysis-opening">{explorer.opening.name}</div>}
      {explorer.moves.length ? (
        explorer.moves.slice(0, SHOWN_LINES).map((move, index) => (
          <div className="analysis-line explorer-line" key={move.san}>
            <i style={{ background: lineColors[index] }} aria-hidden="true" />
            <b>{move.san}</b>
            <span>{move.games.toLocaleString()} games</span>
            <strong>
              {move.frequency === null ? '—' : `${(move.frequency * 100).toFixed(1)}%`}
            </strong>
          </div>
        ))
      ) : (
        <div className="analysis-message">No games found for this position.</div>
      )}
      <div className="analysis-caption">
        {explorer.totalGames.toLocaleString()} games in position · all ratings and speeds
      </div>
    </>
  );
}
