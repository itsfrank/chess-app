/** Recognising chess moves written in prose, shared by link rendering and validation. */

export const ANNOTATION_PREFIX = '#annotation-';

const SAN = String.raw`(?:O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?`;
const WHOLE_SAN = new RegExp(`^${SAN}$`);

/** SAN tokens inside running text. Number/dot prefixes (3...Nf6, …Nf6) stay outside the match. */
export const sanInText = () => new RegExp(`(?<![A-Za-z0-9_])${SAN}(?![A-Za-z0-9_])`, 'g');

/** Check and mate suffixes do not change which move is meant. */
export const sanKey = (san: string) => san.replace(/[+#]$/, '');

/** Drops a leading move number or ellipsis: "1...Nf6" and "…Nf6" both become "Nf6". */
export const stripMoveNumber = (label: string) =>
  label.trim().replace(/^(?:\d+\s*\.+\s*|[… .]+)/, '');

export const looksLikeSan = (text: string) => WHOLE_SAN.test(text);

/** Concatenated text of a Markdown node and its descendants. */
export function nodeText(node: object): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children))
    return node.children.map(nodeText).join('');
  return '';
}
