import { Chess } from 'chess.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Nodes } from 'mdast';
import type { Annotation } from '../shared/protocol.ts';
import { ANNOTATION_PREFIX, nodeText, sanKey, stripMoveNumber } from '../shared/san.ts';

const MAX_REPAIRS = 2;

/**
 * Finds annotation links the reader would be misled by: a link to an arrow
 * that was never drawn, or a link labelled with a legal move that points at an
 * arrow between different squares. Links with descriptive labels are fine, and
 * the client quietly unlinks move labels that are not legal in the position.
 */
export function annotationErrors(fen: string, text: string, arrows: Annotation[]): string[] {
  const legal = new Chess(fen).moves({ verbose: true });
  const errors: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === 'link' && node.url.startsWith(ANNOTATION_PREFIX)) {
      const id = node.url.slice(ANNOTATION_PREFIX.length);
      const label = nodeText(node);
      const arrow = arrows.find(a => a.id === id);
      const name = sanKey(stripMoveNumber(label));
      const move = legal.find(m => sanKey(m.san) === name);
      if (!arrow) {
        errors.push(`Link ${label} references missing arrow ${id}.`);
      } else if (move && (move.from !== arrow.from || move.to !== arrow.to)) {
        errors.push(
          `Link ${label} uses arrow ${id} (${arrow.from}→${arrow.to}), but ${move.san} requires ${move.from}→${move.to}.`,
        );
      }
    }
    if ('children' in node) node.children.forEach(walk);
  };
  walk(unified().use(remarkParse).parse(text));
  return errors;
}

/** Asks the model to fix its annotations, at most twice, and returns whatever errors remain. */
export async function repairAnnotations(options: {
  errors: () => string[];
  repair: (feedback: string, attempt: number) => Promise<void>;
  cancelled: () => boolean;
}): Promise<string[]> {
  let errors = options.errors();
  for (
    let attempt = 1;
    errors.length && attempt <= MAX_REPAIRS && !options.cancelled();
    attempt++
  ) {
    await options.repair(
      `Annotation validation failed:\n${errors.join('\n')}\nCorrect the arrows with set_arrows and provide a complete replacement answer, not an apology or addendum. Preserve the board snapshot. Every move link must match its arrow exactly.`,
      attempt,
    );
    errors = options.errors();
  }
  return errors;
}
