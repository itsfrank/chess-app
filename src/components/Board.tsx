import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Chess, Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { Annotation } from '../../shared/protocol';
import { legalTargets, needsPromotion, squareCenter, type Promotion } from '../chess';

const PROMOTIONS: [Promotion, string][] = [
  ['q', 'Queen'],
  ['r', 'Rook'],
  ['b', 'Bishop'],
  ['n', 'Knight'],
];
const LAST_MOVE: CSSProperties = { backgroundImage: 'linear-gradient(#d6aa3c61, #d6aa3c61)' };
const DARK = '#b5a688';
const LIGHT = '#e6ddc9';
const notation = (color: string): CSSProperties => ({ color, fontSize: '11px', fontWeight: 500 });
const ARROW_INSET = 20;
/** Sideways shift that keeps a candidate arrow visible beside a companion arrow on the same squares. */
const OVERLAP_OFFSET = 18;

export type SquareBadge = { square: Square; glyph: string; className: string; title: string };

/** A click-selected piece, plus its destination once a promotion choice is pending. */
type Selection = { fen: string; from: Square; to?: Square };

export function Board(props: {
  position: Chess;
  flipped: boolean;
  /** Whether the user may move pieces in this position. */
  interactive: boolean;
  /** Plays a move; returns false if it was rejected. */
  onMove: (from: Square, to: Square, promotion?: Promotion) => boolean;
  /** The companion's arrows for this position. */
  arrows: Annotation[];
  activeArrow: string | null;
  /** Candidate moves from the analysis panel, drawn dotted. */
  candidates: Annotation[];
  /** Rendered to the left of the board. */
  evalBar: ReactNode;
  /** A verdict pinned to the corner of a square, such as the quality of the move that landed there. */
  badge?: SquareBadge;
  /** Distinguishes this board's elements when more than one board is mounted. */
  id?: string;
}) {
  const { position, flipped, interactive, onMove, arrows, activeArrow, candidates, evalBar } =
    props;
  const fen = position.fen();
  // Tied to the position it was made in, so it lapses by itself when the board changes.
  const [stored, setSelection] = useState<Selection | null>(null);
  const selection = interactive && stored?.fen === fen ? stored : null;
  const promoting = selection?.to !== undefined;
  const targets = selection && !promoting ? legalTargets(position, selection.from) : [];

  const move = (from: Square, to: Square) => {
    if (!interactive || promoting) return false;
    if (needsPromotion(position, from, to)) {
      setSelection({ fen, from, to });
      return false;
    }
    setSelection(null);
    return onMove(from, to);
  };

  const squareStyles: Record<string, CSSProperties> = {};
  const lastMove = position.history({ verbose: true }).at(-1);
  if (lastMove) squareStyles[lastMove.from] = squareStyles[lastMove.to] = LAST_MOVE;
  for (const square of targets) {
    squareStyles[square] = { ...squareStyles[square], boxShadow: 'inset 0 0 0 5px #6b5a3399' };
  }
  if (selection) {
    squareStyles[selection.from] = { ...squareStyles[selection.from], backgroundColor: '#d9b95c' };
  }

  return (
    <>
      <div className="board-and-eval">
        {evalBar}
        <div className="board-wrap">
          <Chessboard
            options={{
              id: props.id ?? 'review-board',
              position: fen,
              boardOrientation: flipped ? 'black' : 'white',
              allowDrawingArrows: false,
              allowDragging: interactive && !promoting,
              darkSquareStyle: { backgroundColor: DARK },
              lightSquareStyle: { backgroundColor: LIGHT },
              darkSquareNotationStyle: notation(LIGHT),
              lightSquareNotationStyle: notation(DARK),
              squareStyles,
              canDragPiece: ({ square }) =>
                !!square &&
                interactive &&
                !promoting &&
                position.get(square as Square)?.color === position.turn(),
              onPieceDrop: ({ sourceSquare, targetSquare }) =>
                !!targetSquare && move(sourceSquare as Square, targetSquare as Square),
              onSquareClick: ({ square }) => {
                if (!interactive || promoting) return;
                const target = square as Square;
                if (selection && targets.includes(target)) move(selection.from, target);
                else {
                  const own = position.get(target)?.color === position.turn();
                  setSelection(own ? { fen, from: target } : null);
                }
              },
            }}
          />
          <ArrowOverlay
            arrows={arrows}
            active={activeArrow}
            candidates={candidates}
            flipped={flipped}
            badge={props.badge}
          />
        </div>
      </div>
      {selection?.to && (
        <div className="promotion" role="group" aria-label="Choose promotion piece">
          <strong>Promote to</strong>
          {PROMOTIONS.map(([piece, name]) => (
            <button
              key={piece}
              onClick={() => {
                setSelection(null);
                onMove(selection.from, selection.to!, piece);
              }}
            >
              {name}
            </button>
          ))}
          <button onClick={() => setSelection(null)}>Cancel</button>
        </div>
      )}
    </>
  );
}

/**
 * Arrows drawn over the board. Companion arrows are solid, and the active one
 * is emphasised while the rest dim; analysis candidates are dotted.
 */
function ArrowOverlay(props: {
  arrows: Annotation[];
  active: string | null;
  candidates: Annotation[];
  flipped: boolean;
  badge?: SquareBadge;
}) {
  const { arrows, active, candidates, flipped, badge } = props;
  const [badgeX, badgeY] = badge ? squareCenter(badge.square, flipped) : [0, 0];
  const sameSquares = (a: Annotation, b: Annotation) =>
    (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);

  /** Line endpoints, stopping short of the target's centre so the arrowhead lands on it. */
  const geometry = (arrow: Annotation, offset = 0) => {
    const [x1, y1] = squareCenter(arrow.from, flipped);
    const [x2, y2] = squareCenter(arrow.to, flipped);
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [dx, dy] = [(x2 - x1) / length, (y2 - y1) / length];
    return {
      x1: x1 - dy * offset,
      y1: y1 + dx * offset,
      x2: x2 - dy * offset - dx * ARROW_INSET,
      y2: y2 + dx * offset - dy * ARROW_INSET,
      strokeLinecap: 'round' as const,
      stroke: arrow.color,
      markerEnd: `url(#head-${arrow.id})`,
    };
  };

  return (
    <svg className="annotation-overlay" viewBox="0 0 800 800" aria-hidden="true">
      {badge && (
        <g
          className={`square-badge ${badge.className}`}
          transform={`translate(${Math.min(badgeX + 40, 778)} ${Math.max(badgeY - 40, 22)})`}
        >
          <title>{badge.title}</title>
          <circle r="20" />
          <text textAnchor="middle" dominantBaseline="central">
            {badge.glyph}
          </text>
        </g>
      )}
      <defs>
        {[...arrows, ...candidates].map(arrow => (
          <marker
            key={arrow.id}
            id={`head-${arrow.id}`}
            markerWidth="4"
            markerHeight="4"
            refX="3"
            refY="2"
            orient="auto"
          >
            <path d="M0,0 L4,2 L0,4 Z" fill={arrow.color} />
          </marker>
        ))}
      </defs>
      {candidates.map(candidate => {
        const overlaps = arrows.some(arrow => sameSquares(arrow, candidate));
        return (
          <line
            key={candidate.id}
            {...geometry(candidate, overlaps ? OVERLAP_OFFSET : 0)}
            strokeWidth={10}
            strokeDasharray="1 20"
            opacity={0.95}
          />
        );
      })}
      {arrows.map(arrow => {
        const isActive = active === arrow.id;
        return (
          <line
            key={arrow.id}
            {...geometry(arrow)}
            strokeWidth={isActive ? 15 : 12}
            opacity={isActive ? 1 : active ? 0.22 : 0.86}
          />
        );
      })}
    </svg>
  );
}
