/**
 * Colours the companion may draw arrows in. The names are part of the
 * set_arrows tool schema, so keep existing ones stable. An arrow's identity
 * comes from its ID, never from its colour.
 */
export const annotationPalette = {
  blue: '#60a5fa',
  purple: '#c084fc',
  green: '#4ade80',
  orange: '#fb923c',
  red: '#ff5266',
  yellow: '#f5dc50',
  cyan: '#24d4e8',
  pink: '#f472ce',
  lime: '#b8e34b',
  teal: '#23b99b',
  indigo: '#8287ff',
  ivory: '#fff0d4',
} as const;
export const annotationColorNames = Object.keys(
  annotationPalette,
) as (keyof typeof annotationPalette)[];
export const maxAnnotations = 16;
