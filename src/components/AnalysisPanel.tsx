import { useId } from 'react';
import type { Analysis, Evaluation, ExplorerResult } from '../../shared/protocol';
import { formatLine, lineColors, scoreText, whiteShare } from '../analysis';
import type { AnalysisState, AnalysisTab, PositionResult } from '../hooks/useAnalysis';

const TABS: [AnalysisTab, string][] = [
  ['engine', 'Engine'],
  ['explorer', 'Explorer'],
];
const SHOWN_LINES = lineColors.length;

/** The engine's evaluation as short text: a score, a result once the game is decided, or a dash. */
export function evalLabel(result: PositionResult<Analysis>): string {
  const score = result.data?.evaluation;
  if (!score) return '—';
  if (score.type === 'mate' && score.value === 0) return score.winner === 'white' ? '1–0' : '0–1';
  return scoreText(score);
}

/** Vertical bar beside the board showing the engine's evaluation from White's perspective. */
export function EvalBar({ score, flipped }: { score: Evaluation | undefined; flipped: boolean }) {
  const description = score ? `White evaluation: ${scoreText(score)}` : 'Evaluation unavailable';
  return (
    <div className="eval-bar" role="img" aria-label={description} title={description}>
      {/* White's share grows from White's side of the board. */}
      <div
        className="eval-white"
        style={{ height: `${whiteShare(score)}%`, [flipped ? 'top' : 'bottom']: 0 }}
      />
    </div>
  );
}

/** Tabbed panel above the chat: Stockfish's top lines or the most played Lichess moves. */
export function AnalysisPanel({
  analysis,
  fen,
  onPlayLine,
}: {
  analysis: AnalysisState;
  fen: string;
  /** Plays a suggested line (up to 1-based `step`) onto the board. */
  onPlayLine?: (moves: string[], step: number) => void;
}) {
  const { tab, setTab, engine, explorer, retry, showArrows, setShowArrows } = analysis;
  const result = tab === 'engine' ? engine : explorer;
  const id = useId();
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
            id={`${id}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel-${name}`}
            onClick={() => setTab(name)}
          >
            {title}
          </button>
        ))}
        <span className="label">{source}</span>
      </div>
      <div
        className="analysis-body"
        role="tabpanel"
        id={`${id}-panel-${tab}`}
        aria-labelledby={`${id}-tab-${tab}`}
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
          <EngineLines fen={fen} analysis={engine.data!} onPlayLine={onPlayLine} />
        ) : (
          <ExplorerMoves explorer={explorer.data!} onPlayLine={onPlayLine} />
        )}
      </div>
      <label className="switch-label">
        <input
          type="checkbox"
          className="switch"
          checked={showArrows}
          onChange={event => setShowArrows(event.target.checked)}
        />
        Show arrows
      </label>
    </section>
  );
}

function EngineLines({
  fen,
  analysis,
  onPlayLine,
}: {
  fen: string;
  analysis: Analysis;
  onPlayLine?: (moves: string[], step: number) => void;
}) {
  if (!analysis.moves.length)
    return <div className="analysis-message">Game over · no legal moves</div>;
  return analysis.moves.slice(0, SHOWN_LINES).map((line, index) => (
    <div className="analysis-line engine-line" key={index}>
      <i className="dot" style={{ background: lineColors[index] }} aria-hidden="true" />
      <b>{scoreText(line.evaluation)}</b>
      <span>
        {formatLine(fen, line.continuation).map((move, ply) =>
          onPlayLine ? (
            <button
              key={ply}
              type="button"
              className={ply === 0 ? 'line-move first-move' : 'line-move'}
              title="Play this line on the board"
              onClick={() => onPlayLine(line.continuation, ply + 1)}
            >
              {move}
            </button>
          ) : (
            <span key={ply} className={ply === 0 ? 'first-move' : undefined}>
              {move}{' '}
            </span>
          ),
        )}
      </span>
    </div>
  ));
}

function ExplorerMoves({
  explorer,
  onPlayLine,
}: {
  explorer: ExplorerResult;
  onPlayLine?: (moves: string[], step: number) => void;
}) {
  return (
    <>
      {explorer.opening && <div className="analysis-opening">{explorer.opening.name}</div>}
      {explorer.moves.length ? (
        explorer.moves.slice(0, SHOWN_LINES).map((move, index) => (
          <div className="analysis-line explorer-line" key={move.san}>
            <i className="dot" style={{ background: lineColors[index] }} aria-hidden="true" />
            {onPlayLine ? (
              <button
                type="button"
                className="explorer-move"
                title={`Play ${move.san} on the board`}
                onClick={() => onPlayLine([move.san], 1)}
              >
                {move.san}
              </button>
            ) : (
              <b>{move.san}</b>
            )}
            <span className="frequency-bar" aria-hidden="true">
              <i style={{ width: `${(move.frequency ?? 0) * 100}%` }} />
            </span>
            <span>{move.games.toLocaleString()}</span>
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
