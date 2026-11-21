import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Chess, type Square } from 'chess.js';
import {
  drillCoachPrompt,
  formatDueLabel,
  isDrillDue,
  nearestOpponentElo,
  sortDrills,
} from '../../shared/drills';
import type { Annotation, DrillCard } from '../../shared/protocol';
import { numberedMove } from '../../shared/quality';
import { analysisArrows } from '../analysis';
import { drills as drillsApi } from '../api';
import { gamePositions, replay, sanForMove, type Promotion } from '../chess';
import { useAnalysis } from '../hooks/useAnalysis';
import { useChat } from '../hooks/useChat';
import type { SparRequest } from '../spar';
import { AnalysisPanel, EvalBar, evalLabel } from './AnalysisPanel';
import { Board, type SquareBadge } from './Board';
import { Chat } from './Chat';
import { Icon } from './Icon';
import type { Highlight, PlayVariation } from './Message';
import { StatusBar } from './StatusBar';

const NO_ARROWS: Annotation[] = [];

type DrillAttemptState = {
  cardId: string;
  phase: 'solving' | 'wrong' | 'solved' | 'revealed';
  /** Move played by the user during this attempt. */
  attempt: string | null;
  /** Extra moves shown on the board after solving/revealing (e.g., playing out the best move). */
  extraMoves: string[];
  /** Updated card returned by the server after recording the SM-2 review. */
  scheduled: DrillCard | null;
};

function arrowForSan(fen: string, san: string, color: string): Annotation[] {
  try {
    const move = new Chess(fen).move(san);
    return [{ id: 'drill-best', from: move.from, to: move.to, color }];
  } catch {
    return NO_ARROWS;
  }
}

/** Spaced-repetition mistake drill screen backed by `/api/drills`. */
export function DrillsScreen(props: {
  modeSwitch: ReactNode;
  refreshSignal: number;
  onCardsChange: (cards: DrillCard[]) => void;
  onSpar: (request: Omit<SparRequest, 'id'>) => void;
  onGoToGames: () => void;
}) {
  const { modeSwitch, refreshSignal, onCardsChange, onSpar, onGoToGames } = props;
  const [cards, setCards] = useState<DrillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);

  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    drillsApi
      .list()
      .then(list => {
        if (cancelled) return;
        setError(null);
        setCards(list);
        onCardsChange(list);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load drills');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onCardsChange, refreshSignal, manualRefresh]);

  const sorted = useMemo(() => sortDrills(cards), [cards]);
  const dueCards = useMemo(() => sorted.filter(card => isDrillDue(card)), [sorted]);
  const activeCard = useMemo(() => {
    if (selectedId) {
      const match = sorted.find(c => c.id === selectedId);
      if (match) return match;
    }
    return dueCards[0] ?? sorted[0] ?? null;
  }, [selectedId, sorted, dueCards]);

  const updateCard = useCallback(
    (updated: DrillCard) => {
      setSelectedId(prev => prev ?? updated.id);
      setCards(prev => {
        const next = prev.map(c => (c.id === updated.id ? updated : c));
        onCardsChange(next);
        return next;
      });
    },
    [onCardsChange],
  );

  const deleteCard = useCallback(
    async (id: string) => {
      try {
        await drillsApi.remove(id);
        setCards(prev => {
          const next = prev.filter(c => c.id !== id);
          onCardsChange(next);
          return next;
        });
        if (selectedId === id) setSelectedId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not delete drill');
      }
    },
    [onCardsChange, selectedId],
  );

  const pickNext = useCallback(
    (currentId: string) => {
      const freshDue = sortDrills(cards).filter(c => isDrillDue(c) && c.id !== currentId);
      if (freshDue.length) {
        setSelectedId(freshDue[0].id);
        return;
      }
      const remaining = sortDrills(cards).filter(c => c.id !== currentId);
      setSelectedId(remaining[0]?.id ?? null);
    },
    [cards],
  );

  return (
    <DrillWorkspace
      key={activeCard?.id ?? 'empty'}
      card={activeCard}
      cards={sorted}
      dueCount={dueCards.length}
      loading={loading}
      error={error}
      showQueue={showQueue}
      onToggleQueue={() => setShowQueue(open => !open)}
      onSelectCard={id => {
        setSelectedId(id);
        setShowQueue(false);
      }}
      onCardReviewed={updateCard}
      onDeleteCard={deleteCard}
      onNext={pickNext}
      onRefresh={() => setManualRefresh(count => count + 1)}
      onSpar={onSpar}
      onGoToGames={onGoToGames}
      modeSwitch={modeSwitch}
    />
  );
}

function DrillWorkspace(props: {
  card: DrillCard | null;
  cards: DrillCard[];
  dueCount: number;
  loading: boolean;
  error: string | null;
  showQueue: boolean;
  onToggleQueue: () => void;
  onSelectCard: (id: string) => void;
  onCardReviewed: (card: DrillCard) => void;
  onDeleteCard: (id: string) => Promise<void>;
  onNext: (currentId: string) => void;
  onRefresh: () => void;
  onSpar: (request: Omit<SparRequest, 'id'>) => void;
  onGoToGames: () => void;
  modeSwitch: ReactNode;
}) {
  const {
    card,
    cards,
    dueCount,
    loading,
    error,
    showQueue,
    onToggleQueue,
    onSelectCard,
    onCardReviewed,
    onDeleteCard,
    onNext,
    onRefresh,
    onSpar,
    onGoToGames,
    modeSwitch,
  } = props;

  const [flipped, setFlipped] = useState(card?.playerColor === 'black');
  const [attempt, setAttempt] = useState<DrillAttemptState>(() => ({
    cardId: card?.id ?? '',
    phase: 'solving',
    attempt: null,
    extraMoves: [],
    scheduled: null,
  }));
  const [annotation, setAnnotation] = useState({ fen: '', arrows: NO_ARROWS });
  const [activeArrow, setActiveArrow] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const shownMoves = useMemo(
    () => (card ? [...card.moves, ...attempt.extraMoves] : []),
    [card, attempt.extraMoves],
  );
  const shownGame = useMemo(() => replay(shownMoves), [shownMoves]);
  const shownFen = shownGame.fen();
  const positions = useMemo(() => gamePositions(shownMoves), [shownMoves]);
  const spoilersHidden = Boolean(
    card && (attempt.phase === 'solving' || attempt.phase === 'wrong'),
  );

  const analysis = useAnalysis(shownFen);
  const showArrows = useCallback(
    (fen: string, arrows: Annotation[]) => setAnnotation({ fen, arrows }),
    [],
  );
  const highlight = useCallback<Highlight>((message, arrowId) => {
    if (arrowId) setAnnotation({ fen: message.fen, arrows: message.arrows });
    setActiveArrow(arrowId);
  }, []);
  const chat = useChat({ onArrows: showArrows });

  const recordOutcome = async (target: DrillCard, solved: boolean) => {
    setReviewError(null);
    try {
      const updated = await drillsApi.review(target.id, solved);
      onCardReviewed(updated);
      setAttempt(prev => (prev.cardId === target.id ? { ...prev, scheduled: updated } : prev));
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Could not save drill progress');
    }
  };

  const moveOnBoard = (from: Square, to: Square, promotion?: Promotion) => {
    if (!card) return false;
    const san = sanForMove(shownGame, from, to, promotion);
    if (!san) return false;
    if (attempt.phase === 'solving') {
      if (san === card.best) {
        setAttempt({
          cardId: card.id,
          phase: 'solved',
          attempt: san,
          extraMoves: [san],
          scheduled: null,
        });
        void recordOutcome(card, true);
      } else {
        setAttempt({
          cardId: card.id,
          phase: 'wrong',
          attempt: san,
          extraMoves: [san],
          scheduled: null,
        });
      }
      return true;
    }
    if (attempt.phase === 'solved' || attempt.phase === 'revealed') {
      setAttempt(prev => ({ ...prev, extraMoves: [...prev.extraMoves, san] }));
      return true;
    }
    return false;
  };

  const retryDrill = () => {
    if (!card) return;
    setAttempt({
      cardId: card.id,
      phase: 'solving',
      attempt: null,
      extraMoves: [],
      scheduled: null,
    });
  };

  const revealAnswer = () => {
    if (!card) return;
    setAttempt(prev => ({
      cardId: card.id,
      phase: 'revealed',
      attempt: prev.attempt,
      extraMoves: [],
      scheduled: null,
    }));
    void recordOutcome(card, false);
  };

  const playBestMove = () => {
    if (!card) return;
    setAttempt(prev => ({ ...prev, extraMoves: [card.best] }));
  };

  const askCoach = () => {
    if (!card) return;
    chat.ask(
      drillCoachPrompt(card, attempt.attempt),
      { fen: card.fen, moves: card.moves },
      card.playerColor,
      undefined,
      `Explain ${numberedMove(card.moves.length, card.best)}`,
    );
  };

  const playVariation = useCallback<PlayVariation>(
    (sourceFen, variation, step) => {
      if (!card) return;
      const target = variation.slice(0, step + 1);
      if (!target.length) return;
      let prefix: string[];
      if (sourceFen === card.fen) {
        prefix = [];
      } else if (sourceFen === shownFen) {
        prefix = attempt.extraMoves;
      } else if (positions.has(sourceFen)) {
        const offset = Math.max(0, positions.get(sourceFen)!.ply - card.moves.length);
        prefix = attempt.extraMoves.slice(0, offset);
      } else {
        return;
      }
      const board = replay([...card.moves, ...prefix]);
      const played: string[] = [];
      for (const san of target) {
        try {
          const move = board.move(san);
          if (!move) break;
          played.push(move.san);
        } catch {
          break;
        }
      }
      if (!played.length) return;
      setAttempt(prev => ({ ...prev, extraMoves: [...prefix, ...played] }));
    },
    [card, shownFen, attempt.extraMoves, positions],
  );

  const playLineFromCurrent = useCallback(
    (variation: string[], step: number) => playVariation(shownFen, variation, step),
    [playVariation, shownFen],
  );

  const sparFromDrill = () => {
    if (!card) return;
    const elo = nearestOpponentElo(card.rating);
    const label = `${card.opening ?? 'Drill'} · from ${numberedMove(card.moves.length, card.best)}`;
    onSpar({
      moves: attempt.extraMoves.length ? shownMoves : card.moves,
      playerColor: card.playerColor,
      elo,
      label,
    });
  };

  const bestArrow = useMemo(
    () =>
      card && attempt.phase === 'revealed' && attempt.extraMoves.length === 0
        ? arrowForSan(card.fen, card.best, '#86b86b')
        : NO_ARROWS,
    [card, attempt.phase, attempt.extraMoves.length],
  );
  const boardArrows = spoilersHidden
    ? NO_ARROWS
    : annotation.fen === shownFen && annotation.arrows.length
      ? annotation.arrows
      : bestArrow;

  const lastMove = shownGame.history({ verbose: true }).at(-1);
  const badge: SquareBadge | undefined =
    lastMove && attempt.extraMoves.length === 1 && attempt.phase === 'solved'
      ? { square: lastMove.to, glyph: '★', className: 'quality-best', title: 'Best move!' }
      : lastMove && attempt.extraMoves.length === 1 && attempt.phase === 'wrong'
        ? {
            square: lastMove.to,
            glyph: '?',
            className: 'quality-mistake',
            title: 'Not the engine top move',
          }
        : undefined;

  const sideToMove = card ? (card.moves.length % 2 === 0 ? 'White' : 'Black') : 'White';
  const ply = card?.moves.length ?? 0;

  return (
    <main className="drills">
      <div className="workspace">
        <section className="board-section" aria-label="Mistake drill board">
          <div className="stage">
            <div className="player">
              <strong>{flipped ? 'White' : 'Black'}</strong>
              {card && card.playerColor !== (flipped ? 'white' : 'black') && (
                <span className="label">opponent</span>
              )}
            </div>
            <Board
              id="drills-board"
              position={shownGame}
              flipped={flipped}
              interactive={Boolean(card) && attempt.phase !== 'wrong'}
              onMove={moveOnBoard}
              arrows={boardArrows}
              activeArrow={spoilersHidden ? null : activeArrow}
              badge={badge}
              candidates={
                !spoilersHidden && analysis.showArrows
                  ? analysisArrows(shownFen, analysis.candidates)
                  : NO_ARROWS
              }
              evalBar={
                <EvalBar
                  score={spoilersHidden ? undefined : analysis.engine.data?.evaluation}
                  flipped={flipped}
                />
              }
            />
            <div className="player">
              <strong>{flipped ? 'Black' : 'White'}</strong>
              {card && card.playerColor === (flipped ? 'black' : 'white') && (
                <span className="label">you</span>
              )}
              <span className="label evaluation" title="Stockfish evaluation, from White's side">
                {spoilersHidden ? 'Hidden' : evalLabel(analysis.engine)}
              </span>
              <strong className="game-status" role="status">
                {!card
                  ? 'No drills saved'
                  : attempt.phase === 'solving'
                    ? `${sideToMove} to move · Find the best move`
                    : attempt.phase === 'wrong'
                      ? 'Try again or reveal'
                      : attempt.phase === 'solved'
                        ? 'Solved!'
                        : `Best: ${numberedMove(ply, card.best)}`}
              </strong>
            </div>
            <div className="board-toolbar">
              <div className="controls">
                <button type="button" onClick={() => setFlipped(!flipped)}>
                  <Icon name="flip" size={15} />
                  Flip
                </button>
                {card && (
                  <button
                    type="button"
                    title="Open this exact position on the Board tab against Maia3"
                    onClick={sparFromDrill}
                  >
                    Spar vs Maia3
                  </button>
                )}
              </div>
              {card?.gameUrl && (
                <div className="controls">
                  <a href={card.gameUrl} target="_blank" rel="noreferrer">
                    chess.com ↗
                  </a>
                </div>
              )}
            </div>
          </div>
        </section>

        {showQueue || !card ? (
          <section className="repertoire-panel drills-panel" aria-label="Mistake drills queue">
            <header className="repertoire-header games-form">
              <h2>
                Mistake drills{' '}
                <span className="count">
                  {dueCount} due · {cards.length} total
                </span>
              </h2>
              <button type="button" onClick={onRefresh}>
                Refresh
              </button>
              {card && (
                <button type="button" onClick={onToggleQueue}>
                  Back to drill
                </button>
              )}
            </header>
            {error && (
              <p className="repertoire-error" role="alert">
                {error}
              </p>
            )}
            <div className="repertoire-list">
              {loading ? (
                <p className="repertoire-empty">Loading drills…</p>
              ) : !cards.length ? (
                <div className="repertoire-empty drills-empty">
                  <p>
                    No mistake drills saved yet. Open any reviewed game in <strong>My games</strong>{' '}
                    and click <strong>Save drills</strong> to turn your mistakes into spaced
                    repetition puzzles.
                  </p>
                  <button type="button" className="primary" onClick={onGoToGames}>
                    Open My games
                  </button>
                </div>
              ) : (
                cards.map(item => {
                  const due = isDrillDue(item);
                  return (
                    <div
                      key={item.id}
                      className={`drill-row${item.id === card?.id ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        className="drill-row-main"
                        onClick={() => onSelectCard(item.id)}
                      >
                        <strong className={`quality-${item.quality}`}>
                          {numberedMove(item.moves.length, item.played)}
                        </strong>
                        <span className="drill-row-meta">
                          {item.opening ?? 'Reviewed game'} · as {item.playerColor}
                        </span>
                        <span className={`label${due ? ' drill-due' : ''}`}>
                          {formatDueLabel(item.dueAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="drill-delete"
                        title="Remove drill"
                        onClick={() => void onDeleteCard(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        ) : (
          <Chat
            chat={chat}
            analysisPanel={
              <>
                <div className="game-header">
                  <button type="button" onClick={onToggleQueue}>
                    Queue ({dueCount} due / {cards.length})
                  </button>
                  <span>
                    {card.opening ?? 'Reviewed game'} · {formatDueLabel(card.dueAt)}
                  </span>
                </div>
                <section className="coach-card" aria-label="Drill prompt">
                  <div className="coach-card-head">
                    <span className="label">Mistake drill · {sideToMove} to move</span>
                    <span className={`coach-tag quality-${card.quality}`}>{card.quality}</span>
                    {card.reps > 0 && <span className="label">streak {card.reps}</span>}
                  </div>

                  {attempt.phase === 'solving' && (
                    <>
                      <p className="coach-prompt">
                        In your game you played <strong>{numberedMove(ply, card.played)}</strong>.
                        Play the stronger move on the board.
                      </p>
                      <div className="coach-actions">
                        <span className="coach-hint">
                          Eval bar and engine lines stay hidden while solving.
                        </span>
                        <button type="button" className="coach-link" onClick={revealAnswer}>
                          Reveal answer
                        </button>
                      </div>
                    </>
                  )}

                  {attempt.phase === 'wrong' && (
                    <>
                      <p className="coach-verdict">
                        You tried <strong>{numberedMove(ply, attempt.attempt ?? '')}</strong> — not
                        Stockfish&apos;s top choice.
                      </p>
                      <div className="coach-actions">
                        <button type="button" className="coach-primary" onClick={retryDrill}>
                          Try again
                        </button>
                        <button type="button" className="coach-link" onClick={revealAnswer}>
                          Reveal answer
                        </button>
                      </div>
                    </>
                  )}

                  {attempt.phase === 'solved' && (
                    <>
                      <p className="coach-verdict">
                        <strong className="coach-hit">
                          ★ Solved! {numberedMove(ply, card.best)}
                        </strong>
                        {attempt.scheduled && (
                          <>
                            {' '}
                            · Next review {formatDueLabel(attempt.scheduled.dueAt).toLowerCase()}
                          </>
                        )}
                      </p>
                      <div className="coach-actions">
                        <div className="coach-action-group">
                          <button type="button" className="coach-link" onClick={askCoach}>
                            Ask coach why
                          </button>
                          <button type="button" className="coach-link" onClick={sparFromDrill}>
                            Spar vs Maia3
                          </button>
                        </div>
                        {cards.length > 1 && (
                          <button
                            type="button"
                            className="coach-primary"
                            onClick={() => onNext(card.id)}
                          >
                            Next drill →
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {attempt.phase === 'revealed' && (
                    <>
                      <p className="coach-verdict">
                        Best move: <strong>{numberedMove(ply, card.best)}</strong> · Game:{' '}
                        <strong>{numberedMove(ply, card.played)}</strong>
                        {attempt.scheduled && <> · Retry queued soon</>}
                      </p>
                      <div className="coach-actions">
                        <div className="coach-action-group">
                          {attempt.extraMoves.length === 0 && (
                            <button type="button" className="coach-link" onClick={playBestMove}>
                              Play {card.best}
                            </button>
                          )}
                          <button type="button" className="coach-link" onClick={askCoach}>
                            Ask coach why
                          </button>
                          <button type="button" className="coach-link" onClick={sparFromDrill}>
                            Spar vs Maia3
                          </button>
                        </div>
                        {cards.length > 1 && (
                          <button
                            type="button"
                            className="coach-primary"
                            onClick={() => onNext(card.id)}
                          >
                            Next drill →
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {reviewError && <p className="repertoire-error">{reviewError}</p>}
                </section>
                {!spoilersHidden && (
                  <AnalysisPanel
                    analysis={analysis}
                    fen={shownFen}
                    onPlayLine={playLineFromCurrent}
                  />
                )}
              </>
            }
            fen={shownFen}
            positions={positions}
            onSelectPly={targetPly => {
              const offset = Math.max(0, targetPly - card.moves.length);
              setAttempt(prev => ({ ...prev, extraMoves: prev.extraMoves.slice(0, offset) }));
            }}
            onPlayVariation={spoilersHidden ? undefined : playVariation}
            onAsk={message =>
              chat.ask(message, { fen: shownFen, moves: shownMoves }, card.playerColor)
            }
            onHighlight={highlight}
          />
        )}
      </div>
      <StatusBar
        lead={modeSwitch}
        fen={shownFen}
        usage={chat.usage}
        notice={
          !card
            ? 'Save mistakes from any reviewed game to build your drill queue.'
            : spoilersHidden
              ? 'Find the best move on the board. Engine hints stay hidden until you solve or reveal.'
              : 'Drill revealed. Explore lines, ask the coach, or spar from here against Maia3.'
        }
      />
    </main>
  );
}
