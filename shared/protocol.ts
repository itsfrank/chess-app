/** Types and constants shared by the browser client and the local backend. */
import type { Square } from 'chess.js';
import type { Finding, Rule } from './consolidation.ts';
import type { Change, Graph } from './repertoire.ts';

export type PlayerColor = 'white' | 'black';
export type Totals = { tokens: number; cost: number };
export type Annotation = { id: string; from: Square; to: Square; color: string };

export const OPPONENT_ELOS = [1000, 1200, 1500, 1800, 2000] as const;
export const MAX_MESSAGE_LENGTH = 8000;
/** Lichess explorer rating groups; each starts at its value and runs up to the next. */
export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

/** A position as the client sees it. `fen` must equal the result of replaying `moves`. */
export type Snapshot = { fen: string; moves: string[] };

export type ChatRequest = Snapshot & {
  message: string;
  playerColor: PlayerColor;
  conversationId?: string;
};
export type OpponentRequest = Snapshot & { playerColor: PlayerColor; elo: number };
export type OpponentMove = { move: string; san: string; fen: string };

/** Engine scores are always from White's perspective. */
export type Evaluation =
  { type: 'cp'; value: number } | { type: 'mate'; value: number; winner?: PlayerColor };
export type Candidate = {
  move: string;
  san: string;
  evaluation: Evaluation;
  continuation: string[];
  depth: number;
};
export type Analysis = {
  fen: string;
  perspective: 'white';
  depth: number;
  evaluation: Evaluation;
  moves: Candidate[];
};

/** Move frequencies from the Lichess opening explorer for one position. */
export type ExplorerResult = {
  source: string;
  url: string;
  fen: string;
  filters: { ratings: number[]; speeds: string[] };
  fetchedAt: string;
  totalGames: number;
  opening: { eco: string; name: string } | null;
  moves: {
    uci: string;
    san: string;
    games: number;
    /** Share of all games at the position; null when there are none. */
    frequency: number | null;
    whiteWins: number;
    draws: number;
    blackWins: number;
    averageRating: number | null;
  }[];
  /** Games that continued with a move outside the listed ones. */
  otherGames: number;
  note: string;
};

/** One line of the `/api/chat` NDJSON response stream. */
export type ServerEvent =
  | { type: 'conversation'; id: string }
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'replace_text'; text: string }
  | { type: 'arrows'; arrows: Annotation[] }
  | { type: 'analysis'; result: Analysis }
  | { type: 'explorer'; result: ExplorerResult }
  | { type: 'usage'; session: Totals; lifetime: Totals }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** A fixed-depth engine verdict on one position; `best` is the engine's move in SAN. */
export type PositionEval = { evaluation: Evaluation; best: string | null; depth: number };

export type RepertoireSummary = {
  id: string;
  name: string;
  side: PlayerColor;
  importedAt: string;
  /** Positions where the player must know a move, after accepted changes. */
  decisions: number;
  /** Number of accepted deviations from the import. */
  accepted: number;
};

/** Progress of the background engine and explorer passes over a repertoire. */
export type RepertoireJob = {
  running: boolean;
  evalDone: number;
  evalTotal: number;
  frequencyDone: number;
  frequencyTotal: number;
  error: string | null;
};

export type RepertoireSettings = {
  /** Lichess rating buckets whose games weight the lines; each covers up to the next bucket. */
  ratings: number[];
};

export type RepertoireReport = RepertoireSummary & {
  settings: RepertoireSettings;
  /** Size of the PGN as imported, before any accepted change. */
  imported: { positions: number; decisions: number };
  /** The repertoire with accepted changes applied. */
  graph: Graph;
  rules: Rule[];
  findings: Finding[];
  dismissed: string[];
  /** Accepted deviations from the import, oldest first; inactive ones no longer fit. */
  changes: (Change & { active: boolean; path: string[] })[];
  /** Engine verdicts by position key, for the graph and for every proposed move. */
  evals: Record<string, PositionEval>;
  /** How often each position arises per game, from opponents' move frequencies. */
  reach: Record<string, number>;
  /** False while some opponent positions still lack explorer data. */
  reachComplete: boolean;
  job: RepertoireJob;
  engineDepth: number;
};
