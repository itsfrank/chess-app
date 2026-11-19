/**
 * An opening repertoire as a graph of positions. A PGN export repeats the same
 * subtree under every move order that reaches it; keying nodes by position
 * folds those copies together, so each position is learned once.
 */
import { Chess } from 'chess.js';
import type { PlayerColor } from './protocol.ts';

export type RepMove = { san: string; uci: string; to: string };
export type RepNode = {
  key: string;
  fen: string;
  /** A shortest sequence of SAN moves from the starting position. */
  path: string[];
  moves: RepMove[];
};
export type Graph = { side: PlayerColor; root: string; nodes: Record<string, RepNode> };

/** One reply the opponent can make after a proposed move, and how the line continues. */
export type PlanLine = {
  reply: string;
  /** The move that returns to a known position; null when the reply lands in one, or none does. */
  move: string | null;
  /** The known position the line rejoins; null when a new line would have to be prepared. */
  joins: string | null;
};
/** An accepted deviation from the imported PGN: at `key`, play `to` instead of `from`. */
export type Change = {
  id: string;
  key: string;
  from: string;
  to: string;
  plan: PlanLine[];
  acceptedAt: string;
};

/** Identity of a position: placement, side to move, castling rights and en-passant square. */
export const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
export const turnOf = (key: string): PlayerColor => (key.split(' ')[1] === 'w' ? 'white' : 'black');

/** The position after `san`, or null if the move is not legal in `fen`. */
export function playMove(fen: string, san: string): { fen: string; move: RepMove } | null {
  try {
    const board = new Chess(fen);
    const move = board.move(san);
    const next = board.fen();
    return { fen: next, move: { san: move.san, uci: move.lan, to: positionKey(next) } };
  } catch {
    return null;
  }
}

const RESULTS = new Set(['*', '1-0', '0-1', '1/2-1/2']);

/** Moves and variation brackets of a PGN, without headers, comments, NAGs or move numbers. */
function tokens(pgn: string): string[] {
  const body = pgn
    .replace(/^\s*\[.*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;.*$/gm, ' ')
    .replace(/\$\d+/g, ' ');
  return (body.match(/\(|\)|[^\s()]+/g) ?? [])
    .map(token => token.replace(/^\d+\.+/, '').replace(/[!?]+$/, ''))
    .filter(Boolean);
}

/**
 * Builds the position graph of a PGN with variations. `side` is the colour
 * the repertoire is for; when omitted it is the colour that never has a choice
 * of moves.
 */
export function buildGraph(pgn: string, side?: PlayerColor): Graph {
  const start = new Chess().fen();
  const nodes: Record<string, RepNode> = {};
  const nodeAt = (fen: string) =>
    (nodes[positionKey(fen)] ??= { key: positionKey(fen), fen, path: [], moves: [] });
  nodeAt(start);

  /** Position before and after the last move at each open variation depth. */
  const stack: { before: string; current: string }[] = [];
  let before = start;
  let current = start;
  for (const token of tokens(pgn)) {
    if (token === '(') {
      stack.push({ before, current });
      current = before;
    } else if (token === ')') {
      const outer = stack.pop();
      if (!outer) throw new Error('Unbalanced variation in PGN');
      ({ before, current } = outer);
    } else if (RESULTS.has(token)) {
      before = current = start;
    } else {
      const played = playMove(current, token);
      if (!played) throw new Error(`Illegal move ${token} in PGN`);
      const from = nodeAt(current);
      nodeAt(played.fen);
      if (!from.moves.some(move => move.san === played.move.san)) from.moves.push(played.move);
      before = current;
      current = played.fen;
    }
  }
  if (stack.length) throw new Error('Unbalanced variation in PGN');
  if (Object.keys(nodes).length === 1) throw new Error('The PGN contains no moves');

  const branches = (color: PlayerColor) =>
    Object.values(nodes).some(node => turnOf(node.key) === color && node.moves.length > 1);
  const inferred = side ?? (branches('white') && !branches('black') ? 'black' : 'white');
  return relabel({ side: inferred, root: positionKey(start), nodes });
}

/** Drops positions that can no longer be reached and gives the rest a shortest path. */
export function relabel(graph: Graph): Graph {
  const nodes: Record<string, RepNode> = {};
  const root = graph.nodes[graph.root];
  nodes[root.key] = { ...root, path: [] };
  const queue = [root.key];
  for (let index = 0; index < queue.length; index++) {
    const node = nodes[queue[index]];
    for (const move of node.moves) {
      const child = graph.nodes[move.to];
      if (!child || nodes[child.key]) continue;
      nodes[child.key] = { ...child, path: [...node.path, move.san] };
      queue.push(child.key);
    }
  }
  return { ...graph, nodes };
}

export const isMine = (graph: Graph, node: RepNode) => turnOf(node.key) === graph.side;

/**
 * Positions the player has to know a move in, including ones where a line
 * stops with the player to move and an answer is still owed.
 */
export function decisionCount(graph: Graph): number {
  return Object.values(graph.nodes).filter(node => isMine(graph, node)).length;
}

/** Whether `to` can be reached from `from` by following repertoire moves. */
export function reaches(graph: Graph, from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    if (queue[index] === to) return true;
    for (const move of graph.nodes[queue[index]]?.moves ?? []) {
      if (!seen.has(move.to)) {
        seen.add(move.to);
        queue.push(move.to);
      }
    }
  }
  return false;
}

/**
 * The graph with one change applied, or null when the change no longer fits:
 * its position is gone, or it does not play `from` there any more.
 */
export function applyChange(
  graph: Graph,
  change: Pick<Change, 'key' | 'from' | 'to' | 'plan'>,
): Graph | null {
  const node = graph.nodes[change.key];
  if (!node || !node.moves.some(move => move.san === change.from)) return null;
  const played = playMove(node.fen, change.to);
  if (!played) return null;

  const nodes = { ...graph.nodes };
  nodes[node.key] = {
    ...node,
    moves: [...node.moves.filter(move => move.san !== change.from), played.move],
  };
  let after = nodes[played.move.to] ?? {
    key: played.move.to,
    fen: played.fen,
    path: [],
    moves: [],
  };
  for (const line of change.plan) {
    const reply = playMove(after.fen, line.reply);
    if (!reply) continue;
    if (!after.moves.some(move => move.san === reply.move.san)) {
      after = { ...after, moves: [...after.moves, reply.move] };
    }
    let answer = nodes[reply.move.to] ?? {
      key: reply.move.to,
      fen: reply.fen,
      path: [],
      moves: [],
    };
    const rejoin = line.move ? playMove(reply.fen, line.move) : null;
    if (rejoin && nodes[rejoin.move.to] && !answer.moves.some(m => m.san === rejoin.move.san)) {
      answer = { ...answer, moves: [...answer.moves, rejoin.move] };
    }
    nodes[answer.key] = answer;
  }
  nodes[after.key] = after;
  return relabel({ ...graph, nodes });
}

/** Applies accepted changes in order; ones that no longer fit are reported as `skipped`. */
export function applyChanges(graph: Graph, changes: Change[]): { graph: Graph; skipped: string[] } {
  const skipped: string[] = [];
  for (const change of changes) {
    const next = applyChange(graph, change);
    if (next) graph = next;
    else skipped.push(change.id);
  }
  return { graph, skipped };
}

/** A path as numbered notation: "1. d4 d5 2. c4". */
export function formatPath(path: readonly string[]): string {
  return path.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(' ');
}
