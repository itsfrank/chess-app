import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Annotation, ArchivedGame, PlayerColor } from '../../shared/protocol';
import type { Trace } from '../../shared/habits';
import {
  numberedMove,
  QUALITIES,
  type GameReview as Review,
  type QualityId,
} from '../../shared/quality';
import { analysisArrows } from '../analysis';
import { gamePositions, replay } from '../chess';
import { useAnalysis } from '../hooks/useAnalysis';
import { useChat } from '../hooks/useChat';
import { useGameReview } from '../hooks/useGameReview';
import { useRepertoireTrace } from '../hooks/useRepertoireTrace';
import { useGames, type GamesState } from '../hooks/useGames';
import { AnalysisPanel, EvalBar, evalLabel } from './AnalysisPanel';
import { Board, type SquareBadge } from './Board';
import { Chat } from './Chat';
import { Icon } from './Icon';
import type { Highlight } from './Message';
import { HistoryNavigation, MoveList, type MoveMark } from './MoveHistory';
import { StatusBar } from './StatusBar';

const NO_MOVES: string[] = [];
const NO_ARROWS: Annotation[] = [];
const MOVES_OPEN_KEY = 'chess-app.games-moves-open';
/** Column headings that would not fit the companion's width in full. */
const SHORT_LABELS: Partial<Record<QualityId, string>> = {
  excellent: 'Excel.',
  inaccuracy: 'Inacc.',
};
const RESULT_TEXT = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½' };

/**
 * The user's chess.com games: a list to choose from, then the chosen game on
 * the board with the companion beside it. Each game has its own conversation,
 * which lasts until another game is chosen.
 */
export function GamesScreen({ modeSwitch }: { modeSwitch: ReactNode }) {
  const library = useGames();
  const [game, setGame] = useState<ArchivedGame | null>(null);
  const [browsing, setBrowsing] = useState(true);
  const list = (
    <GameList
      // The form follows the listed player, also when the settings change it.
      key={library.username}
      library={library}
      selected={game}
      onSelect={chosen => {
        setGame(chosen);
        setBrowsing(false);
      }}
      onClose={() => setBrowsing(false)}
    />
  );
  return (
    <GameReview
      key={game?.url ?? ''}
      game={game}
      list={browsing || !game ? list : null}
      onBrowse={() => setBrowsing(true)}
      modeSwitch={modeSwitch}
    />
  );
}

/** One finished game, stepped through on the board; `list` replaces the companion while choosing. */
function GameReview(props: {
  game: ArchivedGame | null;
  list: ReactNode;
  onBrowse: () => void;
  modeSwitch: ReactNode;
}) {
  const { game, list, onBrowse, modeSwitch } = props;
  const moves = game?.moves ?? NO_MOVES;
  /** Number of half-moves shown. */
  const [ply, setPly] = useState(0);
  const [flipped, setFlipped] = useState(game?.playerColor === 'black');
  /** The companion's arrows and the position they were drawn for. */
  const [annotation, setAnnotation] = useState({ fen: '', arrows: NO_ARROWS });
  const [activeArrow, setActiveArrow] = useState<string | null>(null);
  const [movesOpen, setMovesOpen] = useState(() => localStorage.getItem(MOVES_OPEN_KEY) !== '0');

  const positions = useMemo(() => gamePositions(moves), [moves]);
  const shownMoves = useMemo(() => moves.slice(0, ply), [moves, ply]);
  const shownGame = useMemo(() => replay(shownMoves), [shownMoves]);
  const shownFen = shownGame.fen();

  const analysis = useAnalysis(shownFen);
  const { review, error: reviewError, retry: retryReview } = useGameReview(moves);
  const repertoire = useRepertoireTrace(game);
  /** The verdict on each move, for the move list and the board. */
  const marks = useMemo(
    () =>
      review.moves.map((move, index): MoveMark | undefined => {
        if (!move) return undefined;
        const { id, label, glyph } = move.quality;
        const note =
          id === 'great'
            ? ' · the only good move'
            : id === 'book'
              ? ' · opening theory'
              : id !== 'best' && move.best
                ? ` · engine preferred ${move.best}`
                : '';
        return {
          // The scoresheet only flags the engine's moves and the errors; the board shows every label.
          glyph: id === 'book' || id === 'excellent' || id === 'good' ? '' : glyph,
          className: `quality-${id}`,
          title: `${numberedMove(index, moves[index])} · ${label}${note}`,
        };
      }),
    [review, moves],
  );
  const lastMove = shownGame.history({ verbose: true }).at(-1);
  const shownReview = review.moves[ply - 1];
  const badge: SquareBadge | undefined =
    lastMove && shownReview
      ? {
          square: lastMove.to,
          glyph: shownReview.quality.glyph,
          className: `quality-${shownReview.quality.id}`,
          title: marks[ply - 1]!.title,
        }
      : undefined;
  const showArrows = useCallback(
    (fen: string, arrows: Annotation[]) => setAnnotation({ fen, arrows }),
    [],
  );
  const highlight = useCallback<Highlight>((message, arrowId) => {
    if (arrowId) setAnnotation({ fen: message.fen, arrows: message.arrows });
    setActiveArrow(arrowId);
  }, []);
  const chat = useChat({ onArrows: showArrows });

  const selectPly = (next: number) => {
    setPly(next);
    setActiveArrow(null);
  };
  /**
   * Steps back to where the shown move was chosen and has the companion compare
   * it with the engine's choice there, where arrows for both make sense.
   */
  const explainMove = () => {
    const move = review.moves[ply - 1];
    if (!game || !move) return;
    const played = numberedMove(ply - 1, moves[ply - 1]);
    const mine = (ply % 2 === 1) === (game.playerColor === 'white');
    const before = moves.slice(0, ply - 1);
    const verdict =
      move.quality.id === 'book'
        ? 'It is common opening theory. Explain the idea behind it and name the main alternatives.'
        : move.best === moves[ply - 1]
          ? `The engine review labels it ${move.quality.label}: it is the engine's own choice. Explain the idea behind it and, using Stockfish, what the most natural alternative would have allowed.`
          : `The engine review labels it ${move.quality.label} and prefers ${move.best}. Using Stockfish from this position, compare the two: where does each lead, and what did the move played miss or allow? Draw one arrow for the move played and one for the engine's choice.`;
    selectPly(ply - 1);
    chat.ask(
      `From this position ${mine ? 'I' : 'my opponent'} played ${played}. ${verdict}`,
      { fen: replay(before).fen(), moves: before },
      game.playerColor,
      game,
      `Explain ${played}`,
    );
  };
  const history = { moves, ply, onSelect: selectPly };
  const toggleMoves = () => {
    localStorage.setItem(MOVES_OPEN_KEY, movesOpen ? '0' : '1');
    setMovesOpen(!movesOpen);
  };

  const seat = (color: PlayerColor) => {
    if (!game) return <strong>{color === 'white' ? 'White' : 'Black'}</strong>;
    const { name, rating } = game[color];
    return (
      <>
        <strong>{name}</strong>
        <span className="label">
          {[rating, color, color === game.playerColor && 'you'].filter(Boolean).join(' · ')}
        </span>
      </>
    );
  };
  const outcome = game
    ? [RESULT_TEXT[game.result], game.termination].filter(Boolean).join(' · ')
    : 'Choose a game';

  return (
    <main className={`games${movesOpen ? ' moves-open' : ''}`}>
      <div className="workspace">
        {movesOpen && <MoveList {...history} marks={marks} />}
        <section className="board-section" aria-label="Game under review">
          <div className="stage">
            <div className="player">{seat(flipped ? 'white' : 'black')}</div>
            <Board
              id="games-board"
              position={shownGame}
              flipped={flipped}
              interactive={false}
              onMove={() => false}
              arrows={annotation.fen === shownFen ? annotation.arrows : NO_ARROWS}
              activeArrow={activeArrow}
              badge={badge}
              candidates={
                analysis.showArrows ? analysisArrows(shownFen, analysis.candidates) : NO_ARROWS
              }
              evalBar={<EvalBar score={analysis.engine.data?.evaluation} flipped={flipped} />}
            />
            <div className="player">
              {seat(flipped ? 'black' : 'white')}
              <span className="label evaluation" title="Stockfish evaluation, from White's side">
                {evalLabel(analysis.engine)}
              </span>
              <strong className="game-status" role="status" title={outcome}>
                {outcome}
              </strong>
            </div>
            <div className="board-toolbar">
              <HistoryNavigation {...history} endLabel="End of game" />
              <div className="controls">
                <button onClick={() => setFlipped(!flipped)}>
                  <Icon name="flip" size={15} />
                  Flip
                </button>
                {game && (
                  <a href={game.url} target="_blank" rel="noreferrer">
                    chess.com ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
        {list ??
          (game && (
            <Chat
              chat={chat}
              analysisPanel={
                <>
                  <div className="game-header">
                    <button onClick={onBrowse}>← Games</button>
                    <span>
                      {game.white.name} – {game.black.name}
                      {game.opening && ` · ${game.opening}`}
                    </span>
                  </div>
                  <ReviewSummary
                    game={game}
                    review={review}
                    error={reviewError}
                    onRetry={retryReview}
                    shown={marks[ply - 1]}
                    onExplain={explainMove}
                  />
                  {repertoire && (
                    <RepertoireNote {...repertoire} moves={moves} onSelectPly={selectPly} />
                  )}
                  <AnalysisPanel analysis={analysis} fen={shownFen} />
                </>
              }
              fen={shownFen}
              positions={positions}
              onSelectPly={selectPly}
              onAsk={message =>
                chat.ask(message, { fen: shownFen, moves: shownMoves }, game.playerColor, game)
              }
              onHighlight={highlight}
            />
          ))}
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
        notice={game ? `${game.white.name} against ${game.black.name}. ${outcome}.` : outcome}
      />
    </main>
  );
}

/** Where the game left the user's repertoire, with a way to jump there. */
function RepertoireNote(props: {
  name: string;
  trace: Trace;
  moves: string[];
  onSelectPly: (ply: number) => void;
}) {
  const { name, trace, moves, onSelectPly } = props;
  const { plies, exit, played, expected } = trace;
  const move = played && numberedMove(plies, played);
  const last = plies ? numberedMove(plies - 1, moves[plies - 1]) : 'the first move';
  const text =
    exit === 'deviation'
      ? `You left it with ${move}; it plays ${expected.join(' or ')}.`
      : exit === 'uncovered'
        ? `Your opponent left it with ${move}, which it has no answer to.`
        : exit === 'line-end'
          ? `You followed it to the end of its line, ${last}.`
          : 'The whole game stayed inside it.';
  return (
    <p className={`repertoire-trace${exit === 'deviation' ? ' deviation' : ''}`}>
      <span className="label">Repertoire</span>
      <span title={`Compared with “${name}”`}>{text}</span>
      {plies < moves.length && (
        <button onClick={() => onSelectPly(exit === 'line-end' ? plies : plies + 1)}>Show</button>
      )}
    </p>
  );
}

/** Each side's accuracy and how many of its moves got each label, with the verdict on the shown move. */
function ReviewSummary(props: {
  game: ArchivedGame;
  review: Review;
  error: string;
  onRetry: () => void;
  shown: MoveMark | undefined;
  /** Asks the companion about the shown move. */
  onExplain: () => void;
}) {
  const { game, review, error, onRetry, shown, onExplain } = props;
  const complete = review.done === game.moves.length;
  return (
    <section className="review-summary" aria-label="Game review">
      <table>
        <thead>
          <tr>
            <td />
            <th scope="col" title="Accuracy">
              Acc.
            </th>
            {QUALITIES.map(quality => (
              <th
                key={quality.id}
                scope="col"
                className={`quality-${quality.id}`}
                title={quality.label}
              >
                {SHORT_LABELS[quality.id] ?? quality.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(['white', 'black'] as const).map(color => (
            <tr key={color}>
              <th scope="row">{game[color].name}</th>
              <td className="accuracy">{review[color].accuracy?.toFixed(1) ?? '—'}</td>
              {QUALITIES.map(quality => (
                <td key={quality.id}>{review[color].counts[quality.id]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p role="status">
        {error ? (
          <>
            {error} <button onClick={onRetry}>Retry</button>
          </>
        ) : !complete ? (
          `Reviewing the game with Stockfish… ${review.done} / ${game.moves.length} moves`
        ) : shown ? (
          <>
            <span className={shown.className}>{shown.title}</span>{' '}
            <button
              onClick={onExplain}
              title="Go back to the position before this move and ask the companion to explain it"
            >
              Explain
            </button>
          </>
        ) : (
          'Step through the game to see the verdict on each move.'
        )}
      </p>
    </section>
  );
}

/** "10 min", "3+2" or "1 day/move" from chess.com's time control in seconds. */
function timeControlText(control: string): string {
  const daily = control.match(/^1\/(\d+)$/);
  if (daily) return `${Math.round(Number(daily[1]) / 86_400)} day/move`;
  const [, base, increment] = control.match(/^(\d+)(?:\+(\d+))?$/) ?? [];
  if (!base) return control;
  const minutes = Number((Number(base) / 60).toFixed(1));
  return increment ? `${minutes}+${increment}` : `${minutes} min`;
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** How the game went for the player whose games are listed. */
function outcomeFor(game: ArchivedGame): 'Won' | 'Lost' | 'Draw' {
  if (game.result === '1/2-1/2') return 'Draw';
  return (game.result === '1-0') === (game.playerColor === 'white') ? 'Won' : 'Lost';
}

/** The username form and the player's games; choosing one opens it for review. */
function GameList(props: {
  library: GamesState;
  selected: ArchivedGame | null;
  onSelect: (game: ArchivedGame) => void;
  /** Returns to the selected game without choosing another. */
  onClose: () => void;
}) {
  const { library, selected, onSelect, onClose } = props;
  const { games, loading, error } = library;
  const [name, setName] = useState(library.username);

  return (
    <section className="repertoire-panel games-panel" aria-label="Games">
      <form
        className="repertoire-header games-form"
        onSubmit={event => {
          event.preventDefault();
          if (name.trim()) void library.load(name.trim());
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
        <button className="primary" disabled={loading || !name.trim()}>
          {games.length && name.trim().toLowerCase() === library.username.toLowerCase()
            ? 'Refresh'
            : 'Load games'}
        </button>
        {selected && (
          <button type="button" onClick={onClose}>
            Back to game
          </button>
        )}
      </form>
      {error && (
        <p className="repertoire-error" role="alert">
          {error}
        </p>
      )}
      <div className="repertoire-list">
        {!games.length && !error && (
          <p className="repertoire-empty">
            {loading
              ? 'Loading games…'
              : library.username
                ? 'No standard games found.'
                : 'Enter your chess.com username to list your recent games, then choose one to go through with the companion.'}
          </p>
        )}
        {games.map(game => {
          const outcome = outcomeFor(game);
          const opponent = game[game.playerColor === 'white' ? 'black' : 'white'];
          return (
            <button
              key={game.url}
              className="game-row"
              aria-current={game.url === selected?.url ? 'true' : undefined}
              onClick={() => onSelect(game)}
            >
              <strong className={`outcome-${outcome.toLowerCase()}`}>{outcome}</strong>
              <span className="game-opponent">
                {opponent.name}
                {opponent.rating !== null && <small> {opponent.rating}</small>}
              </span>
              <span className="label">
                {game.timeClass} · {timeControlText(game.timeControl)}
              </span>
              <span className="game-details">
                {[
                  dateText(game.playedAt),
                  `as ${game.playerColor}`,
                  `${Math.ceil(game.moves.length / 2)} moves`,
                  game.opening,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          );
        })}
        {games.length > 0 && library.hasOlder && (
          <button className="load-older" disabled={loading} onClick={library.loadOlder}>
            {loading ? 'Loading…' : 'Load older games'}
          </button>
        )}
      </div>
    </section>
  );
}
