/** Turns stored engine verdicts into judgements about repertoire moves and proposed changes. */
import type { Finding } from './consolidation.ts';
import type { Evaluation, PlayerColor, PositionEval } from './protocol.ts';
import { isMine, type Graph } from './repertoire.ts';

const MATE_SCORE = 10_000;
const DECISIVE = 150;
type Evals = Record<string, PositionEval>;

/** An evaluation as centipawns for `side`; mates are large and shrink with distance. */
export function scoreFor(side: PlayerColor, evaluation: Evaluation): number {
  const white =
    evaluation.type === 'cp'
      ? evaluation.value
      : (evaluation.value > 0 || evaluation.winner === 'white' ? 1 : -1) *
        (MATE_SCORE - Math.abs(evaluation.value));
  return side === 'white' ? white : -white;
}

export type Verdict = {
  /** The player's score after the current move and after the proposal, in centipawns. */
  current: number;
  proposed: number;
  /** Negative when the proposal is worse than the current move. */
  delta: number;
};

/**
 * Compares a proposal with the move it replaces. The proposal is scored by its
 * worst point: the position after it, or any known position its plan rejoins.
 * Null until every position involved has been searched.
 */
export function verdictOf(graph: Graph, evals: Evals, finding: Finding): Verdict | null {
  const child = graph.nodes[finding.key]?.moves.find(move => move.san === finding.current);
  const keys = [finding.after.key, ...finding.plan.flatMap(line => line.joins ?? [])];
  if (!child || !evals[child.to] || keys.some(key => !evals[key])) return null;
  const current = scoreFor(graph.side, evals[child.to].evaluation);
  const proposed = Math.min(...keys.map(key => scoreFor(graph.side, evals[key].evaluation)));
  return { current, proposed, delta: proposed - current };
}

export type Audit = {
  key: string;
  san: string;
  /** The engine's preferred move in the position. */
  best: string | null;
  /** Centipawns given up against the engine's choice. */
  loss: number;
  /** The player's score after the repertoire move. */
  score: number;
};

/**
 * Repertoire moves that give up at least `threshold` centipawns and do not
 * leave the player clearly winning anyway, worst first.
 */
export function auditMoves(graph: Graph, evals: Evals, threshold: number): Audit[] {
  const audits: Audit[] = [];
  for (const node of Object.values(graph.nodes)) {
    const before = evals[node.key];
    if (!isMine(graph, node) || !before) continue;
    for (const move of node.moves) {
      const after = evals[move.to];
      if (!after || before.best === move.san) continue;
      const score = scoreFor(graph.side, after.evaluation);
      const loss = scoreFor(graph.side, before.evaluation) - score;
      // A move that keeps a decisive advantage is not a problem, however much more there was.
      if (loss >= threshold && score < DECISIVE)
        audits.push({ key: node.key, san: move.san, best: before.best, loss, score });
    }
  }
  return audits.sort((a, b) => b.loss - a.loss);
}

/**
 * How often each position arises per game. The player's moves are certain;
 * the opponent's follow `frequencies` (position key → SAN → share of games),
 * or are split evenly where no data has been fetched yet.
 */
export function reachProbabilities(
  graph: Graph,
  frequencies: Record<string, Record<string, number> | undefined>,
): Record<string, number> {
  const pending: Record<string, number> = {};
  for (const node of Object.values(graph.nodes)) {
    for (const move of node.moves) pending[move.to] = (pending[move.to] ?? 0) + 1;
  }
  const reach: Record<string, number> = { [graph.root]: 1 };
  const queue = [graph.root];
  for (let index = 0; index < queue.length; index++) {
    const node = graph.nodes[queue[index]];
    const known = frequencies[node.key];
    for (const move of node.moves) {
      const share = isMine(graph, node)
        ? 1 / node.moves.length
        : known
          ? (known[move.san] ?? 0)
          : 1 / node.moves.length;
      reach[move.to] = (reach[move.to] ?? 0) + (reach[node.key] ?? 0) * share;
      // Positions on a repetition never run out of pending parents and keep what they have.
      if (--pending[move.to] === 0) queue.push(move.to);
    }
  }
  return reach;
}
