import { Chess, type Square } from 'chess.js';
import type { Root, RootContent, PhrasingContent } from 'mdast';
export type Annotation = { id: string; from: Square; to: Square; color: string };

/** Only infer links for unambiguous legal SAN in the message's own position. */
export function annotationMoves(fen: string, arrows: Annotation[]) {
  const result = new Map<string, string>();
  try {
    const legal = new Chess(fen).moves({ verbose: true });
    for (const move of legal) {
      const matches = arrows.filter(a => a.from === move.from && a.to === move.to);
      if (matches.length !== 1) continue;
      result.set(move.san.replace(/[+#]$/, ''), matches[0].id);
    }
  } catch { /* Invalid/legacy position: explicit links still work. */ }
  return result;
}
export function remarkMoveLinks(options: { fen: string; arrows: Annotation[] }) {
  const moves = annotationMoves(options.fen, options.arrows);
  return (tree: Root) => {
    const walk = (node: Root | RootContent | PhrasingContent) => {
      if (['link', 'linkReference', 'code', 'inlineCode', 'html'].includes(node.type)) return;
      if (!('children' in node)) return;
      const children = node.children as (RootContent | PhrasingContent)[];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type !== 'text') { walk(child); continue; }
        const parts: PhrasingContent[] = []; let offset = 0;
        // Number/dot prefixes remain ordinary text: 3...Nf6, …Nf6, Nf6+ all match.
        for (const match of child.value.matchAll(/(?<![A-Za-z0-9_])(?:O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?(?![A-Za-z0-9_])/g)) {
          const id = moves.get(match[0].replace(/[+#]$/, ''));
          if (!id) continue;
          if (match.index > offset) parts.push({ type: 'text', value: child.value.slice(offset, match.index) });
          parts.push({ type: 'link', url: `#annotation-${id}`, children: [{ type: 'text', value: match[0] }] });
          offset = match.index + match[0].length;
        }
        if (!parts.length) continue;
        if (offset < child.value.length) parts.push({ type: 'text', value: child.value.slice(offset) });
        children.splice(i, 1, ...parts); i += parts.length - 1;
      }
    };
    walk(tree);
  };
}
