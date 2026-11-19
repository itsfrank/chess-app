/**
 * Looks for ways to make a repertoire smaller or more regular without judging
 * whether they are good chess; engine evaluations are attached separately.
 *
 * Two searches share one candidate list. A merge replaces a move with one
 * that returns to positions already in the repertoire, so a subtree no longer
 * has to be learned. A consistency candidate plays the move that the same
 * arrangement of the player's own pieces is followed by elsewhere.
 */
import { Chess } from 'chess.js';
import {
  applyChange,
  decisionCount,
  isMine,
  playMove,
  reaches,
  type Graph,
  type PlanLine,
  type RepNode,
} from './repertoire.ts';

/** Positions sharing the player's own piece placement, and what is played in each. */
export type Rule = {
  signature: string;
  /** The player's pieces that have left their starting squares, e.g. "Nf3 Bg2 c4 d4 g3". */
  setup: string;
  total: number;
  /** Most played first. */
  moves: { san: string; keys: string[] }[];
};

export type Finding = {
  id: string;
  /** The position where the move would change. */
  key: string;
  current: string;
  proposed: string;
  after: { key: string; fen: string };
  /** The proposed move itself lands in a position already in the repertoire. */
  direct: boolean;
  plan: PlanLine[];
  /** Opponent replies that would need a newly prepared answer. */
  openLines: number;
  decisionsBefore: number;
  decisionsAfter: number;
  /** Set when the same setup is followed by the proposed move elsewhere. */
  peers: { count: number; currentCount: number; keys: string[] } | null;
};

const START = new Chess().board();

/** Where the player's own pieces stand, ignoring the opponent's. */
function ownPlacement(graph: Graph, node: RepNode) {
  const color = graph.side === 'white' ? 'w' : 'b';
  const all: string[] = [];
  const moved: string[] = [];
  const missing: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  new Chess(node.fen).board().forEach((rank, r) =>
    rank.forEach((piece, f) => {
      if (piece?.color !== color) return;
      const name = (piece.type === 'p' ? '' : piece.type.toUpperCase()) + piece.square;
      all.push(piece.type + piece.square);
      missing[piece.type]--;
      const home = START[r][f];
      if (home?.color !== color || home.type !== piece.type) moved.push(name);
    }),
  );
  // Pieces before pawns, as a player would describe a setup.
  moved.sort((a, b) => Number(a.length < 3) - Number(b.length < 3) || a.localeCompare(b));
  // Captured pieces tell apart setups whose remaining pieces stand alike.
  const lost = Object.entries(missing)
    .filter(([, count]) => count > 0)
    .map(
      ([type, count]) => `−${count > 1 ? count : ''}${type === 'p' ? 'pawn' : type.toUpperCase()}`,
    );
  return {
    signature: all.sort().join(' '),
    setup: [...moved, ...lost].join(' ') || 'starting setup',
  };
}

export function findRules(graph: Graph): { rules: Rule[]; ruleOf: Map<string, Rule> } {
  const bySignature = new Map<string, Rule>();
  const ruleOf = new Map<string, Rule>();
  for (const node of Object.values(graph.nodes)) {
    if (!isMine(graph, node) || !node.moves.length) continue;
    const { signature, setup } = ownPlacement(graph, node);
    let rule = bySignature.get(signature);
    if (!rule) bySignature.set(signature, (rule = { signature, setup, total: 0, moves: [] }));
    rule.total++;
    ruleOf.set(node.key, rule);
    for (const { san } of node.moves) {
      let entry = rule.moves.find(move => move.san === san);
      if (!entry) rule.moves.push((entry = { san, keys: [] }));
      entry.keys.push(node.key);
    }
  }
  const rules = [...bySignature.values()];
  for (const rule of rules) rule.moves.sort((a, b) => b.keys.length - a.keys.length);
  return {
    rules: rules
      .filter(rule => rule.moves[0].keys.length >= 2)
      .sort((a, b) => b.total - a.total || a.setup.localeCompare(b.setup)),
    ruleOf,
  };
}

const legalSans = (fen: string) => new Set(new Chess(fen).moves());

/**
 * How the opponent's known replies to the current move would be met after
 * `after` instead: by landing in a known position, by one more move that
 * reaches one, or not at all.
 */
function planLines(
  graph: Graph,
  origin: RepNode,
  afterFen: string,
  replies: string[],
  answers: string[],
): PlanLine[] {
  const legal = legalSans(afterFen);
  const known = (key: string) => !!graph.nodes[key] && !reaches(graph, key, origin.key);
  return replies
    .filter(reply => legal.has(reply))
    .map(reply => {
      const replied = playMove(afterFen, reply)!;
      if (known(replied.move.to)) return { reply, move: null, joins: replied.move.to };
      const options = legalSans(replied.fen);
      for (const san of answers) {
        if (!options.has(san)) continue;
        const to = playMove(replied.fen, san)!.move.to;
        if (known(to)) return { reply, move: san, joins: to };
      }
      return { reply, move: null, joins: null };
    });
}

export function findConsolidations(graph: Graph): { rules: Rule[]; findings: Finding[] } {
  const { rules, ruleOf } = findRules(graph);
  const decisionsBefore = decisionCount(graph);
  const findings: Finding[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (!isMine(graph, node)) continue;
    for (const current of node.moves) {
      const child = graph.nodes[current.to];
      const replies = child.moves.map(move => move.san);
      // Moves the player already uses around here: the current one first, for a plain change of order.
      const answers = [
        ...new Set([
          current.san,
          ...child.moves.flatMap(reply => graph.nodes[reply.to].moves.map(move => move.san)),
        ]),
      ];
      const rule = ruleOf.get(node.key);
      const usual = rule?.moves[0];
      const currentCount = rule?.moves.find(move => move.san === current.san)?.keys.length ?? 0;

      for (const proposed of legalSans(node.fen)) {
        if (node.moves.some(move => move.san === proposed)) continue;
        const played = playMove(node.fen, proposed)!;
        const direct = !!graph.nodes[played.move.to];
        if (direct && reaches(graph, played.move.to, node.key)) continue;
        const consistent =
          usual?.san === proposed && usual.keys.length >= 2 && usual.keys.length > currentCount;
        const plan = direct ? [] : planLines(graph, node, played.fen, replies, answers);
        if (!consistent && !direct && !plan.some(line => line.joins)) continue;

        const changed = applyChange(graph, {
          key: node.key,
          from: current.san,
          to: proposed,
          plan,
        });
        if (!changed) continue;
        const decisionsAfter = decisionCount(changed);
        if (!consistent && decisionsAfter >= decisionsBefore) continue;
        findings.push({
          id: `${node.key}|${current.san}|${proposed}`,
          key: node.key,
          current: current.san,
          proposed,
          after: { key: played.move.to, fen: played.fen },
          direct,
          plan,
          openLines: plan.filter(line => !line.joins).length,
          decisionsBefore,
          decisionsAfter,
          peers: consistent ? { count: usual.keys.length, currentCount, keys: usual.keys } : null,
        });
      }
    }
  }
  findings.sort(
    (a, b) =>
      a.decisionsAfter - b.decisionsAfter || a.openLines - b.openLines || (a.id < b.id ? -1 : 1),
  );
  return { rules, findings };
}
