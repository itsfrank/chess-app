import { Chess } from 'chess.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Nodes } from 'mdast';
import type { Annotation } from '../src/annotations.ts';

export function annotationErrors(fen: string, text: string, arrows: Annotation[]): string[] {
  const legal = new Chess(fen).moves({ verbose: true });
  const errors: string[] = [];
  const label = (node: Nodes): string => 'value' in node ? node.value : 'children' in node ? node.children.map(n => label(n)).join('') : '';
  const walk = (node: Nodes | Root) => {
    if (node.type === 'link' && node.url.startsWith('#annotation-')) {
      const id = node.url.slice('#annotation-'.length);
      const arrow = arrows.find(a => a.id === id);
      const name = label(node).trim().replace(/^(?:\d+\s*\.+\s*|[… .]+)/, '');
      const move = legal.find(m => m.san.replace(/[+#]$/, '') === name.replace(/[+#]$/, ''));
      if (!arrow) errors.push(`Link ${label(node)} references missing arrow ${id}.`);
      else if (move && (move.from !== arrow.from || move.to !== arrow.to)) errors.push(`Link ${label(node)} uses arrow ${id} (${arrow.from}→${arrow.to}), but ${move.san} requires ${move.from}→${move.to}.`);
      else if (!move && /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/.test(name)) errors.push(`Linked move ${name} is not legal in the submitted snapshot. Use descriptive prose for a hypothetical idea instead.`);
    }
    if ('children' in node) node.children.forEach(n => walk(n));
  };
  walk(unified().use(remarkParse).parse(text));
  return errors;
}

/** At most two repair requests; never recurse or retry indefinitely. */
export async function repairAnnotations(options: {
  errors: () => string[]; repair: (feedback: string, attempt: number) => Promise<void>; cancelled: () => boolean;
}): Promise<string[]> {
  let errors = options.errors();
  for (let attempt = 1; errors.length && attempt <= 2 && !options.cancelled(); attempt++) {
    await options.repair(`Annotation validation failed:\n${errors.join('\n')}\nCorrect the arrows with set_arrows and provide a complete replacement answer, not an apology or addendum. Preserve the board snapshot. Every move link must match its arrow exactly.`, attempt);
    errors = options.errors();
  }
  return errors;
}
