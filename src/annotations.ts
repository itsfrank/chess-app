import { Chess } from 'chess.js';
import type { Link, PhrasingContent, Root, RootContent } from 'mdast';
import type { Annotation } from '../shared/protocol';
import {
  ANNOTATION_PREFIX,
  encodeVariation,
  looksLikeSan,
  nodeText,
  sanInText,
  sanKey,
  stripMoveNumber,
} from '../shared/san';

/**
 * Maps each legal move's SAN to the arrow drawn along it. Moves with no arrow,
 * or with several, are left out: only unambiguous links are inferred.
 */
export function annotationMoves(fen: string, arrows: Annotation[]): Map<string, string> {
  const result = new Map<string, string>();
  let legal;
  try {
    legal = new Chess(fen).moves({ verbose: true });
  } catch {
    return result; // Unparseable position: links with descriptive labels still work.
  }
  for (const move of legal) {
    const matches = arrows.filter(arrow => arrow.from === move.from && arrow.to === move.to);
    if (matches.length === 1) result.set(sanKey(move.san), matches[0].id);
  }
  return result;
}

/** Returns the SAN of the legal move matching `arrow` in `fen`, or null if none (or promotion-ambiguous). */
export function legalMoveForArrow(fen: string, arrow: Annotation): string | null {
  try {
    const matches = new Chess(fen)
      .moves({ verbose: true })
      .filter(move => move.from === arrow.from && move.to === arrow.to);
    if (matches.length === 1) return matches[0].san;
    // Prefer queen promotion if an arrow points from the 7th/2nd rank to the promotion rank.
    return matches.find(move => move.promotion === 'q')?.san ?? null;
  } catch {
    return null;
  }
}

const SKIPPED = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);
const PHRASING_CONTAINERS = new Set(['strong', 'emphasis', 'delete']);
const BARE_SQUARE = /^[a-h][1-8]$/;
/** Text that may sit between consecutive moves of a single variation. */
const MOVE_GAP = /^[!?]{0,2}\s+(?:(?:\d+\s*(?:\.{1,3}|…)|…)\s*)?$/;
/** Preceding move number or ellipsis that disambiguates a bare pawn push like "12. e4" or "…d5". */
const MOVE_NUMBER_BEFORE = /(?:^|[\s(])(?:\d+\s*(?:\.{1,3}|…)|…)\s*$/;

const annotationLink = (id: string, children: PhrasingContent[]): Link => ({
  type: 'link',
  url: ANNOTATION_PREFIX + id,
  children,
});

/** Splits text into plain runs and links for every move that has an arrow (arrow-only mode). */
function linkMoves(text: string, moves: Map<string, string>): PhrasingContent[] | null {
  const parts: PhrasingContent[] = [];
  let offset = 0;
  for (const match of text.matchAll(sanInText())) {
    const id = moves.get(sanKey(match[0]));
    if (!id) continue;
    if (match.index > offset) parts.push({ type: 'text', value: text.slice(offset, match.index) });
    parts.push(annotationLink(id, [{ type: 'text', value: match[0] }]));
    offset = match.index + match[0].length;
  }
  if (!parts.length) return null;
  if (offset < text.length) parts.push({ type: 'text', value: text.slice(offset) });
  return parts;
}

type ParentNode = { children: RootContent[] };

type ChainEntry = {
  container: RootContent[];
  node: Link;
  fallback: PhrasingContent[];
  step: number;
  arrowId: string | null;
  explicit: boolean;
};

type BlockState = {
  board: Chess | null;
  moves: string[];
  entries: ChainEntry[];
  /** Text seen since the last matched move (or recent preceding text when no chain is active). */
  tail: string;
};

function tryMove(board: Chess, san: string): string | null {
  try {
    return board.move(san).san;
  } catch {
    return null;
  }
}

function flushChain(state: BlockState) {
  if (!state.entries.length) return;
  const { moves, entries } = state;
  const multi = moves.length >= 2;
  for (const entry of entries) {
    if (multi) {
      entry.node.url = entry.arrowId
        ? `${ANNOTATION_PREFIX}${entry.arrowId}?v=${entry.step}/${moves.map(encodeURIComponent).join(',')}`
        : encodeVariation(moves, entry.step);
    } else if (entry.arrowId) {
      entry.node.url = ANNOTATION_PREFIX + entry.arrowId;
    } else if (entry.explicit) {
      entry.node.url = encodeVariation(moves, 1);
    } else {
      const idx = entry.container.indexOf(entry.node);
      if (idx >= 0) entry.container.splice(idx, 1, ...entry.fallback);
    }
  }
  state.board = null;
  state.moves = [];
  state.entries = [];
}

function isExplicitSingleMove(token: string, preceding: string): boolean {
  return !BARE_SQUARE.test(token) || MOVE_NUMBER_BEFORE.test(preceding);
}

/**
 * Remark plugin that makes move references in a message agree with its arrows:
 * plain SAN text is linked to the matching arrow, and model-written links whose
 * label is a move are re-pointed at that move's arrow or unlinked if it has none.
 * Model output is never trusted to pair a move with the right arrow.
 *
 * When `variations` is true, legal moves and multi-move continuations starting
 * from `fen` are also linked so clicking them plays the variation on the board.
 */
export function remarkMoveLinks(options: {
  fen: string;
  arrows: Annotation[];
  variations?: boolean;
}) {
  const moves = annotationMoves(options.fen, options.arrows);
  let validFen = false;
  if (options.variations) {
    try {
      new Chess(options.fen);
      validFen = true;
    } catch {
      validFen = false;
    }
  }

  if (!validFen) {
    const walk = (node: Root | RootContent) => {
      if (SKIPPED.has(node.type) || !('children' in node)) return;
      const children = node.children as RootContent[];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        let replacement: RootContent[] | null = null;
        if (child.type === 'link' && child.url.startsWith(ANNOTATION_PREFIX)) {
          const label = stripMoveNumber(nodeText(child));
          if (!looksLikeSan(label)) continue;
          const id = moves.get(sanKey(label));
          replacement = id ? [annotationLink(id, child.children)] : child.children;
        } else if (child.type === 'text') {
          replacement = linkMoves(child.value, moves);
        } else {
          walk(child);
        }
        if (replacement) {
          children.splice(i, 1, ...replacement);
          i += replacement.length - 1;
        }
      }
    };
    return (tree: Root) => walk(tree);
  }

  const attemptAdvance = (
    state: BlockState,
    san: string,
  ): { played: string; fresh: boolean } | null => {
    if (state.board && MOVE_GAP.test(state.tail)) {
      const played = tryMove(state.board, san);
      if (played) return { played, fresh: false };
    }
    const freshBoard = new Chess(options.fen);
    const played = tryMove(freshBoard, san);
    if (!played) return null;
    flushChain(state);
    state.board = freshBoard;
    return { played, fresh: true };
  };

  const walkWithVariations = (node: Root | RootContent, inherited?: BlockState) => {
    if (!('children' in node)) return;
    const parent = node as ParentNode;
    const ownBlock = !inherited || !PHRASING_CONTAINERS.has(node.type);
    const state: BlockState = ownBlock
      ? { board: null, moves: [], entries: [], tail: '' }
      : inherited;
    const children = parent.children;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child.type === 'link' && child.url.startsWith(ANNOTATION_PREFIX)) {
        const rawText = nodeText(child);
        const label = stripMoveNumber(rawText);
        if (!looksLikeSan(label)) {
          flushChain(state);
          state.tail = '';
          continue;
        }
        const arrowId = moves.get(sanKey(label)) ?? null;
        const preceding = state.tail + rawText.slice(0, rawText.length - label.length);
        const advanced = attemptAdvance(state, label);
        if (advanced) {
          const link = annotationLink(arrowId ?? 'pending', child.children);
          const effectiveArrow = advanced.fresh ? arrowId : null;
          state.moves.push(advanced.played);
          state.entries.push({
            container: children,
            node: link,
            fallback: child.children,
            step: state.moves.length,
            arrowId: effectiveArrow,
            explicit: isExplicitSingleMove(label, preceding),
          });
          children.splice(i, 1, link);
          state.tail = '';
        } else {
          flushChain(state);
          state.tail = '';
          const replacement: RootContent[] = arrowId
            ? [annotationLink(arrowId, child.children)]
            : child.children;
          children.splice(i, 1, ...replacement);
          i += replacement.length - 1;
        }
      } else if (child.type === 'text') {
        const text = child.value;
        const parts: RootContent[] = [];
        let offset = 0;
        let changed = false;

        for (const match of text.matchAll(sanInText())) {
          const between = text.slice(offset, match.index);
          state.tail += between;
          const token = match[0];
          const advanced = attemptAdvance(state, token);
          const arrowId = advanced?.fresh ? (moves.get(sanKey(token)) ?? null) : null;

          if (advanced) {
            if (between) parts.push({ type: 'text', value: between });
            const fallback: PhrasingContent[] = [{ type: 'text', value: token }];
            const link = annotationLink(arrowId ?? 'pending', fallback);
            state.moves.push(advanced.played);
            state.entries.push({
              container: parts,
              node: link,
              fallback,
              step: state.moves.length,
              arrowId,
              explicit: isExplicitSingleMove(token, state.tail),
            });
            parts.push(link);
            offset = match.index + token.length;
            state.tail = '';
            changed = true;
          } else {
            // Token is not legal here, so any active chain stops before it.
            flushChain(state);
            const fallbackArrow = moves.get(sanKey(token));
            if (fallbackArrow) {
              if (between) parts.push({ type: 'text', value: between });
              parts.push(annotationLink(fallbackArrow, [{ type: 'text', value: token }]));
              offset = match.index + token.length;
              state.tail = '';
              changed = true;
            } else {
              state.tail += token;
            }
          }
        }

        if (changed) {
          const rest = text.slice(offset);
          if (rest) {
            parts.push({ type: 'text', value: rest });
            state.tail += rest;
          }
          children.splice(i, 1, ...parts);
          for (const entry of state.entries) {
            if (entry.container === parts) entry.container = children;
          }
          i += parts.length - 1;
        } else {
          state.tail += text.slice(offset);
        }
      } else if (PHRASING_CONTAINERS.has(child.type)) {
        walkWithVariations(child, state);
      } else if (SKIPPED.has(child.type)) {
        flushChain(state);
        state.tail = '';
      } else {
        flushChain(state);
        state.tail = '';
        walkWithVariations(child);
      }
    }

    if (ownBlock) flushChain(state);
  };

  return (tree: Root) => walkWithVariations(tree);
}
