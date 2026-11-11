import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { Chat, type Annotation } from './Chat';
import { Icon } from './Icon';
import { useAnalysis, AnalysisPanel, EvalBar, analysisArrows } from './Analysis';
import { legalTargets, needsPromotion, squareCenter, tryMove, type Promotion } from './chess';



export function App() {
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(game.fen());
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const movesList = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = movesList.current;
    if (!list) return;
    const current = list.querySelector<HTMLElement>('[aria-current]');
    if (reviewPly === null) list.scrollTop = list.scrollHeight;
    else if (current) list.scrollTop = current.offsetTop - list.offsetTop;
  }, [fen, reviewPly]);
  const history = game.history();
  const reviewing = reviewPly !== null && reviewPly < history.length;
  const displayGame = reviewing ? new Chess() : game;
  if (reviewing) for (const san of history.slice(0, reviewPly!)) displayGame.move(san);
  const displayFen = displayGame.fen();
  const analysis = useAnalysis(displayFen);
  const navigate = (direction: number) => {
    const next = Math.max(0, Math.min(game.history().length, (reviewPly ?? game.history().length) + direction));
    setSelected(null); setPending(null); setActive(null);
    setReviewPly(next === game.history().length ? null : next);
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [reviewPly, fen]);
  const [moveTurn, setMoveTurn] = useState<{ id: number; fen: string; moves: string[] } | null>(null);
  const reviewMove = () => setMoveTurn(previous => ({ id: (previous?.id ?? 0) + 1, fen: game.fen(), moves: game.history() }));
  const [flipped, setFlipped] = useState(false);
  const [setupMode, setSetupMode] = useState('maia');
  const [setupColor, setSetupColor] = useState<'white' | 'black'>('white');
  const [setupElo, setSetupElo] = useState(1500);
  const [opponent, setOpponent] = useState<{ color: 'white' | 'black'; elo: number } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [opponentError, setOpponentError] = useState('');
  const [paused, setPaused] = useState(false);
  const [retry, setRetry] = useState(0);
  const [autoReview, setAutoReview] = useState(false);
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const humanTurn = !opponent || game.turn() === (opponent.color === 'white' ? 'w' : 'b');
  const invalidate = () => { setReviewPly(null); version.current++; request.current?.abort(); request.current = null; setThinking(false); setOpponentError(''); };
  useEffect(() => {
    if (!opponent || humanTurn || paused || game.isGameOver()) return;
    const controller = new AbortController(); request.current = controller;
    const expected = version.current;
    const snapshot = game.fen();
    setThinking(true); setOpponentError('');
    const timer = setTimeout(() => controller.abort(), 60000);
    void fetch('/api/opponent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ fen: snapshot, moves: game.history(), playerColor: opponent.color, elo: opponent.elo }) })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Maia3 could not move'); return body; })
      .then(body => {
        if (controller.signal.aborted || expected !== version.current || game.fen() !== snapshot) return;
        const candidate = new Chess(snapshot); const played = candidate.move(body.move);
        if (candidate.fen() !== body.fen) throw new Error('Maia3 returned an inconsistent position');
        game.move(body.move); setThinking(false); sync(); if (autoReview) reviewMove();
        setNotice(`Maia3 played ${played.san}. Your turn.`);
      })
      .catch(error => {
        if (expected !== version.current) return;
        if (controller.signal.aborted && request.current !== controller) return;
        setOpponentError(controller.signal.aborted ? 'Maia3 took too long. Please retry.' : String(error.message || error));
      })
      .finally(() => { clearTimeout(timer); if (request.current === controller) { request.current = null; setThinking(false); } });
    return () => { clearTimeout(timer); if (request.current === controller) request.current = null; controller.abort(); };
  }, [fen, opponent, paused, retry]);
  const startGame = () => {
    invalidate(); game.reset(); sync(); setPaused(false);
    setOpponent(setupMode === 'maia' ? { color: setupColor, elo: setupElo } : null);
    setFlipped(setupMode === 'maia' && setupColor === 'black');
    setNotice(setupMode === 'maia' ? `New game. You play ${setupColor}.` : 'Analysis board. Play either side.');
  };
  const undo = () => {
    invalidate();
    if (opponent) {
      // Return to the preceding human decision, including an unanswered human move.
      if (game.history().length) game.undo();
      if (game.history().length && game.turn() !== (opponent.color === 'white' ? 'w' : 'b')) game.undo();
      setPaused(game.turn() !== (opponent.color === 'white' ? 'w' : 'b'));
    } else game.undo();
    sync(); setNotice('Move taken back. Choose a different move.');
  };
  const [selected, setSelected] = useState<Square | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<{ from: Square; to: Square } | null>(null);
  const [notice, setNotice] = useState('Drag a piece or select its starting and destination squares.');
  const [annotationState, setAnnotationState] = useState<{ fen: string; arrows: Annotation[] }>({ fen: '', arrows: [] });
  const annotations = annotationState.arrows;
  const candidateMoves = analysis.tab === 'engine' ? analysis.engine.data?.moves.map(line => line.san) : analysis.explorer.data?.moves.map(line => line.san);
  const candidateArrows = analysis.showArrows ? analysisArrows(displayFen, candidateMoves ?? []) : [];
  const visible = displayFen === annotationState.fen;
  const sync = () => { setFen(game.fen()); setSelected(null); setPending(null); setActive(null); };
  const move = (from: Square, to: Square) => {
    if (reviewing || !humanTurn || thinking || game.isGameOver()) return false;
    if (needsPromotion(game, from, to)) { setPending({ from, to }); return false; }
    if (!tryMove(game, from, to)) { setNotice('That move is not legal in this position.'); return false; }
    sync(); if (!opponent || autoReview) reviewMove(); setNotice(opponent ? 'Move played.' : 'Position updated. Companion review queued.'); return true;
  };
  const targets = selected && !reviewing ? legalTargets(game, selected) : [];
  const lastMove = displayGame.history({ verbose: true }).at(-1);
  const squareStyles: Record<string, CSSProperties> = {};
  if (lastMove) {
    for (const square of [lastMove.from, lastMove.to]) {
      squareStyles[square] = { backgroundImage: 'linear-gradient(#efd85b66, #efd85b66)' };
    }
  }
  for (const square of targets) squareStyles[square] = { ...squareStyles[square], boxShadow: 'inset 0 0 0 5px #d4b96999' };
  if (selected) squareStyles[selected] = { ...squareStyles[selected], backgroundColor: '#d4b969' };
  let status = game.turn() === 'w' ? 'White to move' : 'Black to move';
  if (opponent && !game.isGameOver()) status = humanTurn ? `Your turn${game.isCheck() ? ' · Check' : ''}` : thinking ? 'Maia3 is thinking…' : paused ? 'Game paused' : opponentError ? 'Maia3 needs attention' : 'Maia3 to move';
  if (game.isCheckmate()) status = opponent ? (humanTurn ? 'Checkmate · Maia3 wins' : 'Checkmate · You win!') : 'Checkmate';
  else if (game.isDraw()) status = game.isStalemate() ? 'Draw · Stalemate' : game.isThreefoldRepetition() ? 'Draw · Repetition' : game.isInsufficientMaterial() ? 'Draw · Insufficient material' : 'Draw · Fifty-move rule';
  else if (game.isCheck() && !opponent) status += ' · Check';

  return <main>
    <div className="workspace">
      <section className="board-section" aria-label="Chess workspace">
        <div className="opponent-setup" aria-label="Game setup">
          <div className="setup-fields">
            <label><span>Mode</span><select aria-label="Game mode" value={setupMode} onChange={e => setSetupMode(e.target.value)}><option value="maia">Play Maia3</option><option value="analysis">Analysis board</option></select></label>
            <label><span>Your side</span><select aria-label="Your side" disabled={setupMode !== 'maia'} value={setupColor} onChange={e => setSetupColor(e.target.value as 'white' | 'black')}><option value="white">White</option><option value="black">Black</option></select></label>
            <label><span>Rating</span><select aria-label="Opponent rating" disabled={setupMode !== 'maia'} value={setupElo} onChange={e => setSetupElo(Number(e.target.value))}>{[1000,1200,1500,1800,2000].map(elo => <option key={elo} value={elo}>{elo} Elo</option>)}</select></label>
            <button onClick={() => { if (!game.history().length || window.confirm('Start a new game? The current board will be cleared.')) startGame(); }}><Icon name="plus" size={16} />New game</button>
          </div>
          <small title="Maia3 plays human-like moves. Rating is a style target, not a certified strength.">Settings apply to new games · Maia3 rating is a style target</small>
        </div>
        <div className="board-stage"><div className="board-heading"><strong role="status">{reviewing ? `Reviewing · after ply ${reviewPly}` : status}</strong><span>{opponent ? `Maia3 · ${opponent.elo} · You: ${opponent.color}` : 'Analysis · both sides'}</span></div>
        {opponentError && <div className="opponent-error" role="alert">{opponentError} <button onClick={() => setRetry(n => n + 1)}>Retry move</button><button onClick={() => { invalidate(); setPaused(true); setNotice('Game paused. Take back a move or resume when ready.'); }}>Pause</button></div>}
        {opponent && paused && !humanTurn && <button className="resume-game" onClick={() => setPaused(false)}>Resume Maia3</button>}
        <div className="board-and-eval"><EvalBar result={analysis.engine} flipped={flipped} /><div className="board-wrap">
          <Chessboard options={{ id: 'review-board', position: displayFen, boardOrientation: flipped ? 'black' : 'white',
            allowDrawingArrows: false, allowDragging: !reviewing && !pending && humanTurn && !thinking && !game.isGameOver(),
            darkSquareStyle: { backgroundColor: '#485466' }, lightSquareStyle: { backgroundColor: '#cbd2da' },
            darkSquareNotationStyle: { color: '#cbd2da', fontSize: '11px', fontWeight: 500 }, lightSquareNotationStyle: { color: '#485466', fontSize: '11px', fontWeight: 500 },
            canDragPiece: ({ square }) => !!square && !reviewing && !pending && humanTurn && !thinking && game.get(square as Square)?.color === game.turn(),
            onPieceDrop: ({ sourceSquare, targetSquare }) => !pending && !!targetSquare && move(sourceSquare as Square, targetSquare as Square),
            onSquareClick: ({ square }) => {
              if (reviewing || pending || !humanTurn || thinking || game.isGameOver()) return;
              const target = square as Square;
              if (selected && targets.includes(target)) { move(selected, target); return; }
              setSelected(game.get(target)?.color === game.turn() ? target : null);
            },
            squareStyles,
          }} />
          <svg className="annotation-overlay" viewBox="0 0 800 800" aria-hidden="true">
            <defs>{[...annotations, ...candidateArrows].map(a => <marker key={a.id} id={`head-${a.id}`} markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill={a.color} /></marker>)}</defs>
            {candidateArrows.map(a => {
              const [x1, y1] = squareCenter(a.from, flipped); const [x2, y2] = squareCenter(a.to, flipped);
              const length = Math.hypot(x2 - x1, y2 - y1);
              // Offset coincident companion and candidate arrows so both remain visible.
              const overlaps = visible && annotations.some(other => (other.from === a.from && other.to === a.to) || (other.from === a.to && other.to === a.from));
              const offsetX = overlaps ? -(y2 - y1) / length * 18 : 0;
              const offsetY = overlaps ? (x2 - x1) / length * 18 : 0;
              return <line key={a.id} x1={x1 + offsetX} y1={y1 + offsetY} x2={x2 + offsetX - (x2 - x1) / length * 20} y2={y2 + offsetY - (y2 - y1) / length * 20} stroke={a.color} strokeWidth={10} strokeDasharray="1 20" strokeLinecap="round" markerEnd={`url(#head-${a.id})`} opacity={0.95} />;
            })}
            {visible && annotations.map(a => {
              const [x1, y1] = squareCenter(a.from, flipped);
              const [x2, y2] = squareCenter(a.to, flipped);
              const length = Math.hypot(x2 - x1, y2 - y1);
              return <line key={a.id} x1={x1} y1={y1} x2={x2 - (x2 - x1) / length * 20} y2={y2 - (y2 - y1) / length * 20}
                stroke={a.color} strokeWidth={active === a.id ? 14 : 9} strokeLinecap="round" markerEnd={`url(#head-${a.id})`}
                opacity={active && active !== a.id ? 0.2 : active === a.id ? 1 : 0.65} />;
            })}
          </svg>
        </div></div></div>
        {pending && <div className="promotion" role="group" aria-label="Choose promotion piece"><strong>Promote to</strong>{(['q', 'r', 'b', 'n'] as Promotion[]).map((piece, i) => <button key={piece} onClick={() => {
          if (tryMove(game, pending.from, pending.to, piece)) { sync(); if (!opponent || autoReview) reviewMove(); setNotice('Pawn promoted.'); }
        }}>{['Queen', 'Rook', 'Bishop', 'Knight'][i]}</button>)}<button onClick={() => setPending(null)}>Cancel</button></div>}
        <div className="board-toolbar"><div className="controls"><button disabled={!game.history().length} onClick={undo}><Icon name="undo" size={16} />{opponent ? 'Take back' : 'Undo'}</button><button onClick={() => { if (!game.history().length || window.confirm('Reset the current game?')) { invalidate(); game.reset(); sync(); setPaused(false); setRetry(n => n + 1); setNotice('Starting position restored.'); } }}><Icon name="reset" size={16} />Reset</button><button onClick={() => setFlipped(!flipped)}><Icon name="flip" size={16} />Flip board</button></div>
        <div className="history-navigation" aria-label="History navigation"><button aria-label="Previous move" title="Previous move (Left arrow)" disabled={!history.length || reviewPly === 0} onClick={() => navigate(-1)}><Icon name="left" /></button><span>{reviewing ? `${reviewPly} / ${history.length} plies · review only` : 'Live position'}</span><button aria-label="Next move" title="Next move (Right arrow)" disabled={!reviewing} onClick={() => navigate(1)}><Icon name="right" /></button>{reviewing && <button onClick={() => setReviewPly(null)}>Return to live game</button>}</div></div>
        {opponent && <label className="review-toggle"><input type="checkbox" checked={autoReview} onChange={e => setAutoReview(e.target.checked)} /> Automatic Stockfish coaching <small>Optional · uses your model subscription</small></label>}
        {!!game.history().length && <div ref={movesList} className="game-moves" aria-label="Move history">{game.history().map((san, i) => <button key={i} aria-current={(reviewPly ?? history.length) === i + 1 ? 'step' : undefined} onClick={() => { setPending(null); setSelected(null); setReviewPly(i + 1 === history.length ? null : i + 1); }}>{i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ''}{san}</button>)}</div>}
        <p className="notice" role="status">{game.isGameOver() ? `${status}. Start a new game or use ← / → to explore the moves.` : notice}</p>
        <details><summary>Position details</summary><code>{displayFen}</code><p>{displayGame.history().join(' · ') || 'No moves yet.'}</p></details>
      </section>
      <Chat analysisPanel={<AnalysisPanel analysis={analysis} fen={displayFen} />} playerColor={opponent?.color ?? (flipped ? 'black' : 'white')} moveTurn={moveTurn} fen={displayFen} moves={displayGame.history()} setArrows={(position, arrows) => setAnnotationState({ fen: position, arrows })} setActive={setActive} />
    </div>
  </main>;
}
