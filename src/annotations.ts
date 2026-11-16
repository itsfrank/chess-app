import { Chess } from 'chess.js';
import type { Link, PhrasingContent, Root, RootContent } from 'mdast';
import type { Annotation } from '../shared/protocol';
import {
  ANNOTATION_PREFIX,
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

const SKIPPED = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);
const annotationLink = (id: string, children: PhrasingContent[]): Link => ({
  type: 'link',
  url: ANNOTATION_PREFIX + id,
  children,
});

/** Splits text into plain runs and links for every move that has an arrow. */
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

/**
 * Remark plugin that makes move references in a message agree with its arrows:
 * plain SAN text is linked to the matching arrow, and model-written links whose
 * label is a move are re-pointed at that move's arrow or unlinked if it has none.
 * Model output is never trusted to pair a move with the right arrow.
 */
export function remarkMoveLinks(options: { fen: string; arrows: Annotation[] }) {
  const moves = annotationMoves(options.fen, options.arrows);
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
