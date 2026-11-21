import { Chess } from 'chess.js';
import {
  GAME_RESULTS,
  MAX_MESSAGE_LENGTH,
  type ChatRequest,
  type GameContext,
  type GamePlayer,
  type GameResult,
  type PlayerColor,
} from '../shared/protocol.ts';
import { MAX_HISTORY_MOVES } from './config.ts';
import { HttpError } from './http.ts';

type Fields = Record<string, unknown>;

const fields = (input: unknown): Fields => {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid request');
  return input as Fields;
};

/** Replays the submitted SAN history from the start and checks it reaches the submitted FEN. */
export function replaySnapshot(input: unknown) {
  const { moves, fen } = fields(input);
  if (
    !Array.isArray(moves) ||
    moves.length > MAX_HISTORY_MOVES ||
    !moves.every((move): move is string => typeof move === 'string')
  ) {
    throw new HttpError(400, 'Invalid move history');
  }
  const board = new Chess();
  const uci: string[] = [];
  for (const san of moves) {
    try {
      const move = board.move(san);
      uci.push(move.from + move.to + (move.promotion ?? ''));
    } catch {
      throw new HttpError(400, `Invalid move in history: ${san}`);
    }
  }
  if (board.fen() !== fen) throw new HttpError(400, 'Position does not match move history');
  return { board, fen: board.fen(), moves, uci };
}

export function parsePlayerColor(value: unknown, fallback?: PlayerColor): PlayerColor {
  const color = value ?? fallback;
  if (color !== 'white' && color !== 'black') throw new HttpError(400, 'Invalid player color');
  return color;
}

/** Text from another site, cut to one short line before it reaches the model. */
const line = (value: unknown, max: number) =>
  typeof value === 'string'
    ? value
        .replace(/[\p{C}\s]+/gu, ' ')
        .trim()
        .slice(0, max)
    : '';

function parsePlayer(value: unknown): GamePlayer {
  const { name, rating } = fields(value);
  return {
    name: line(name, 60) || '?',
    rating: typeof rating === 'number' && Number.isFinite(rating) ? rating : null,
  };
}

/** The game under review: it must be a legal non-empty game; `shown` may be on the mainline or a sideline. */
function parseGame(input: unknown): GameContext {
  const game = fields(input);
  const moves = game.moves;
  if (
    !Array.isArray(moves) ||
    !moves.length ||
    moves.length > MAX_HISTORY_MOVES ||
    !GAME_RESULTS.includes(game.result as GameResult)
  ) {
    throw new HttpError(400, 'Invalid game');
  }
  const board = new Chess();
  try {
    for (const san of moves) board.move(san);
  } catch {
    throw new HttpError(400, 'Invalid game');
  }
  return {
    white: parsePlayer(game.white),
    black: parsePlayer(game.black),
    result: game.result as GameResult,
    termination: line(game.termination, 120),
    timeClass: line(game.timeClass, 20),
    timeControl: line(game.timeControl, 20),
    opening: line(game.opening, 120) || null,
    playedAt: line(game.playedAt, 30),
    moves: board.history(),
  };
}

export function parseChatRequest(input: unknown): ChatRequest {
  const { message, playerColor, conversationId, game } = fields(input);
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `Enter a message (maximum ${MAX_MESSAGE_LENGTH} characters)`);
  }
  const { fen, moves } = replaySnapshot(input);
  return {
    message,
    fen,
    moves,
    playerColor: parsePlayerColor(playerColor, 'white'),
    conversationId:
      typeof conversationId === 'string' && /^[\w-]{1,64}$/.test(conversationId)
        ? conversationId
        : undefined,
    ...(game != null && { game: parseGame(game) }),
  };
}
