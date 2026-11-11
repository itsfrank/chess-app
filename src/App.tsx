import { useState, type CSSProperties } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { Chat, type Annotation } from './Chat';
import { legalTargets, needsPromotion, squareCenter, tryMove, type Promotion } from './chess';



export function App() {
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(game.fen());
  const [moveTurn, setMoveTurn] = useState<{ id: number; fen: string; moves: string[] } | null>(null);
  const reviewMove = () => setMoveTurn(previous => ({ id: (previous?.id ?? 0) + 1, fen: game.fen(), moves: game.history() }));
  const [flipped, setFlipped] = useState(false);
  const [selected, setSelected] = useState<Square | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<{ from: Square; to: Square } | null>(null);
  const [notice, setNotice] = useState('Drag a piece or select its starting and destination squares.');
  const [annotationState, setAnnotationState] = useState<{ fen: string; arrows: Annotation[] }>({ fen: '', arrows: [] });
  const annotations = annotationState.arrows;
  const visible = fen === annotationState.fen;
  const sync = () => { setFen(game.fen()); setSelected(null); setPending(null); setActive(null); };
  const move = (from: Square, to: Square) => {
    if (needsPromotion(game, from, to)) { setPending({ from, to }); return false; }
    if (!tryMove(game, from, to)) { setNotice('That move is not legal in this position.'); return false; }
    sync(); reviewMove(); setNotice('Position updated. Companion review queued.'); return true;
  };
  const targets = selected ? legalTargets(game, selected) : [];
  const lastMove = game.history({ verbose: true }).at(-1);
  const squareStyles: Record<string, CSSProperties> = {};
  if (lastMove) {
    for (const square of [lastMove.from, lastMove.to]) {
      squareStyles[square] = { backgroundImage: 'linear-gradient(#efd85b66, #efd85b66)' };
    }
  }
  for (const square of targets) squareStyles[square] = { ...squareStyles[square], boxShadow: 'inset 0 0 0 5px #d4b96999' };
  if (selected) squareStyles[selected] = { ...squareStyles[selected], backgroundColor: '#d4b969' };
  let status = game.turn() === 'w' ? 'White to move' : 'Black to move';
  if (game.isCheckmate()) status = 'Checkmate';
  else if (game.isDraw()) status = 'Draw';
  else if (game.isCheck()) status += ' · Check';

  return <main>
    <div className="workspace">
      <section className="board-section" aria-label="Chess workspace">
        <div className="board-heading"><strong>{status}</strong><span>Standard chess</span></div>
        <div className="board-wrap">
          <Chessboard options={{ id: 'review-board', position: fen, boardOrientation: flipped ? 'black' : 'white',
            allowDrawingArrows: false, allowDragging: !pending && !game.isGameOver(),
            darkSquareStyle: { backgroundColor: '#647c74' }, lightSquareStyle: { backgroundColor: '#e2e5d4' },
            canDragPiece: ({ square }) => !!square && !pending && game.get(square as Square)?.color === game.turn(),
            onPieceDrop: ({ sourceSquare, targetSquare }) => !pending && !!targetSquare && move(sourceSquare as Square, targetSquare as Square),
            onSquareClick: ({ square }) => {
              if (pending || game.isGameOver()) return;
              const target = square as Square;
              if (selected && targets.includes(target)) { move(selected, target); return; }
              setSelected(game.get(target)?.color === game.turn() ? target : null);
            },
            squareStyles,
          }} />
          <svg className="annotation-overlay" viewBox="0 0 800 800" aria-hidden="true">
            <defs>{annotations.map(a => <marker key={a.id} id={`head-${a.id}`} markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill={a.color} /></marker>)}</defs>
            {visible && annotations.map(a => {
              const [x1, y1] = squareCenter(a.from, flipped);
              const [x2, y2] = squareCenter(a.to, flipped);
              const length = Math.hypot(x2 - x1, y2 - y1);
              return <line key={a.id} x1={x1} y1={y1} x2={x2 - (x2 - x1) / length * 20} y2={y2 - (y2 - y1) / length * 20}
                stroke={a.color} strokeWidth={active === a.id ? 14 : 9} strokeLinecap="round" markerEnd={`url(#head-${a.id})`}
                opacity={active && active !== a.id ? 0.2 : active === a.id ? 1 : 0.65} />;
            })}
          </svg>
        </div>
        {pending && <div className="promotion" role="group" aria-label="Choose promotion piece"><strong>Promote to</strong>{(['q', 'r', 'b', 'n'] as Promotion[]).map((piece, i) => <button key={piece} onClick={() => {
          if (tryMove(game, pending.from, pending.to, piece)) { sync(); reviewMove(); setNotice('Pawn promoted. Companion review queued.'); }
        }}>{['Queen', 'Rook', 'Bishop', 'Knight'][i]}</button>)}<button onClick={() => setPending(null)}>Cancel</button></div>}
        <div className="controls"><button disabled={!game.history().length} onClick={() => { game.undo(); sync(); setNotice('Move undone.'); }}>Undo</button><button onClick={() => { game.reset(); sync(); setNotice('Starting position restored.'); }}>Reset</button><button onClick={() => setFlipped(!flipped)}>Flip board</button></div>
        <p className="notice" role="status">{notice}</p>
        <details><summary>Position details</summary><code>{fen}</code><p>{game.history().join(' · ') || 'No moves yet.'}</p></details>
      </section>
      <Chat playerColor={flipped ? 'black' : 'white'} moveTurn={moveTurn} fen={fen} moves={game.history()} setArrows={(position, arrows) => setAnnotationState({ fen: position, arrows })} setActive={setActive} />
    </div>
  </main>;
}
