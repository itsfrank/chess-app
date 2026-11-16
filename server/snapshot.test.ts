import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import { parseChatRequest, replaySnapshot } from './snapshot.ts';

const start = new Chess().fen();
const afterE4 = new Chess();
afterE4.move('e4');

it('replays history to UCI and checks it against the submitted position', () => {
  const { uci, board } = replaySnapshot({
    moves: ['e4', 'e5', 'Nf3'],
    fen: replayFen(['e4', 'e5', 'Nf3']),
  });
  expect(uci).toEqual(['e2e4', 'e7e5', 'g1f3']);
  expect(board.turn()).toBe('b');
  expect(() => replaySnapshot({ moves: ['e4'], fen: start })).toThrow('does not match');
  expect(() => replaySnapshot({ moves: ['e5'], fen: start })).toThrow(
    'Invalid move in history: e5',
  );
  expect(() => replaySnapshot({ moves: 'e4', fen: start })).toThrow('Invalid move history');
  expect(() => replaySnapshot(null)).toThrow('Invalid request');
});

it('parses chat requests, defaulting the side and dropping malformed conversation ids', () => {
  const base = { message: 'Explain e4', moves: ['e4'], fen: afterE4.fen() };
  expect(parseChatRequest(base)).toEqual({
    ...base,
    playerColor: 'white',
    conversationId: undefined,
  });
  expect(
    parseChatRequest({ ...base, playerColor: 'black', conversationId: 'abc-123' }),
  ).toMatchObject({
    playerColor: 'black',
    conversationId: 'abc-123',
  });
  expect(parseChatRequest({ ...base, conversationId: '../x' }).conversationId).toBeUndefined();
  expect(() => parseChatRequest({ ...base, message: '  ' })).toThrow('Enter a message');
  expect(() => parseChatRequest({ ...base, message: 'x'.repeat(8001) })).toThrow('Enter a message');
  expect(() => parseChatRequest({ ...base, playerColor: 'red' })).toThrow('Invalid player color');
});

function replayFen(moves: string[]) {
  const board = new Chess();
  for (const move of moves) board.move(move);
  return board.fen();
}
