/**
 * Looks for ways to make a repertoire smaller or more regular without judging
 * whether they are good chess; engine evaluations are attached separately.
 *
 * Rules are detected at two levels: setup rules group positions by where the
 * player's own pieces stand, while opponent-aware rules capture recurring
 * reactions to the opponent's patterns (2×2 pawn tension squares, unopposed
 * flank pawn challenges, early queenside bishop sorties leaving b7/b2
 * undefended, bishop pins on knights) and last moves.
 *
 * Two searches share one candidate list. A merge replaces a move with one
 * that returns to positions already in the repertoire, so a subtree no longer
 * has to be learned. A consistency candidate plays the move that peers sharing
 * the same setup or opponent trigger play elsewhere — while moves already
 * explained by a consistent opponent rule are not flagged as setup deviations.
 */
import { Chess, type Square } from 'chess.js';
import type { PlayerColor } from './protocol.ts';
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

export type RuleKind = 'setup' | 'pattern' | 'trigger';

export type ExplainedException = {
  /** Signature of the opponent-aware rule that explains the move played here. */
  signature: string;
  /** Short label of that rule, e.g. "c4, d4 vs c5, d5 pawn square". */
  label: string;
};

/** Positions sharing a setup, board pattern, or opponent move trigger, and what is played in each. */
export type Rule = {
  signature: string;
  kind: RuleKind;
  /** Short title: moved own pieces for setup rules, or trigger summary for opponent rules. */
  setup: string;
  /** Plain-English explanation of when this rule applies. */
  description: string;
  total: number;
  /** Most played first. */
  moves: { san: string; keys: string[] }[];
  /**
   * For setup rules: non-default position keys whose move is already explained
   * by an opponent-aware rule.
   */
  explained?: Record<string, ExplainedException>;
};

export type RulePeers = {
  count: number;
  currentCount: number;
  keys: string[];
  ruleKind: RuleKind;
  ruleSignature: string;
  /** Short description of the shared setup or opponent trigger. */
  reason: string;
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
  /** Set when the same setup or opponent trigger is followed by the proposed move elsewhere. */
  peers: RulePeers | null;
};

type Condition = {
  signature: string;
  kind: 'pattern' | 'trigger';
  setup: string;
  description: string;
  /** Higher wins when two conditions cover the exact same usual positions with equal purity. */
  specificity: number;
  /** When set, at least one of these pawns must be newly placed since a prior player turn. */
  freshPawns?: { square: Square; color: 'w' | 'b' }[];
  /** When set, the rule's usual move must create an attack on this square (e.g. Qb3 attacking b7). */
  targetsSquare?: Square;
};

type IncomingEdge = { from: string; san: string };

const START = new Chess().board();
const FILES = 'abcdefgh';
/** Minimum share of matching positions that must agree for an opponent-aware rule to count. */
const OPPONENT_RULE_COHERENCE = 0.6;

const relRank = (side: PlayerColor, rank: number) => (side === 'white' ? rank : 9 - rank);

const sqAt = (side: PlayerColor, fileIndex: number, relativeRank: number): Square =>
  `${FILES[fileIndex]}${relRank(side, relativeRank)}` as Square;

const squareColor = (sq: Square) => (FILES.indexOf(sq[0]) + Number(sq[1])) % 2;

const oppMoveLabel = (side: PlayerColor, san: string) => (side === 'white' ? `…${san}` : san);

const oppColorName = (side: PlayerColor) => (side === 'white' ? 'Black' : 'White');

function pawnAt(board: Chess, sq: Square, color: 'w' | 'b'): boolean {
  const piece = board.get(sq);
  return piece?.type === 'p' && piece.color === color;
}

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
  const setup = [...moved, ...lost].join(' ') || 'starting setup';
  return {
    signature: all.sort().join(' '),
    setup,
    description:
      setup === 'starting setup' ? 'In the starting setup' : `With your pieces on ${setup}`,
  };
}

/**
 * Board-state opponent patterns holding in `fen` from `side`'s perspective.
 * Every detector is defined in relative coordinates so White and Black are symmetric.
 */
function boardPatterns(side: PlayerColor, fen: string): Condition[] {
  const board = new Chess(fen);
  const mine: 'w' | 'b' = side === 'white' ? 'w' : 'b';
  const opp: 'w' | 'b' = side === 'white' ? 'b' : 'w';
  const oppName = oppColorName(side);
  const patterns: Condition[] = [];

  // 1. 2×2 central/adjacent pawn tension square (e.g. c4, d4 vs c5, d5).
  for (let f = 1; f <= 5; f++) {
    const my1 = sqAt(side, f, 4);
    const my2 = sqAt(side, f + 1, 4);
    const op1 = sqAt(side, f, 5);
    const op2 = sqAt(side, f + 1, 5);
    if (
      pawnAt(board, my1, mine) &&
      pawnAt(board, my2, mine) &&
      pawnAt(board, op1, opp) &&
      pawnAt(board, op2, opp)
    ) {
      patterns.push({
        signature: `pattern:pawn-square:${my1},${my2}/${op1},${op2}`,
        kind: 'pattern',
        setup: `${my1}, ${my2} vs ${op1}, ${op2} pawn square`,
        description: `2×2 pawn tension square (${my1}, ${my2} vs ${oppName}'s ${op1}, ${op2})`,
        specificity: 90,
      });
    }
  }

  // 2. Unopposed adjacent pawn challenge (e.g. …c5 attacking d4 with d5 empty).
  for (let f = 2; f <= 5; f++) {
    const mySq = sqAt(side, f, 4);
    const aheadSq = sqAt(side, f, 5);
    if (!pawnAt(board, mySq, mine) || board.get(aheadSq)) continue;
    for (const df of [-1, 1]) {
      const opSq = sqAt(side, f + df, 5);
      if (!pawnAt(board, opSq, opp)) continue;
      const challenge = oppMoveLabel(side, opSq);
      patterns.push({
        signature: `pattern:pawn-challenge:${opSq}>${mySq}`,
        kind: 'pattern',
        setup: `${challenge} challenges ${mySq} (${aheadSq} empty)`,
        description: `${oppName}'s pawn on ${opSq} challenges ${mySq} with ${aheadSq} empty`,
        specificity: 85,
        freshPawns: [
          { square: opSq, color: opp },
          { square: mySq, color: mine },
        ],
      });
    }
  }

  // 3. Opponent bishop pinning a developed knight to queen or king.
  const pins: {
    bishop: Square;
    knight: Square;
    between: Square;
    target: Square;
    piece: 'q' | 'k';
  }[] = [
    {
      bishop: sqAt(side, 6, 4),
      knight: sqAt(side, 5, 3),
      between: sqAt(side, 4, 2),
      target: sqAt(side, 3, 1),
      piece: 'q',
    },
    {
      bishop: sqAt(side, 1, 4),
      knight: sqAt(side, 2, 3),
      between: sqAt(side, 3, 2),
      target: sqAt(side, 4, 1),
      piece: 'k',
    },
  ];
  for (const pin of pins) {
    const bPiece = board.get(pin.bishop);
    const nPiece = board.get(pin.knight);
    const tPiece = board.get(pin.target);
    if (
      bPiece?.type === 'b' &&
      bPiece.color === opp &&
      nPiece?.type === 'n' &&
      nPiece.color === mine &&
      !board.get(pin.between) &&
      tPiece?.type === pin.piece &&
      tPiece.color === mine
    ) {
      const bLabel = oppMoveLabel(side, `B${pin.bishop}`);
      patterns.push({
        signature: `pattern:pin:${pin.bishop}-${pin.knight}`,
        kind: 'pattern',
        setup: `${bLabel} pins N${pin.knight}`,
        description: `${oppName}'s bishop on ${pin.bishop} pins N${pin.knight}`,
        specificity: 80,
      });
    }
  }

  // 4. Opponent queenside bishop vacated c8/c1 leaving b7/b2 undefended (and not yet attacked).
  const bPawnSq = sqAt(side, 1, 7);
  const oppBishopHome = sqAt(side, 2, 8);
  const myCPawnHome = sqAt(side, 2, 2);
  const myC4Sq = sqAt(side, 2, 4);
  const oppD5Sq = sqAt(side, 3, 5);
  const homePiece = board.get(oppBishopHome);
  if (
    pawnAt(board, bPawnSq, opp) &&
    !(homePiece?.type === 'b' && homePiece.color === opp) &&
    board.attackers(bPawnSq, opp).length === 0 &&
    !board.isAttacked(bPawnSq, mine)
  ) {
    const homeColor = squareColor(oppBishopHome);
    let vacatedBishopSq: Square | null = null;
    for (const rank of board.board()) {
      for (const piece of rank) {
        if (piece?.type === 'b' && piece.color === opp && squareColor(piece.square) === homeColor) {
          vacatedBishopSq = piece.square;
        }
      }
    }
    if (vacatedBishopSq) {
      const bishopRelRank = relRank(side, Number(vacatedBishopSq[1]));
      const cPawnMoved = !pawnAt(board, myCPawnHome, mine);
      const qgStructure = pawnAt(board, myC4Sq, mine) && pawnAt(board, oppD5Sq, opp);
      if (bishopRelRank <= 5) {
        patterns.push({
          signature: `pattern:bishop-sortie:${oppBishopHome}>${bPawnSq}`,
          kind: 'pattern',
          setup: `${oppName}'s ${oppBishopHome} bishop out (${bPawnSq} undefended)`,
          description: `${oppName}'s ${oppBishopHome} bishop developed out, leaving ${bPawnSq} undefended`,
          specificity: 76,
          targetsSquare: bPawnSq,
        });
        if (qgStructure) {
          patterns.push({
            signature: `pattern:qg-bishop-sortie:${oppBishopHome}>${bPawnSq}`,
            kind: 'pattern',
            setup: `${oppName}'s ${oppBishopHome} bishop out vs ${myC4Sq}/${oppD5Sq} (${bPawnSq} undefended)`,
            description: `In the ${myC4Sq}/${oppD5Sq} structure, ${oppName}'s ${oppBishopHome} bishop developed out leaving ${bPawnSq} undefended`,
            specificity: 75,
            targetsSquare: bPawnSq,
          });
        }
        if (cPawnMoved) {
          patterns.push({
            signature: `pattern:c-clear-bishop-sortie:${oppBishopHome}>${bPawnSq}`,
            kind: 'pattern',
            setup: `${oppName}'s ${oppBishopHome} bishop out after ${myCPawnHome} moves (${bPawnSq} undefended)`,
            description: `With the ${myCPawnHome} pawn moved, ${oppName}'s ${oppBishopHome} bishop is out and ${bPawnSq} is undefended`,
            specificity: 74,
            targetsSquare: bPawnSq,
          });
        }
      }
      patterns.push({
        signature: `pattern:bishop-vacated:${oppBishopHome}>${bPawnSq}`,
        kind: 'pattern',
        setup: `${oppName}'s ${oppBishopHome} bishop left (${bPawnSq} undefended)`,
        description: `${oppName}'s ${oppBishopHome} bishop left ${oppBishopHome}, leaving ${bPawnSq} undefended`,
        specificity: 65,
        targetsSquare: bPawnSq,
      });
    }
  }

  return patterns;
}

function buildParents(graph: Graph): Map<string, IncomingEdge[]> {
  const parents = new Map<string, IncomingEdge[]>();
  for (const node of Object.values(graph.nodes)) {
    for (const move of node.moves) {
      let list = parents.get(move.to);
      if (!list) parents.set(move.to, (list = []));
      list.push({ from: node.key, san: move.san });
    }
  }
  return parents;
}

function sortRuleMoves(rule: Rule) {
  rule.moves.sort((a, b) => b.keys.length - a.keys.length || a.san.localeCompare(b.san));
}

export type RuleIndex = {
  rules: Rule[];
  /** Own-piece setup rule for every player decision node with moves. */
  ruleOf: Map<string, Rule>;
  /** Opponent-aware rules matching each node (highest priority first). */
  opponentRulesOf: Map<string, Rule[]>;
  /** Keyed by `${node.key}|${san}` when that repertoire move follows an opponent-aware rule. */
  explainedBy: Map<string, Rule>;
};

export function findRules(graph: Graph): RuleIndex {
  const bySignature = new Map<string, Rule>();
  const ruleOf = new Map<string, Rule>();
  const myDecisionNodes: RepNode[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (!isMine(graph, node) || !node.moves.length) continue;
    myDecisionNodes.push(node);
    const { signature, setup, description } = ownPlacement(graph, node);
    let rule = bySignature.get(signature);
    if (!rule) {
      bySignature.set(
        signature,
        (rule = { signature, kind: 'setup', setup, description, total: 0, moves: [] }),
      );
    }
    rule.total++;
    ruleOf.set(node.key, rule);
    for (const { san } of node.moves) {
      let entry = rule.moves.find(move => move.san === san);
      if (!entry) rule.moves.push((entry = { san, keys: [] }));
      entry.keys.push(node.key);
    }
  }
  const allSetupRules = [...bySignature.values()];
  for (const rule of allSetupRules) sortRuleMoves(rule);

  // Extract opponent-aware candidate rules (newly arisen board patterns + unique last-move triggers).
  const parents = buildParents(graph);
  const boardCache = new Map<string, Chess>();
  const getBoard = (key: string): Chess | null => {
    let cached = boardCache.get(key);
    if (!cached) {
      const node = graph.nodes[key];
      if (!node) return null;
      cached = new Chess(node.fen);
      boardCache.set(key, cached);
    }
    return cached;
  };
  const patternCache = new Map<string, Condition[]>();
  const getPatterns = (key: string): Condition[] => {
    let cached = patternCache.get(key);
    if (!cached) {
      const node = graph.nodes[key];
      cached = node ? boardPatterns(graph.side, node.fen) : [];
      patternCache.set(key, cached);
    }
    return cached;
  };

  type CandidateRule = { rule: Rule; specificity: number; targetsSquare?: Square };
  const oppCandidates = new Map<string, CandidateRule>();
  const oppName = oppColorName(graph.side);
  const mineColor: 'w' | 'b' = graph.side === 'white' ? 'w' : 'b';

  for (const node of myDecisionNodes) {
    const oppEdges = parents.get(node.key) ?? [];
    const grandparents = new Set<string>();
    for (const oppEdge of oppEdges) {
      for (const myEdge of parents.get(oppEdge.from) ?? []) {
        grandparents.add(myEdge.from);
      }
    }

    const activeConditions: Condition[] = [];
    for (const pattern of getPatterns(node.key)) {
      // Only fire a structural pattern when it is newly arisen since at least one prior turn,
      // so ignoring a motif in one branch does not repeat it at every subsequent ply.
      const newlyArisen =
        grandparents.size === 0 ||
        [...grandparents].some(gpKey => {
          if (getPatterns(gpKey).some(prev => prev.signature === pattern.signature)) return false;
          if (!pattern.freshPawns) return true;
          const gpBoard = getBoard(gpKey);
          return !gpBoard || pattern.freshPawns.some(p => !pawnAt(gpBoard, p.square, p.color));
        });
      if (newlyArisen) activeConditions.push(pattern);
    }

    const incomingSans = new Set(oppEdges.map(edge => edge.san));
    if (incomingSans.size === 1) {
      const [lastSan] = incomingSans;
      const moveText = oppMoveLabel(graph.side, lastSan);
      activeConditions.push({
        signature: `trigger:move:${lastSan}`,
        kind: 'trigger',
        setup: `After ${moveText}`,
        description: `When ${oppName} plays ${moveText}`,
        specificity: 40,
      });
    }

    for (const condition of activeConditions) {
      let candidate = oppCandidates.get(condition.signature);
      if (!candidate) {
        candidate = {
          rule: {
            signature: condition.signature,
            kind: condition.kind,
            setup: condition.setup,
            description: condition.description,
            total: 0,
            moves: [],
          },
          specificity: condition.specificity,
          targetsSquare: condition.targetsSquare,
        };
        oppCandidates.set(condition.signature, candidate);
      }
      candidate.rule.total++;
      for (const { san } of node.moves) {
        let entry = candidate.rule.moves.find(move => move.san === san);
        if (!entry) candidate.rule.moves.push((entry = { san, keys: [] }));
        entry.keys.push(node.key);
      }
    }
  }

  // Keep only coherent, informative opponent-aware rules.
  const qualified: CandidateRule[] = [];
  for (const candidate of oppCandidates.values()) {
    const { rule, targetsSquare } = candidate;
    sortRuleMoves(rule);
    const usual = rule.moves[0];
    if (!usual || usual.keys.length < 2) continue;
    if (usual.keys.length / rule.total < OPPONENT_RULE_COHERENCE) continue;

    // A "b7/b2 undefended" bishop-sortie rule only applies when the usual move actually targets b7/b2.
    if (targetsSquare) {
      const attacksTarget = usual.keys.every(key => {
        const move = graph.nodes[key]?.moves.find(m => m.san === usual.san);
        const afterBoard = move ? getBoard(move.to) : null;
        return afterBoard ? afterBoard.isAttacked(targetsSquare, mineColor) : false;
      });
      if (!attacksTarget) continue;
    }

    const distinctSetups = new Set(usual.keys.map(key => ruleOf.get(key)?.signature));
    if (distinctSetups.size === 1) {
      const setupRule = ruleOf.get(usual.keys[0]);
      const sameAsSetupDefault = setupRule?.moves[0]?.san === usual.san;
      if (sameAsSetupDefault) {
        // Generic move triggers must cross setups or explain deviations from a setup's default.
        if (rule.kind === 'trigger') continue;
        // Board patterns are redundant when the same setup already plays the move elsewhere without the pattern.
        if ((setupRule?.moves[0]?.keys.length ?? 0) > usual.keys.length) continue;
      }
    }
    qualified.push(candidate);
  }

  // Prefer broader coverage, higher purity, and more specific structural motifs; drop subsumed rules.
  qualified.sort((a, b) => {
    const aUsual = a.rule.moves[0].keys.length;
    const bUsual = b.rule.moves[0].keys.length;
    return (
      bUsual - aUsual ||
      bUsual / b.rule.total - aUsual / a.rule.total ||
      b.specificity - a.specificity ||
      a.rule.signature.localeCompare(b.rule.signature)
    );
  });

  const opponentRules: Rule[] = [];
  const acceptedUsualSets: { san: string; keys: Set<string> }[] = [];
  for (const { rule } of qualified) {
    const usual = rule.moves[0];
    const subsumed = acceptedUsualSets.some(
      existing => existing.san === usual.san && usual.keys.every(key => existing.keys.has(key)),
    );
    if (subsumed) continue;
    opponentRules.push(rule);
    acceptedUsualSets.push({ san: usual.san, keys: new Set(usual.keys) });
  }

  // Build lookup indices and mark setup-rule exceptions explained by opponent-aware rules.
  const explainedBy = new Map<string, Rule>();
  const opponentRulesOf = new Map<string, Rule[]>();
  for (const rule of opponentRules) {
    const usual = rule.moves[0];
    for (const key of usual.keys) {
      const id = `${key}|${usual.san}`;
      if (!explainedBy.has(id)) explainedBy.set(id, rule);
    }
    for (const move of rule.moves) {
      for (const key of move.keys) {
        let list = opponentRulesOf.get(key);
        if (!list) opponentRulesOf.set(key, (list = []));
        if (!list.includes(rule)) list.push(rule);
      }
    }
  }

  const setupRules = allSetupRules.filter(rule => rule.moves[0].keys.length >= 2);
  for (const rule of setupRules) {
    const explained: Record<string, ExplainedException> = {};
    for (const exception of rule.moves.slice(1)) {
      for (const key of exception.keys) {
        const oppRule = explainedBy.get(`${key}|${exception.san}`);
        if (oppRule) {
          explained[key] = { signature: oppRule.signature, label: oppRule.setup };
        }
      }
    }
    if (Object.keys(explained).length) rule.explained = explained;
  }

  const rules = [...setupRules, ...opponentRules].sort(
    (a, b) =>
      b.total - a.total ||
      Number(a.kind === 'setup') - Number(b.kind === 'setup') ||
      a.setup.localeCompare(b.setup),
  );
  return { rules, ruleOf, opponentRulesOf, explainedBy };
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

/**
 * The finding for playing `proposed` instead of `current` at `key`, whatever
 * it does to the repertoire's size; null when either move does not fit there.
 */
export function proposeChange(
  graph: Graph,
  key: string,
  current: string,
  proposed: string,
): Finding | null {
  const node = graph.nodes[key];
  const child = graph.nodes[node?.moves.find(move => move.san === current)?.to ?? ''];
  const played = node && playMove(node.fen, proposed);
  if (!child || !played || node.moves.some(move => move.san === proposed)) return null;
  const direct = !!graph.nodes[played.move.to];
  if (direct && reaches(graph, played.move.to, node.key)) return null;
  const replies = child.moves.map(move => move.san);
  const answers = [
    ...new Set([
      current,
      ...child.moves.flatMap(reply => graph.nodes[reply.to].moves.map(move => move.san)),
    ]),
  ];
  const plan = direct ? [] : planLines(graph, node, played.fen, replies, answers);
  const changed = applyChange(graph, { key, from: current, to: proposed, plan });
  if (!changed) return null;
  return {
    id: `${key}|${current}|${proposed}`,
    key,
    current,
    proposed,
    after: { key: played.move.to, fen: played.fen },
    direct,
    plan,
    openLines: plan.filter(line => !line.joins).length,
    decisionsBefore: decisionCount(graph),
    decisionsAfter: decisionCount(changed),
    peers: null,
  };
}

export function findConsolidations(graph: Graph): { rules: Rule[]; findings: Finding[] } {
  const { rules, ruleOf, opponentRulesOf, explainedBy } = findRules(graph);
  const decisionsBefore = decisionCount(graph);
  const findings: Finding[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (!isMine(graph, node)) continue;
    const setupRule = ruleOf.get(node.key);
    const setupUsual = setupRule?.moves[0];
    const oppRules = opponentRulesOf.get(node.key) ?? [];

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
      const setupCurrentCount =
        setupRule?.moves.find(move => move.san === current.san)?.keys.length ?? 0;
      const explained = explainedBy.has(`${node.key}|${current.san}`);
      // When an opponent-aware rule governs this position, it takes precedence over the
      // opponent-blind setup default for consistency proposals.
      const governedByOpponentRule = oppRules.length > 0;

      for (const proposed of legalSans(node.fen)) {
        if (node.moves.some(move => move.san === proposed)) continue;
        const played = playMove(node.fen, proposed)!;
        const direct = !!graph.nodes[played.move.to];
        if (direct && reaches(graph, played.move.to, node.key)) continue;

        let peers: RulePeers | null = null;
        if (!explained) {
          for (const oppRule of oppRules) {
            const usual = oppRule.moves[0];
            const currentCount =
              oppRule.moves.find(move => move.san === current.san)?.keys.length ?? 0;
            if (
              usual.san === proposed &&
              usual.keys.length >= 2 &&
              usual.keys.length > currentCount
            ) {
              peers = {
                count: usual.keys.length,
                currentCount,
                keys: usual.keys,
                ruleKind: oppRule.kind,
                ruleSignature: oppRule.signature,
                reason: oppRule.setup,
              };
              break;
            }
          }
          if (
            !peers &&
            !governedByOpponentRule &&
            setupRule &&
            setupUsual?.san === proposed &&
            setupUsual.keys.length >= 2 &&
            setupUsual.keys.length > setupCurrentCount
          ) {
            peers = {
              count: setupUsual.keys.length,
              currentCount: setupCurrentCount,
              keys: setupUsual.keys,
              ruleKind: 'setup',
              ruleSignature: setupRule.signature,
              reason: setupRule.setup,
            };
          }
        }

        const consistent = peers !== null;
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
          peers,
        });
      }
    }
  }
  findings.sort(
    (a, b) =>
      a.decisionsAfter - b.decisionsAfter ||
      a.openLines - b.openLines ||
      (b.peers?.count ?? 0) - (a.peers?.count ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
  return { rules, findings };
}
