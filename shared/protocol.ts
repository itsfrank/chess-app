/** Types and constants shared by the browser client and the local backend. */
import type { Square } from 'chess.js';

export type PlayerColor = 'white' | 'black';
export type Totals = { tokens: number; cost: number };
export type Annotation = { id: string; from: Square; to: Square; color: string };

export const OPPONENT_ELOS = [1000, 1200, 1500, 1800, 2000] as const;
export const MAX_MESSAGE_LENGTH = 8000;

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
