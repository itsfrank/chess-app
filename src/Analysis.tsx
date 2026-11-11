import { useEffect, useState } from 'react';
import { Chess } from 'chess.js';

type Score = { type: 'cp' | 'mate'; value: number; winner?: 'white' | 'black' };
type Engine = { fen: string; depth: number; evaluation: Score; moves: { san: string; continuation: string[]; evaluation: Score }[] };
type Explorer = { fen: string; totalGames: number; opening: { name: string } | null; moves: { san: string; games: number; frequency: number | null }[] };
type Result<T> = { fen: string; data?: T; error?: string };
export const lineColors = ['#60a5fa', '#f5dc50', '#f472ce'];
export function formatLine(fen: string, moves: string[]) {
  const board = new Chess(fen);
  return moves.map((move, index) => {
    const prefix = board.turn() === 'w' ? `${board.moveNumber()}. ` : index === 0 ? `${board.moveNumber()}... ` : '';
    try { board.move(move); } catch { /* Keep the remaining notation readable if a line is incomplete. */ }
    return `${prefix}${move}`;
  });
}
export function analysisArrows(fen: string, moves: string[]) {
  return moves.slice(0, 3).flatMap((san, index) => {
    try { const move = new Chess(fen).move(san); return [{ from: move.from, to: move.to, color: lineColors[index], id: `analysis-${index}` }]; } catch { return []; }
  });
}
const scoreText = (score: Score) => score.type === 'mate' ? (score.value === 0 ? (score.winner === 'white' ? 'White wins' : 'Black wins') : `${score.value > 0 ? '+' : '−'}M${Math.abs(score.value)}`) : `${score.value > 0 ? '+' : score.value < 0 ? '−' : ''}${(Math.abs(score.value) / 100).toFixed(1)}`;

export function useAnalysis(fen: string) {
  const [engine, setEngine] = useState<Result<Engine>>({ fen: '' });
  const [explorer, setExplorer] = useState<Result<Explorer>>({ fen: '' });
  const [showArrows, setShowArrows] = useState(false);
  const [tab, setTab] = useState<'engine' | 'explorer'>('engine');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen }), signal: controller.signal })
        .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed'); return data; })
        .then(data => { if (!controller.signal.aborted) setEngine({ fen, data }); })
        .catch(error => { if (!controller.signal.aborted) setEngine({ fen, error: error instanceof Error ? error.message : 'Request failed' }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fen, attempt]);
  useEffect(() => {
    if (tab !== 'explorer') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/explorer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen }), signal: controller.signal })
        .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed'); return data; })
        .then(data => { if (!controller.signal.aborted) setExplorer({ fen, data }); })
        .catch(error => { if (!controller.signal.aborted) setExplorer({ fen, error: error instanceof Error ? error.message : 'Request failed' }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fen, tab, attempt]);
  return { engine: engine.fen === fen ? engine : { fen }, explorer: explorer.fen === fen ? explorer : { fen }, tab, setTab, showArrows, setShowArrows, retry: () => setAttempt(n => n + 1) };
}
export function EvalBar({ result, flipped }: { result: Result<Engine>; flipped: boolean }) {
  const score = result.data?.evaluation;
  const white = score ? score.type === 'mate' ? (score.value > 0 || score.winner === 'white' ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-score.value / 400)) - 1) : 50;
  return <div className="eval-bar" role="img" aria-label={score ? `Evaluation ${scoreText(score)}, from White's perspective` : 'Evaluation unavailable'} title={score ? `White evaluation: ${scoreText(score)}` : 'Evaluation unavailable'}>
    <div className="eval-white" style={{ height: `${white}%`, [flipped ? 'top' : 'bottom']: 0 }} />
    <span className={`eval-label ${flipped ? 'flipped' : ''}`}>{score ? (score.type === 'mate' && score.value === 0 ? (score.winner === 'white' ? '1–0' : '0–1') : scoreText(score)) : '—'}</span>
  </div>;
}
export function AnalysisPanel({ analysis, fen }: { analysis: ReturnType<typeof useAnalysis>; fen: string }) {
  const { tab, setTab, engine, explorer, retry, showArrows, setShowArrows } = analysis;
  const result = tab === 'engine' ? engine : explorer;
  return <section className="analysis-panel" aria-label="Position analysis">
    <div className="analysis-tabs" role="tablist" aria-label="Position analysis">
      {(['engine', 'explorer'] as const).map(name => <button key={name} role="tab" aria-selected={tab === name} aria-controls={`panel-${name}`} id={`tab-${name}`} onClick={() => setTab(name)}>{name === 'engine' ? 'Engine' : 'Explorer'}</button>)}
      <span>{tab === 'engine' ? engine.data ? `Stockfish · depth ${engine.data.depth}` : 'Stockfish' : 'Lichess · rated games'}</span>
    </div>
    <div className="analysis-options"><span>{tab === 'engine' ? 'Top engine lines' : 'Most played moves'}</span><label><input type="checkbox" checked={showArrows} onChange={e => setShowArrows(e.target.checked)} /> Show arrows</label></div>
    <div className="analysis-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {result.error ? <div className="analysis-message">{result.error} <button onClick={retry}>Retry</button></div> : !result.data || result.fen !== fen ? <div className="analysis-message">{tab === 'engine' ? 'Analyzing position…' : 'Loading Lichess moves…'}</div> : tab === 'engine' && engine.data ? (engine.data.moves.length ? engine.data.moves.slice(0, 3).map((line, i) => <div className="analysis-line engine-line" key={i}><i style={{ background: lineColors[i] }} aria-hidden="true" /><b>{scoreText(line.evaluation)}</b><span>{formatLine(fen, line.continuation).map((move, index) => <span key={index} className={index === 0 ? "first-move" : undefined}>{move} </span>)}</span></div>) : <div className="analysis-message">Game over · no legal moves</div>) : explorer.data ? <>{explorer.data.opening && <div className="analysis-opening">{explorer.data.opening.name}</div>}{explorer.data.moves.length ? explorer.data.moves.slice(0, 3).map((move, i) => <div className="analysis-line explorer-line" key={move.san}><i style={{ background: lineColors[i] }} aria-hidden="true" /><b>{move.san}</b><span>{move.games.toLocaleString()} games</span><strong>{move.frequency === null ? '—' : `${(move.frequency * 100).toFixed(1)}%`}</strong></div>) : <div className="analysis-message">No games found for this position.</div>}<div className="analysis-caption">{explorer.data.totalGames.toLocaleString()} games in position · all ratings and speeds</div></> : null}
    </div>
  </section>;
}
