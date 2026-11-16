import { Chess } from 'chess.js';
import { MAX_MESSAGE_LENGTH, type ChatRequest, type PlayerColor } from '../shared/protocol.ts';
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

export function parseChatRequest(input: unknown): ChatRequest {
  const { message, playerColor, conversationId } = fields(input);
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
  };
}
