/** Recognising chess moves written in prose, shared by link rendering and validation. */

export const ANNOTATION_PREFIX = '#annotation-';
export const VARIATION_PREFIX = '#variation-';

export type VariationLink = { moves: string[]; step: number };

/** Encodes a legal SAN variation and 1-based target step into an internal link href. */
export function encodeVariation(moves: readonly string[], step: number): string {
  return `${VARIATION_PREFIX}${step}/${moves.map(encodeURIComponent).join(',')}`;
}

/** Decodes a `#variation-STEP/SAN1,SAN2,...` href back into its moves and 1-based step. */
export function decodeVariation(href: string): VariationLink | null {
  if (!href.startsWith(VARIATION_PREFIX)) return null;
  const rest = href.slice(VARIATION_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const step = Number(rest.slice(0, slash));
  const raw = rest.slice(slash + 1);
  if (!Number.isInteger(step) || step < 1 || !raw) return null;
  try {
    const moves = raw.split(',').map(decodeURIComponent).filter(Boolean);
    if (!moves.length || step > moves.length) return null;
    return { moves, step };
  } catch {
    return null;
  }
}

/** Parses an `#annotation-ID` (or shortened `#ID`) href, plus an optional attached `?v=` variation. */
export function parseAnnotationHref(
  href: string | undefined,
): { id: string; variation: VariationLink | null } | null {
  if (!href) return null;
  const body = href.startsWith(ANNOTATION_PREFIX)
    ? href.slice(ANNOTATION_PREFIX.length)
    : href.startsWith('#') && !href.startsWith(VARIATION_PREFIX)
      ? href.slice(1)
      : null;
  if (!body) return null;
  const query = body.indexOf('?v=');
  if (query < 0) return { id: body, variation: null };
  return {
    id: body.slice(0, query),
    variation: decodeVariation(VARIATION_PREFIX + body.slice(query + 3)),
  };
}

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
