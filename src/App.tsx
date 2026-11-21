import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Chess, Square } from 'chess.js';
import type { Annotation, PlayerColor, Snapshot } from '../shared/protocol';
import { analysisArrows } from './analysis';
import { gamePositions, gameResult, replay, sanForMove, sideToMove, type Promotion } from './chess';
import { AnalysisPanel, EvalBar, evalLabel } from './components/AnalysisPanel';
import { Board } from './components/Board';
import { Chat } from './components/Chat';
import { GameSetup } from './components/GameSetup';
import { Icon } from './components/Icon';
import type { Highlight } from './components/Message';
import { HistoryNavigation, MoveList } from './components/MoveHistory';
import { StatusBar } from './components/StatusBar';
import { useAnalysis } from './hooks/useAnalysis';
import { useChat } from './hooks/useChat';
import { useOpponent, type Opponent } from './hooks/useOpponent';
import type { SparRequest } from './spar';

const NO_ARROWS: Annotation[] = [];
const MOVES_OPEN_KEY = 'chess-app.moves-open';

export function App({ modeSwitch, spar }: { modeSwitch?: ReactNode; spar?: SparRequest | null }) {
  /** The live game as SAN from the starting position; every position is derived from it. */
  const [moves, setMoves] = useState<string[]>(() => (spar ? [...spar.moves] : []));
  /** Number of half-moves shown while browsing history; null when showing the live position. */
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(() => spar?.playerColor === 'black');
  /** Null on the analysis board, where the user plays both sides. */
  const [opponent, setOpponent] = useState<Opponent | null>(() =>
    spar ? { color: spar.playerColor, elo: spar.elo } : null,
  );
  const [paused, setPaused] = useState(false);
  const [autoReview, setAutoReview] = useState(() => !spar);
  const [notice, setNotice] = useState(() =>
    spar
      ? `Sparring vs Maia3 (${spar.elo})${spar.label ? ` · ${spar.label}` : ''}.`
      : 'Drag a piece or select its starting and destination squares.',
  );
  /** The companion's arrows and the position they were drawn for. */
  const [annotation, setAnnotation] = useState<{ fen: string; arrows: Annotation[] }>({
    fen: '',
    arrows: NO_ARROWS,
  });
  const [activeArrow, setActiveArrow] = useState<string | null>(null);
  /** Whether the move list is shown beside the board; remembered between visits. */
  const [movesOpen, setMovesOpen] = useState(() => localStorage.getItem(MOVES_OPEN_KEY) === '1');

  const game = useMemo(() => replay(moves), [moves]);
  const live = useMemo<Snapshot>(() => ({ fen: game.fen(), moves }), [game, moves]);
  const positions = useMemo(() => gamePositions(moves), [moves]);
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

  const toggleMoves = () => {
    localStorage.setItem(MOVES_OPEN_KEY, movesOpen ? '0' : '1');
    setMovesOpen(!movesOpen);
  };

  /** Who sits on a side of the board: the two players against Maia3, the colours when analysing. */
  const seat = (color: PlayerColor) => {
    if (!opponent) return <strong>{color === 'white' ? 'White' : 'Black'}</strong>;
    const you = color === opponent.color;
    return (
      <>
        <strong>{you ? 'You' : 'Maia3'}</strong>
        <span className="label">{you ? color : `${opponent.elo} · ${color}`}</span>
      </>
    );
  };

  return (
    <main className={movesOpen ? 'moves-open' : undefined}>
      <div className="workspace">
        {movesOpen && <MoveList {...history} />}
        <section className="board-section" aria-label="Chess workspace">
          <div className="stage">
            <div className="player">{seat(flipped ? 'white' : 'black')}</div>
            <Board
              position={shownGame}
              flipped={flipped}
              interactive={canMove}
              onMove={moveByUser}
              arrows={annotation.fen === shownFen ? annotation.arrows : NO_ARROWS}
              activeArrow={activeArrow}
              candidates={candidateArrows}
              evalBar={<EvalBar score={analysis.engine.data?.evaluation} flipped={flipped} />}
            />
            <div className="player">
              {seat(flipped ? 'black' : 'white')}
              <span className="label evaluation" title="Stockfish evaluation, from White's side">
                {evalLabel(analysis.engine)}
              </span>
              <strong className="game-status" role="status">
                {status}
              </strong>
              {opponent && paused && !humanTurn && (
                <button onClick={() => setPaused(false)}>Resume</button>
              )}
            </div>
            {engine.error && (
              <div className="board-alert" role="alert">
                {engine.error} <button onClick={engine.retry}>Retry move</button>
                <button onClick={pause}>Pause</button>
              </div>
            )}
            <div className="board-toolbar">
              <HistoryNavigation {...history} />
              <div className="controls">
                <button disabled={!moves.length} onClick={undo}>
                  <Icon name="undo" size={15} />
                  {opponent ? 'Take back' : 'Undo'}
                </button>
                <button onClick={() => setFlipped(!flipped)}>
                  <Icon name="flip" size={15} />
                  Flip
                </button>
                <GameSetup confirm={moves.length > 0} onStart={startGame} />
              </div>
            </div>
          </div>
        </section>
        <Chat
          chat={chat}
          analysisPanel={<AnalysisPanel analysis={analysis} fen={shownFen} />}
          fen={shownFen}
          positions={positions}
          onSelectPly={selectPly}
          coach={{ on: autoReview, onChange: setAutoReview }}
          onAsk={message => chat.ask(message, { fen: shownFen, moves: shownMoves }, playerColor)}
          onHighlight={highlight}
        />
      </div>
      <button
        className="moves-toggle"
        aria-expanded={movesOpen}
        aria-label={movesOpen ? 'Hide move list' : 'Show move list'}
        title={movesOpen ? 'Hide move list' : 'Show move list'}
        onClick={toggleMoves}
      >
        <Icon name={movesOpen ? 'left' : 'right'} size={16} />
      </button>
      <StatusBar
        lead={modeSwitch}
        fen={shownFen}
        usage={chat.usage}
        notice={result ? `${status}. Start a new game or use ← / → to explore the moves.` : notice}
      />
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
