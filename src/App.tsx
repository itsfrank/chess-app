import { useCallback, useMemo, useState } from 'react';
import type { Chess, Square } from 'chess.js';
import type { Annotation, Snapshot } from '../shared/protocol';
import { analysisArrows } from './analysis';
import { gameResult, replay, sanForMove, sideToMove, type Promotion } from './chess';
import { AnalysisPanel, EvalBar } from './components/AnalysisPanel';
import { Board } from './components/Board';
import { Chat } from './components/Chat';
import { GameSetup } from './components/GameSetup';
import { Icon } from './components/Icon';
import type { Highlight } from './components/Message';
import { HistoryNavigation, MoveList } from './components/MoveHistory';
import { useAnalysis } from './hooks/useAnalysis';
import { useChat } from './hooks/useChat';
import { useOpponent, type Opponent } from './hooks/useOpponent';

const NO_ARROWS: Annotation[] = [];

export function App() {
  /** The live game as SAN from the starting position; every position is derived from it. */
  const [moves, setMoves] = useState<string[]>([]);
  /** Number of half-moves shown while browsing history; null when showing the live position. */
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  /** Null on the analysis board, where the user plays both sides. */
  const [opponent, setOpponent] = useState<Opponent | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoReview, setAutoReview] = useState(true);
  const [notice, setNotice] = useState(
    'Drag a piece or select its starting and destination squares.',
  );
  /** The companion's arrows and the position they were drawn for. */
  const [annotation, setAnnotation] = useState<{ fen: string; arrows: Annotation[] }>({
    fen: '',
    arrows: NO_ARROWS,
  });
  const [activeArrow, setActiveArrow] = useState<string | null>(null);

  const game = useMemo(() => replay(moves), [moves]);
  const live = useMemo<Snapshot>(() => ({ fen: game.fen(), moves }), [game, moves]);
  const reviewing = reviewPly !== null && reviewPly < moves.length;
  const shownMoves = useMemo(
    () => (reviewing ? moves.slice(0, reviewPly) : moves),
    [moves, reviewing, reviewPly],
  );
  const shownGame = useMemo(
    () => (reviewing ? replay(shownMoves) : game),
    [reviewing, shownMoves, game],
  );
  const shownFen = shownGame.fen();

  const analysis = useAnalysis(shownFen);
  const candidateArrows = analysis.showArrows
    ? analysisArrows(shownFen, analysis.candidates)
    : NO_ARROWS;

  const playerColor = opponent?.color ?? (flipped ? 'black' : 'white');
  const humanTurn = !opponent || sideToMove(moves.length) === opponent.color;
  const result = gameResult(game);

  const showArrows = useCallback(
    (fen: string, arrows: Annotation[]) => setAnnotation({ fen, arrows }),
    [],
  );
  const highlight = useCallback<Highlight>((message, arrowId) => {
    if (arrowId) setAnnotation({ fen: message.fen, arrows: message.arrows });
    setActiveArrow(arrowId);
  }, []);
  const chat = useChat({ onArrows: showArrows });

  const play = (san: string) => {
    const next = [...moves, san];
    setMoves(next);
    setActiveArrow(null);
    if (autoReview) chat.review({ fen: replay(next).fen(), moves: next }, playerColor);
  };
  const engine = useOpponent({
    snapshot: live,
    opponent,
    enabled: !!opponent && !humanTurn && !paused && !result,
    onMove: san => {
      play(san);
      setNotice(`Maia3 played ${san}. Your turn.`);
    },
  });
  const canMove = !reviewing && humanTurn && !result;

  const moveByUser = (from: Square, to: Square, promotion?: Promotion) => {
    const san = canMove ? sanForMove(game, from, to, promotion) : null;
    if (!san) {
      setNotice('That move is not legal in this position.');
      return false;
    }
    play(san);
    setNotice(
      promotion
        ? 'Pawn promoted.'
        : autoReview
          ? 'Move played. Companion review queued.'
          : 'Move played.',
    );
    return true;
  };

  const startGame = (next: Opponent | null) => {
    setMoves([]);
    setReviewPly(null);
    setPaused(false);
    setOpponent(next);
    setFlipped(next?.color === 'black');
    // Reviews cost a model request per move, so they are opt-in against an opponent.
    setAutoReview(!next);
    setNotice(next ? `New game. You play ${next.color}.` : 'Analysis board. Play either side.');
  };

  const reset = () => {
    if (moves.length && !window.confirm('Reset the current game?')) return;
    setMoves([]);
    setReviewPly(null);
    setPaused(false);
    engine.retry();
    setNotice('Starting position restored.');
  };

  const undo = () => {
    let plies = moves.length - 1;
    if (opponent) {
      // Return to the user's previous decision, which may mean removing the engine's reply too.
      if (plies > 0 && sideToMove(plies) !== opponent.color) plies--;
      // Taking back the engine's opening move would only make it move again at once.
      setPaused(sideToMove(plies) !== opponent.color);
    }
    setMoves(moves.slice(0, plies));
    setReviewPly(null);
    setNotice('Move taken back. Choose a different move.');
  };

  const pause = () => {
    setPaused(true);
    setNotice('Game paused. Take back a move or resume when ready.');
  };

  const status = reviewing
    ? `Reviewing · after ply ${reviewPly}`
    : describeStatus(
        game,
        result,
        opponent && { humanTurn, paused, thinking: engine.thinking, failed: !!engine.error },
      );

  const selectPly = (ply: number) => setReviewPly(ply >= moves.length ? null : ply);
  const history = { moves, ply: shownMoves.length, onSelect: selectPly };

  return (
    <main>
      <div className="workspace">
        <section className="board-section" aria-label="Chess workspace">
          <GameSetup confirm={moves.length > 0} onStart={startGame} />
          <div className="board-stage">
            <div className="board-heading">
              <strong role="status">{status}</strong>
              <span>
                {opponent
                  ? `Maia3 · ${opponent.elo} · You: ${opponent.color}`
                  : 'Analysis · both sides'}
              </span>
            </div>
            {engine.error && (
              <div className="opponent-error" role="alert">
                {engine.error} <button onClick={engine.retry}>Retry move</button>
                <button onClick={pause}>Pause</button>
              </div>
            )}
            {opponent && paused && !humanTurn && (
              <button className="resume-game" onClick={() => setPaused(false)}>
                Resume Maia3
              </button>
            )}
            <Board
              position={shownGame}
              flipped={flipped}
              interactive={canMove}
              onMove={moveByUser}
              arrows={annotation.fen === shownFen ? annotation.arrows : NO_ARROWS}
              activeArrow={activeArrow}
              candidates={candidateArrows}
              evalBar={<EvalBar result={analysis.engine} flipped={flipped} />}
            />
          </div>
          <div className="board-toolbar">
            <div className="controls">
              <button disabled={!moves.length} onClick={undo}>
                <Icon name="undo" size={16} />
                {opponent ? 'Take back' : 'Undo'}
              </button>
              <button onClick={reset}>
                <Icon name="reset" size={16} />
                Reset
              </button>
              <button onClick={() => setFlipped(!flipped)}>
                <Icon name="flip" size={16} />
                Flip board
              </button>
            </div>
            <HistoryNavigation {...history} />
          </div>
          <label className="review-toggle">
            <input
              type="checkbox"
              checked={autoReview}
              onChange={event => setAutoReview(event.target.checked)}
            />
            Automatic Stockfish coaching{' '}
            <small>Reviews every move · uses your model subscription</small>
          </label>
          <MoveList {...history} />
          <p className="notice" role="status">
            {result ? `${status}. Start a new game or use ← / → to explore the moves.` : notice}
          </p>
          <details>
            <summary>Position details</summary>
            <code>{shownFen}</code>
            <p>{shownMoves.join(' · ') || 'No moves yet.'}</p>
          </details>
        </section>
        <Chat
          chat={chat}
          analysisPanel={<AnalysisPanel analysis={analysis} fen={shownFen} />}
          fen={shownFen}
          onAsk={message => chat.ask(message, { fen: shownFen, moves: shownMoves }, playerColor)}
          onHighlight={highlight}
        />
      </div>
    </main>
  );
}

/** The headline above the board for the live position. */
function describeStatus(
  game: Chess,
  result: string | null,
  versus: { humanTurn: boolean; paused: boolean; thinking: boolean; failed: boolean } | null,
): string {
  const check = game.isCheck() ? ' · Check' : '';
  if (result === 'Checkmate' && versus)
    return versus.humanTurn ? 'Checkmate · Maia3 wins' : 'Checkmate · You win!';
  if (result) return result;
  if (!versus) return (game.turn() === 'w' ? 'White to move' : 'Black to move') + check;
  if (versus.humanTurn) return `Your turn${check}`;
  if (versus.thinking) return 'Maia3 is thinking…';
  if (versus.paused) return 'Game paused';
  return versus.failed ? 'Maia3 needs attention' : 'Maia3 to move';
}
