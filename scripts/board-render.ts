/**
 * Pure chess diagram parser & HTML/SVG renderer for `scripts/board-shot.ts`.
 * Matches the chess-app board palette and arrow semantics with zero browser
 * runtime needed to produce markup.
 */
import { Chess, DEFAULT_POSITION, type Square } from 'chess.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultPieces } from 'react-chessboard';
import { annotationPalette } from '../shared/annotation-palette.ts';
import type { PlayerColor } from '../shared/protocol.ts';
import { stripMoveNumber } from '../shared/san.ts';

const SQUARE_RE = /^[a-h][1-8]$/;
const UCI_ARROW_RE = /^([a-h][1-8])(?:-|->)?([a-h][1-8])$/i;
const UCI_MOVE_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const DARK_SQUARE = '#b5a688';
const LIGHT_SQUARE = '#e6ddc9';
const ARROW_INSET = 18;
const ARROW_START_INSET = 16;
const OVERLAP_OFFSET = 16;

const DEFAULT_COLORS = [
  annotationPalette.blue,
  annotationPalette.green,
  annotationPalette.orange,
  annotationPalette.purple,
  annotationPalette.red,
  annotationPalette.cyan,
  annotationPalette.yellow,
] as const;

const EXTRA_COLORS: Record<string, string> = {
  amber: '#f59e0b',
  gold: '#f5dc50',
  gray: '#9ca3af',
  grey: '#9ca3af',
  white: '#f3efe6',
};

/** Slightly deeper arrow tones for red/green so they stay high-contrast on light wood squares. */
const ARROW_TINT_OVERRIDES: Record<string, string> = {
  red: '#e03e4b',
  green: '#22b14c',
};

const BADGE_DEFAULT_COLORS: Record<string, string> = {
  '!!': '#24d4e8',
  '!': '#4ade80',
  '!?': '#60a5fa',
  '?!': '#f5dc50',
  '?': '#fb923c',
  '??': '#ff5266',
};

export type ArrowStyle = 'solid' | 'dashed' | 'dotted';

export type ArrowSpec =
  | string
  | {
      san?: string;
      from?: string;
      to?: string;
      color?: string;
      label?: string;
      style?: ArrowStyle;
      dashed?: boolean;
      dotted?: boolean;
    };

export type HighlightSpec =
  | string
  | {
      square?: string;
      squares?: string[];
      color?: string;
      label?: string;
    };

export type BadgeSpec =
  | string
  | {
      square: string;
      glyph: string;
      color?: string;
    };

export type BoardSpec = {
  /** Output file path or base filename (used in batch mode). */
  out?: string;
  /** Starting FEN; defaults to the standard starting position. */
  fen?: string;
  /** PGN fragment or space-separated SAN/UCI moves played from `fen`. */
  moves?: string | string[];
  /** Board orientation ('white' or 'black'). */
  orientation?: PlayerColor;
  /** Convenience alias for `orientation: 'black'`. */
  flip?: boolean;
  /** Header title. */
  title?: string;
  /** Optional subtitle shown under the title. */
  subtitle?: string;
  /** Hide the automatic "White/Black to move" pill in the header. */
  hideTurn?: boolean;
  /** Optional footer note rendered below the board. */
  note?: string;
  /** Optional eval bar value, e.g. "+0.86", "-1.4", "M3", or numeric pawns. */
  eval?: string | number;
  /** Override last-move highlight (`"e2e4"` / `"e2-e4"`), or `false` / `"none"` to hide. */
  lastMove?: string | false | null;
  /** Arrows drawn over the board. */
  arrows?: ArrowSpec[];
  /** Square highlights drawn beneath pieces. */
  highlights?: HighlightSpec[];
  /** Corner badges pinned to squares (e.g. `?!`, `!`, `??`). */
  badges?: BadgeSpec[];
  /** Board pixel width in CSS px (default 528; rendered at 2x scale by default). */
  width?: number;
};

export type ResolvedArrow = {
  from: Square;
  to: Square;
  color: string;
  label?: string;
  style: ArrowStyle;
};

export type ResolvedHighlight = {
  square: Square;
  color: string;
  label?: string;
};

export type ResolvedBadge = {
  square: Square;
  glyph: string;
  color: string;
};

export type ResolvedEval = {
  label: string;
  /** Percentage of the bar filled by White (0..100). */
  whitePct: number;
};

export type ResolvedBoard = {
  chess: Chess;
  fen: string;
  turn: PlayerColor;
  flipped: boolean;
  lastMove: { from: Square; to: Square } | null;
  arrows: ResolvedArrow[];
  highlights: ResolvedHighlight[];
  badges: ResolvedBadge[];
  evalBar: ResolvedEval | null;
  title?: string;
  subtitle?: string;
  showTurn: boolean;
  note?: string;
  boardSize: number;
};

type PieceKey = keyof typeof defaultPieces;

const pieceSvgCache = new Map<string, string>();

function getPieceSvg(color: 'w' | 'b', type: string): string {
  const key = `${color}${type.toUpperCase()}` as PieceKey;
  let cached = pieceSvgCache.get(key);
  if (!cached) {
    const renderer = defaultPieces[key];
    cached = renderer ? renderToStaticMarkup(React.createElement(renderer, {})) : '';
    pieceSvgCache.set(key, cached);
  }
  return cached;
}

/** Resolves a named color (palette or alias) or `#hex`, with optional richer arrow tint. */
export function resolveColor(raw: string, forArrow = false): string | null {
  const trimmed = raw.trim();
  const key = trimmed.toLowerCase();
  if (!key) return null;
  if (forArrow && ARROW_TINT_OVERRIDES[key]) return ARROW_TINT_OVERRIDES[key];
  if (EXTRA_COLORS[key]) return EXTRA_COLORS[key];
  const named = annotationPalette[key as keyof typeof annotationPalette];
  if (named) return named;
  if (HEX_COLOR_RE.test(trimmed)) return trimmed;
  return null;
}

/**
 * Splits a PGN fragment or space-separated move list into individual move tokens.
 * Strips `{comments}`, `(variations)`, `[Tag "Headers"]`, move numbers (`1.`, `6...`, `6…`),
 * NAGs (`$1`, `!?`), and game result markers (`1-0`, `0-1`, `1/2-1/2`, `*`).
 */
export function parseMovesString(input: string): string[] {
  // Strip PGN tag headers and brace comments first.
  let cleaned = input.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  // Strip nested parenthetical variations iteratively.
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  } while (cleaned !== prev);

  const tokens: string[] = [];
  for (const raw of cleaned.trim().split(/\s+/)) {
    if (!raw) continue;
    if (/^(?:1-0|0-1|1\/2-1\/2|\*)$/.test(raw)) continue;
    if (/^\$\d+$/.test(raw)) continue;
    if (/^\d+\.+$/.test(raw) || /^[.…]+$/.test(raw)) continue;
    const stripped = stripMoveNumber(raw).replace(/[!?]+$/, '');
    if (!stripped) continue;
    tokens.push(stripped);
  }
  return tokens;
}

function playMove(chess: Chess, token: string): { from: Square; to: Square } {
  const cleaned = stripMoveNumber(token).replace(/[!?]+$/, '');
  try {
    const move = chess.move(cleaned);
    return { from: move.from, to: move.to };
  } catch {
    const uci = UCI_MOVE_RE.exec(cleaned);
    if (uci) {
      const move = chess.move({
        from: uci[1].toLowerCase() as Square,
        to: uci[2].toLowerCase() as Square,
        promotion: uci[3]?.toLowerCase() as 'q' | 'r' | 'b' | 'n' | undefined,
      });
      return { from: move.from, to: move.to };
    }
    throw new Error(`Illegal move "${token}" in position ${chess.fen()}`);
  }
}

/** Splits `str` on at most `maxParts - 1` colons so trailing labels may contain `:`. */
function splitColons(str: string, maxParts: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < maxParts - 1; i++) {
    const idx = str.indexOf(':', start);
    if (idx === -1) break;
    parts.push(str.slice(start, idx));
    start = idx + 1;
  }
  parts.push(str.slice(start));
  return parts;
}

function parseColorAndStyle(
  raw: string | undefined,
  defaultColor: string,
  forArrow: boolean,
): { color: string; style: ArrowStyle } {
  if (!raw || !raw.trim()) return { color: defaultColor, style: 'solid' };
  const [colorPart, stylePart] = raw.split('/');
  const color = colorPart.trim() ? resolveColor(colorPart, forArrow) : defaultColor;
  if (!color) {
    throw new Error(
      `Unknown color "${colorPart}". Use a palette name (red, green, blue, orange, purple, yellow, cyan, ...) or #hex.`,
    );
  }
  let style: ArrowStyle = 'solid';
  if (stylePart) {
    const s = stylePart.trim().toLowerCase();
    if (s === 'dashed' || s === 'dash') style = 'dashed';
    else if (s === 'dotted' || s === 'dot') style = 'dotted';
    else if (s === 'solid') style = 'solid';
    else throw new Error(`Unknown arrow style "${stylePart}". Use solid, dashed, or dotted.`);
  }
  return { color, style };
}

function resolveMoveSquares(chess: Chess, target: string): { from: Square; to: Square } {
  const trimmed = target.trim();
  const uciMatch = UCI_ARROW_RE.exec(trimmed);
  if (uciMatch) {
    return {
      from: uciMatch[1].toLowerCase() as Square,
      to: uciMatch[2].toLowerCase() as Square,
    };
  }
  const san = stripMoveNumber(trimmed).replace(/[!?]+$/, '');
  const clone = new Chess(chess.fen());
  try {
    const move = clone.move(san);
    return { from: move.from, to: move.to };
  } catch {
    throw new Error(
      `Cannot resolve arrow "${target}" as a legal SAN move or square pair (e.g. "b1c3") in position ${chess.fen()}`,
    );
  }
}

export function resolveArrow(chess: Chess, spec: ArrowSpec, index: number): ResolvedArrow {
  const fallbackColor = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
  if (typeof spec === 'string') {
    const parts = splitColons(spec, 3);
    const target = parts[0]?.trim();
    if (!target) throw new Error(`Empty arrow specification "${spec}"`);
    const { from, to } = resolveMoveSquares(chess, target);
    const { color, style } = parseColorAndStyle(parts[1], fallbackColor, true);
    const label = parts[2]?.trim() || undefined;
    return { from, to, color, label, style };
  }

  let from: Square;
  let to: Square;
  if (spec.from && spec.to) {
    const f = spec.from.toLowerCase();
    const t = spec.to.toLowerCase();
    if (!SQUARE_RE.test(f) || !SQUARE_RE.test(t)) {
      throw new Error(`Invalid arrow squares: ${spec.from} -> ${spec.to}`);
    }
    from = f as Square;
    to = t as Square;
  } else if (spec.san) {
    ({ from, to } = resolveMoveSquares(chess, spec.san));
  } else {
    throw new Error('Arrow object must specify either { san } or { from, to }');
  }

  const parsed = parseColorAndStyle(spec.color, fallbackColor, true);
  const style: ArrowStyle =
    spec.style ?? (spec.dotted ? 'dotted' : spec.dashed ? 'dashed' : parsed.style);
  return {
    from,
    to,
    color: parsed.color,
    label: spec.label?.trim() || undefined,
    style,
  };
}

export function resolveHighlights(specs: HighlightSpec[]): ResolvedHighlight[] {
  const out: ResolvedHighlight[] = [];
  for (const [i, spec] of specs.entries()) {
    const fallback = DEFAULT_COLORS[i % DEFAULT_COLORS.length];
    if (typeof spec === 'string') {
      const parts = splitColons(spec, 3);
      const sqList = (parts[0] ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      if (!sqList.length) throw new Error(`Empty highlight specification "${spec}"`);
      const { color } = parseColorAndStyle(parts[1], fallback, false);
      const label = parts[2]?.trim() || undefined;
      for (const [j, sq] of sqList.entries()) {
        if (!SQUARE_RE.test(sq)) throw new Error(`Invalid highlight square "${sq}"`);
        out.push({ square: sq as Square, color, label: j === 0 ? label : undefined });
      }
      continue;
    }
    const squares = spec.squares ?? (spec.square ? [spec.square] : []);
    if (!squares.length) throw new Error('Highlight object must specify `square` or `squares`');
    const { color } = parseColorAndStyle(spec.color, fallback, false);
    const label = spec.label?.trim() || undefined;
    for (const [j, rawSq] of squares.entries()) {
      const sq = rawSq.trim().toLowerCase();
      if (!SQUARE_RE.test(sq)) throw new Error(`Invalid highlight square "${rawSq}"`);
      out.push({ square: sq as Square, color, label: j === 0 ? label : undefined });
    }
  }
  return out;
}

export function resolveBadge(spec: BadgeSpec): ResolvedBadge {
  if (typeof spec === 'string') {
    const parts = splitColons(spec, 3);
    const sq = parts[0]?.trim().toLowerCase();
    const glyph = parts[1]?.trim();
    if (!sq || !SQUARE_RE.test(sq) || !glyph) {
      throw new Error(`Invalid badge "${spec}". Expected "<square>:<glyph>[:<color>]"`);
    }
    const defaultColor = BADGE_DEFAULT_COLORS[glyph] ?? '#f5dc50';
    const { color } = parseColorAndStyle(parts[2], defaultColor, false);
    return { square: sq as Square, glyph, color };
  }
  const sq = spec.square.trim().toLowerCase();
  if (!SQUARE_RE.test(sq)) throw new Error(`Invalid badge square "${spec.square}"`);
  const defaultColor = BADGE_DEFAULT_COLORS[spec.glyph] ?? '#f5dc50';
  const { color } = parseColorAndStyle(spec.color, defaultColor, false);
  return { square: sq as Square, glyph: spec.glyph, color };
}

export function parseEval(raw: string | number): ResolvedEval {
  if (typeof raw === 'number') {
    const sign = raw > 0 ? '+' : '';
    const label = `${sign}${raw.toFixed(2)}`;
    const whitePct = clamp(50 + 50 * (2 / (1 + Math.exp(-0.368208 * raw)) - 1), 5, 95);
    return { label, whitePct };
  }
  const trimmed = raw.trim();
  const mateMatch = /^([+-])?[Mm](\d+)$/.exec(trimmed);
  if (mateMatch) {
    const negative = mateMatch[1] === '-';
    return {
      label: `${negative ? '-' : ''}M${mateMatch[2]}`,
      whitePct: negative ? 0 : 100,
    };
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid eval "${raw}". Use a number like "+0.86", "-1.2", or mate like "M3".`);
  }
  const label = num > 0 && !trimmed.startsWith('+') ? `+${trimmed}` : trimmed;
  const whitePct = clamp(50 + 50 * (2 / (1 + Math.exp(-0.368208 * num)) - 1), 5, 95);
  return { label, whitePct };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Validates and resolves all fields of a `BoardSpec` into render-ready structures. */
export function resolveBoard(spec: BoardSpec): ResolvedBoard {
  const chess = new Chess(spec.fen?.trim() || DEFAULT_POSITION);
  const moveTokens = Array.isArray(spec.moves)
    ? spec.moves.flatMap(parseMovesString)
    : spec.moves
      ? parseMovesString(spec.moves)
      : [];

  let lastMove: { from: Square; to: Square } | null = null;
  for (const token of moveTokens) {
    lastMove = playMove(chess, token);
  }

  if (spec.lastMove === false || spec.lastMove === null || spec.lastMove === 'none') {
    lastMove = null;
  } else if (typeof spec.lastMove === 'string' && spec.lastMove.trim()) {
    const m = UCI_ARROW_RE.exec(spec.lastMove.trim());
    if (!m) throw new Error(`Invalid --last "${spec.lastMove}". Expected squares like "e2e4".`);
    lastMove = { from: m[1].toLowerCase() as Square, to: m[2].toLowerCase() as Square };
  }

  const flipped = spec.orientation ? spec.orientation === 'black' : Boolean(spec.flip);
  const arrows = (spec.arrows ?? []).map((a, i) => resolveArrow(chess, a, i));
  const highlights = resolveHighlights(spec.highlights ?? []);
  const badges = (spec.badges ?? []).map(resolveBadge);
  const evalBar = spec.eval !== undefined && spec.eval !== '' ? parseEval(spec.eval) : null;
  const boardSize = spec.width && spec.width >= 240 ? Math.round(spec.width / 8) * 8 : 528;

  return {
    chess,
    fen: chess.fen(),
    turn: chess.turn() === 'w' ? 'white' : 'black',
    flipped,
    lastMove,
    arrows,
    highlights,
    badges,
    evalBar,
    title: spec.title?.trim() || undefined,
    subtitle: spec.subtitle?.trim() || undefined,
    showTurn:
      !spec.hideTurn && Boolean(spec.title?.trim()) && !/\bto move\b/i.test(spec.title ?? ''),
    note: spec.note?.trim() || undefined,
    boardSize,
  };
}

function squareCenter(square: Square, flipped: boolean): [number, number] {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return [(flipped ? 7 - file : file) * 100 + 50, (flipped ? rank : 7 - rank) * 100 + 50];
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function samePair(a: ResolvedArrow, b: ResolvedArrow): boolean {
  return (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
}

function arrowOverlaySvg(
  arrows: ResolvedArrow[],
  badges: ResolvedBadge[],
  flipped: boolean,
): string {
  // Compute sideways offsets for arrows that share the exact same pair of squares.
  const offsets = arrows.map((arrow, i) => {
    const group: number[] = [];
    for (let j = 0; j < arrows.length; j++) {
      if (samePair(arrow, arrows[j])) group.push(j);
    }
    if (group.length <= 1) return 0;
    const pos = group.indexOf(i);
    return (pos - (group.length - 1) / 2) * OVERLAP_OFFSET * 2;
  });

  const arrowMarkup = arrows
    .map((arrow, i) => {
      const [ax, ay] = squareCenter(arrow.from, flipped);
      const [bx, by] = squareCenter(arrow.to, flipped);
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      const shift = offsets[i];

      const startX = ax + ux * ARROW_START_INSET + px * shift;
      const startY = ay + uy * ARROW_START_INSET + py * shift;
      const tipX = bx - ux * 10 + px * shift;
      const tipY = by - uy * 10 + py * shift;
      const headLen = arrow.style === 'solid' ? 36 : 32;
      const headWidth = arrow.style === 'solid' ? 36 : 32;
      const baseX = tipX - ux * headLen;
      const baseY = tipY - uy * headLen;
      // Shorten the line slightly inside the arrowhead base so round caps don't poke past the tip.
      const lineEndX = baseX + ux * 4;
      const lineEndY = baseY + uy * 4;

      const p1x = baseX + px * (headWidth / 2);
      const p1y = baseY + py * (headWidth / 2);
      const p2x = baseX - px * (headWidth / 2);
      const p2y = baseY - py * (headWidth / 2);

      const strokeWidth = arrow.style === 'solid' ? 15 : 12;
      const dashAttr =
        arrow.style === 'dashed'
          ? ' stroke-dasharray="22 14"'
          : arrow.style === 'dotted'
            ? ' stroke-dasharray="2 20"'
            : '';

      return `<g opacity="0.92" filter="url(#arrow-shadow)">
        <line x1="${startX.toFixed(1)}" y1="${startY.toFixed(1)}" x2="${lineEndX.toFixed(1)}" y2="${lineEndY.toFixed(1)}" stroke="${arrow.color}" stroke-width="${strokeWidth}" stroke-linecap="round"${dashAttr} />
        <polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}" fill="${arrow.color}" />
      </g>`;
    })
    .join('\n');

  const badgeMarkup = badges
    .map(badge => {
      const [bx, by] = squareCenter(badge.square, flipped);
      const tx = Math.min(bx + 36, 776);
      const ty = Math.max(by - 36, 24);
      const fontSize = badge.glyph.length > 2 ? 15 : badge.glyph.length === 2 ? 19 : 22;
      return `<g transform="translate(${tx} ${ty})" filter="url(#arrow-shadow)">
        <circle r="21" fill="${badge.color}" stroke="#131110" stroke-width="3" />
        <text text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-weight="800" font-size="${fontSize}" fill="#131110">${escapeHtml(badge.glyph)}</text>
      </g>`;
    })
    .join('\n');

  return `<svg class="arrows" viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="arrow-shadow" x="-15%" y="-15%" width="130%" height="130%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000000" flood-opacity="0.42" />
      </filter>
    </defs>
    ${arrowMarkup}
    ${badgeMarkup}
  </svg>`;
}

/** Renders a complete self-contained HTML document whose `#card` element wraps the diagram. */
export function renderBoardHtml(spec: BoardSpec): {
  html: string;
  resolved: ResolvedBoard;
  viewportWidth: number;
} {
  const resolved = resolveBoard(spec);
  const { chess, flipped, lastMove, arrows, highlights, badges, evalBar, boardSize } = resolved;
  const sqSize = boardSize / 8;
  const boardMatrix = chess.board();

  const highlightMap = new Map<Square, ResolvedHighlight>();
  for (const h of highlights) highlightMap.set(h.square, h);

  let squaresHtml = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const r = flipped ? 7 - row : row;
      const f = flipped ? 7 - col : col;
      const isLight = (r + f) % 2 === 0;
      const sq = `${String.fromCharCode(97 + f)}${8 - r}` as Square;
      const bg = isLight ? LIGHT_SQUARE : DARK_SQUARE;
      const isLast = lastMove && (sq === lastMove.from || sq === lastMove.to);
      const hl = highlightMap.get(sq);
      const piece = boardMatrix[r][f];
      const pieceMarkup = piece ? getPieceSvg(piece.color, piece.type) : '';

      const rankLabel =
        col === 0
          ? `<span class="coord rank" style="color:${isLight ? '#8f7e5e' : '#f0e8d6'}">${8 - r}</span>`
          : '';
      const fileLabel =
        row === 7
          ? `<span class="coord file" style="color:${isLight ? '#8f7e5e' : '#f0e8d6'}">${String.fromCharCode(97 + f)}</span>`
          : '';
      const lastLayer = isLast ? '<div class="last"></div>' : '';
      const hlLayer = hl
        ? `<div class="hl" style="background:${hl.color}38;box-shadow:inset 0 0 0 3px ${hl.color}cc"></div>`
        : '';

      squaresHtml += `<div class="sq" style="background:${bg}">${lastLayer}${hlLayer}${rankLabel}${fileLabel}<div class="piece">${pieceMarkup}</div></div>`;
    }
  }

  const legendItems: { color: string; label: string; kind: 'arrow' | 'square' }[] = [];
  for (const a of arrows) {
    if (a.label) legendItems.push({ color: a.color, label: a.label, kind: 'arrow' });
  }
  for (const h of highlights) {
    if (h.label) legendItems.push({ color: h.color, label: h.label, kind: 'square' });
  }

  const hasHeader = Boolean(resolved.title || resolved.subtitle || legendItems.length);
  const turnBadgeHtml = resolved.showTurn
    ? `<span class="turn-pill"><span class="turn-dot ${resolved.turn}"></span>${resolved.turn === 'white' ? 'White' : 'Black'} to move</span>`
    : '';

  const headerHtml = hasHeader
    ? `<div class="header">
        ${
          resolved.title || turnBadgeHtml
            ? `<div class="title-row">${resolved.title ? `<div class="title">${escapeHtml(resolved.title)}</div>` : ''}${turnBadgeHtml}</div>`
            : ''
        }
        ${resolved.subtitle ? `<div class="subtitle">${escapeHtml(resolved.subtitle)}</div>` : ''}
        ${
          legendItems.length
            ? `<div class="legend">${legendItems
                .map(
                  item =>
                    `<span class="pill" style="--c:${item.color}"><span class="swatch ${item.kind}"></span>${escapeHtml(item.label)}</span>`,
                )
                .join('')}</div>`
            : ''
        }
      </div>`
    : '';

  const evalWidth = evalBar ? 36 : 0;
  const evalGap = evalBar ? 10 : 0;
  const evalHtml = evalBar
    ? (() => {
        const whiteOnTop = flipped;
        const fillStyle = whiteOnTop
          ? `top:0;height:${evalBar.whitePct.toFixed(1)}%`
          : `bottom:0;height:${evalBar.whitePct.toFixed(1)}%`;
        const whiteWinning = evalBar.whitePct >= 50;
        const labelAtTop = whiteOnTop ? whiteWinning : !whiteWinning;
        const labelClass = `${labelAtTop ? 'top' : 'bottom'} ${whiteWinning ? 'on-white' : 'on-black'}`;
        return `<div class="eval-bar" style="height:${boardSize}px">
          <div class="eval-white" style="${fillStyle}"></div>
          <span class="eval-label ${labelClass}">${escapeHtml(evalBar.label)}</span>
        </div>`;
      })()
    : '';

  const noteHtml = resolved.note ? `<div class="note">${escapeHtml(resolved.note)}</div>` : '';

  const pad = 16;
  const cardWidth = boardSize + evalWidth + evalGap + pad * 2;
  const coordSize = Math.max(10, Math.round(sqSize * 0.165));
  const piecePad = Math.max(2, Math.round(sqSize * 0.045));

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #171614;
    color: #f3efe6;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #card {
    width: ${cardWidth}px;
    padding: ${pad}px;
    background: #171614;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .header {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: #f6f2e9;
    line-height: 1.25;
  }
  .turn-pill {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    color: #cfc6b4;
    background: #25221d;
    border: 1px solid #3a342a;
  }
  .turn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid #6b6152;
  }
  .turn-dot.white { background: #f3efe6; }
  .turn-dot.black { background: #1c1a17; }
  .subtitle {
    font-size: 12.5px;
    color: #aba190;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c) 17%, transparent);
    color: color-mix(in srgb, var(--c) 62%, white);
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
    line-height: 1.25;
  }
  .swatch {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    background: var(--c);
  }
  .swatch.arrow { border-radius: 50%; }
  .swatch.square { border-radius: 2px; }
  .board-row {
    display: flex;
    align-items: stretch;
    gap: ${evalGap}px;
  }
  .eval-bar {
    position: relative;
    width: ${evalWidth}px;
    flex-shrink: 0;
    border-radius: 5px;
    overflow: hidden;
    background: #2b2722;
    border: 1px solid #3a342a;
  }
  .eval-white {
    position: absolute;
    left: 0;
    right: 0;
    background: #e6ddc9;
  }
  .eval-label {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 9.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    z-index: 2;
  }
  .eval-label.top { top: 4px; }
  .eval-label.bottom { bottom: 4px; }
  .eval-label.on-white { color: #26221c; }
  .eval-label.on-black { color: #e6ddc9; }
  .board-wrap {
    position: relative;
    width: ${boardSize}px;
    height: ${boardSize}px;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 0 0 1px #3a342a, 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .board {
    display: grid;
    grid-template-columns: repeat(8, ${sqSize}px);
    grid-template-rows: repeat(8, ${sqSize}px);
    width: ${boardSize}px;
    height: ${boardSize}px;
  }
  .sq { position: relative; width: ${sqSize}px; height: ${sqSize}px; overflow: hidden; }
  .last { position: absolute; inset: 0; background: rgba(214, 170, 60, 0.38); }
  .hl { position: absolute; inset: 0; z-index: 1; }
  .piece {
    position: relative;
    z-index: 2;
    width: ${sqSize}px;
    height: ${sqSize}px;
    padding: ${piecePad}px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .piece svg { width: 100%; height: 100%; display: block; }
  .coord {
    position: absolute;
    z-index: 3;
    font-size: ${coordSize}px;
    font-weight: 700;
    line-height: 1;
    user-select: none;
  }
  .coord.rank { top: 3px; left: 4px; }
  .coord.file { bottom: 3px; right: 4px; }
  svg.arrows {
    position: absolute;
    inset: 0;
    width: ${boardSize}px;
    height: ${boardSize}px;
    z-index: 4;
    pointer-events: none;
  }
  .note {
    font-size: 12.5px;
    color: #bfb5a3;
    line-height: 1.35;
  }
</style>
</head>
<body>
  <div id="card">
    ${headerHtml}
    <div class="board-row">
      ${evalHtml}
      <div class="board-wrap">
        <div class="board">${squaresHtml}</div>
        ${arrowOverlaySvg(arrows, badges, flipped)}
      </div>
    </div>
    ${noteHtml}
  </div>
</body>
</html>`;

  return { html, resolved, viewportWidth: cardWidth };
}

/** Renders a pure standalone SVG of the board (useful when `--format svg` is requested). */
export function renderBoardSvg(spec: BoardSpec): { svg: string; resolved: ResolvedBoard } {
  const resolved = resolveBoard(spec);
  const { chess, flipped, lastMove, arrows, highlights, badges, boardSize } = resolved;
  const boardMatrix = chess.board();
  const highlightMap = new Map<Square, ResolvedHighlight>();
  for (const h of highlights) highlightMap.set(h.square, h);

  const pieces: string[] = [];
  const squares: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const r = flipped ? 7 - row : row;
      const f = flipped ? 7 - col : col;
      const x = col * 100;
      const y = row * 100;
      const isLight = (r + f) % 2 === 0;
      const sq = `${String.fromCharCode(97 + f)}${8 - r}` as Square;
      squares.push(
        `<rect x="${x}" y="${y}" width="100" height="100" fill="${isLight ? LIGHT_SQUARE : DARK_SQUARE}" />`,
      );
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) {
        squares.push(
          `<rect x="${x}" y="${y}" width="100" height="100" fill="#d6aa3c" fill-opacity="0.38" />`,
        );
      }
      const hl = highlightMap.get(sq);
      if (hl) {
        squares.push(
          `<rect x="${x + 2.5}" y="${y + 2.5}" width="95" height="95" fill="${hl.color}" fill-opacity="0.22" stroke="${hl.color}" stroke-opacity="0.8" stroke-width="5" />`,
        );
      }
      if (col === 0) {
        squares.push(
          `<text x="${x + 6}" y="${y + 18}" font-family="-apple-system, system-ui, sans-serif" font-size="16" font-weight="700" fill="${isLight ? '#8f7e5e' : '#f0e8d6'}">${8 - r}</text>`,
        );
      }
      if (row === 7) {
        squares.push(
          `<text x="${x + 93}" y="${y + 93}" text-anchor="end" font-family="-apple-system, system-ui, sans-serif" font-size="16" font-weight="700" fill="${isLight ? '#8f7e5e' : '#f0e8d6'}">${String.fromCharCode(97 + f)}</text>`,
        );
      }
      const piece = boardMatrix[r][f];
      if (piece) {
        const inner = getPieceSvg(piece.color, piece.type)
          .replace(/^<svg[^>]*>/, '')
          .replace(/<\/svg>$/, '');
        pieces.push(
          `<svg x="${x + 4}" y="${y + 4}" width="92" height="92" viewBox="0 0 45 45">${inner}</svg>`,
        );
      }
    }
  }

  const overlay = arrowOverlaySvg(arrows, badges, flipped)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boardSize}" height="${boardSize}" viewBox="0 0 800 800">
    ${squares.join('\n')}
    ${pieces.join('\n')}
    ${overlay}
  </svg>`;

  return { svg, resolved };
}

export { ARROW_INSET };
