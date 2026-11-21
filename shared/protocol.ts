/** Types and constants shared by the browser client and the local backend. */
import type { Square } from 'chess.js';
import type { Finding, Rule } from './consolidation.ts';
import type { Habits } from './habits.ts';
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

/** One side of a finished game. */
export type GamePlayer = { name: string; rating: number | null };

/** A finished game the user is studying; `moves` is the whole game in SAN. */
export type GameContext = {
  white: GamePlayer;
  black: GamePlayer;
  result: GameResult;
  /** How it ended, in the source's words: "frk won by resignation". */
  termination: string;
  timeClass: string;
  timeControl: string;
  opening: string | null;
  playedAt: string;
  moves: string[];
  /** Remaining clock seconds for the mover after each ply, parallel to `moves`. */
  clocks?: number[];
};
export const GAME_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;
export type GameResult = (typeof GAME_RESULTS)[number];

/** A game from a player's chess.com archive. */
export type ArchivedGame = GameContext & {
  /** The game's page on chess.com; unique per game. */
  url: string;
  /** The side the requested player had. */
  playerColor: PlayerColor;
};
export type GameArchivePage = {
  /** The player's name as chess.com spells it. */
  username: string;
  /** Newest first. */
  games: ArchivedGame[];
  /** Pass as `before` to get the next page; null when there are no older games. */
  older: number | null;
};

/** Win/draw/loss counts for a slice of games. */
export type RecordSplit = { games: number; wins: number; draws: number; losses: number };

/** Performance in one named opening as White or Black. */
export type OpeningStat = RecordSplit & { name: string; color: PlayerColor };

/** Player mistakes/blunders/inaccuracies bucketed by game phase. */
export type PhaseErrors = { opening: number; middlegame: number; endgame: number };

/** Player errors broken down by clock situation in games with `[%clk]` data. */
export type ClockHabits = {
  timedErrors: number;
  timeTroubleErrors: number;
  impulsiveErrors: number;
  deepThinkErrors: number;
};

/** Cross-game summary built from recent chess.com games plus any cached Stockfish reviews. */
export type PlayerProfile = {
  username: string;
  generatedAt: string;
  gamesAnalyzed: number;
  overall: RecordSplit;
  white: RecordSplit;
  black: RecordSplit;
  timeoutLosses: number;
  openings: OpeningStat[];
  weakestOpenings: OpeningStat[];
  reviewedGames: number;
  avgAccuracy: { overall: number | null; white: number | null; black: number | null };
  errorCounts: { inaccuracies: number; mistakes: number; blunders: number };
  phaseErrors: PhaseErrors;
  clockHabits: ClockHabits;
};

export type ChatRequest = Snapshot & {
  message: string;
  playerColor: PlayerColor;
  conversationId?: string;
  /** Set when the snapshot is a position from a finished game under review. */
  game?: GameContext;
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
export type PositionEval = {
  evaluation: Evaluation;
  best: string | null;
  depth: number;
  /** The score after the engine's second choice, when it was asked for one and there is one. */
  second?: Evaluation;
};

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
  /** Positions with an engine verdict, at whatever depth. */
  evalDone: number;
  evalTotal: number;
  /** Of those, the ones searched less deeply than is configured now. */
  evalStale: number;
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
  /** The player's own games compared with the repertoire; null until they have been fetched. */
  habits: (Habits & { username: string; fetchedAt: string }) | null;
  /** Engine verdicts by position key, for the graph and for every proposed move. */
  evals: Record<string, PositionEval>;
  /** How often each position arises per game, from opponents' move frequencies. */
  reach: Record<string, number>;
  /** False while some opponent positions still lack explorer data. */
  reachComplete: boolean;
  job: RepertoireJob;
  engineDepth: number;
};

/** Reasoning effort the companion's model can run at. */
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/** App-wide settings, kept by the backend so every screen and restart sees the same ones. */
export type Settings = {
  /** The player whose games the app lists and compares; empty until set. */
  chesscomUsername: string;
  /** The companion's model, as its id with the provider. */
  model: string;
  effort: Effort;
  /** Stockfish depth of the pass over a reviewed game. */
  gameReviewDepth: number;
  /** Stockfish depth for every repertoire position and proposal. */
  repertoireDepth: number;
  /** Seconds Stockfish thinks about the position on the board, for the panel and the companion. */
  analysisSeconds: number;
};
export const DEFAULT_SETTINGS: Settings = {
  chesscomUsername: '',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  gameReviewDepth: 16,
  repertoireDepth: 18,
  analysisSeconds: 1.5,
};
/** Allowed range of each numeric setting. */
export const SETTING_LIMITS = {
  gameReviewDepth: { min: 8, max: 24, step: 1 },
  repertoireDepth: { min: 10, max: 26, step: 1 },
  analysisSeconds: { min: 0.5, max: 8, step: 0.5 },
} as const;

export type SettingsInfo = {
  settings: Settings;
  /** Models the companion could use; empty when they cannot be listed, as during a replay. */
  models: { id: string; name: string }[];
};
