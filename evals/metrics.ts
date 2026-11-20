/**
 * Signals about an answer that cost nothing to compute. They track the ways
 * answers about ideas were found to go wrong: quoting engine scores in place
 * of reasons, leading with a number, never touching the squares and pieces
 * the idea is about, and contradicting the question's premise.
 */

/** Engine scores as answers write them: "+0.9", "−1.38", "about 0.5 pawns", "depth 18". */
const SCORE = /[+−-]\d+\.\d+|\b\d+\.\d+ pawns?\b|\bdepth \d+\b|\bcentipawns?\b/gi;
const ANY_SCORE = new RegExp(SCORE.source, 'i');
const SQUARE = /\b[a-h][1-8]\b/g;
const CONTRADICTION =
  /\bactually\b|is (?:the engine[’']s |stockfish[’']s )?(?:top|best|first) (?:choice|move)|is(?:n[’']t| not) (?:a mistake|inferior|worse)|no reason to call/i;

export type Metrics = {
  words: number;
  /** Engine scores, depths and the like quoted in the answer. */
  scores: number;
  /** Whether a score appears before any reasoning, in the opening sentence. */
  leadsWithScore: boolean;
  /** Share of the squares named in the reference points that the answer mentions; null if none are. */
  squares: number | null;
  /** Whether a "why is X not best" answer disputes that X is not best. */
  contradicts: boolean;
};

/** Markdown links and emphasis removed, so that only what the reader sees is measured. */
export const plain = (text: string) => text.replace(/\]\(#[^)]*\)/g, '').replace(/[[\]*_`|]/g, '');

export function measure(answer: string, rubric: string[], disputable: boolean): Metrics {
  const text = plain(answer);
  const firstSentence = text.split(/(?<=[.!?:])\s/)[0] ?? '';
  const wanted = new Set(rubric.join(' ').match(SQUARE) ?? []);
  const found = new Set(text.match(SQUARE) ?? []);
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    scores: text.match(SCORE)?.length ?? 0,
    leadsWithScore: ANY_SCORE.test(firstSentence),
    squares: wanted.size
      ? [...wanted].filter(square => found.has(square)).length / wanted.size
      : null,
    contradicts: disputable && CONTRADICTION.test(text.slice(0, 400)),
  };
}

/** The metrics of several answers as one row: averages, and counts of the yes/no ones. */
export function summarizeMetrics(all: Metrics[]) {
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const shares = all.flatMap(metrics => (metrics.squares === null ? [] : metrics.squares));
  return {
    words: Math.round(mean(all.map(metrics => metrics.words))),
    'scores quoted': Number(mean(all.map(metrics => metrics.scores)).toFixed(1)),
    'lead with a score': all.filter(metrics => metrics.leadsWithScore).length,
    'reference squares': `${Math.round(100 * mean(shares))}%`,
    'dispute the premise': all.filter(metrics => metrics.contradicts).length,
  };
}
