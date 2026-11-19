import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/protocol.ts';
import { createApp } from './app.ts';
import { Recorder, Replay } from './recording.ts';

const board = new Chess();
board.move('d4');
const turn = {
  message: 'Explain d4',
  fen: board.fen(),
  moves: ['d4'],
  playerColor: 'white' as const,
};
const events: ServerEvent[] = [
  { type: 'conversation', id: 'recorded' },
  { type: 'text', delta: 'Central ' },
  { type: 'text', delta: 'space.' },
  { type: 'done' },
];

let dir: string;
let url: string;
let close: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chess-app-'));
  const recorder = new Recorder(dir, { lifetime: { tokens: 7, cost: 0.5 } });
  recorder.record('request', turn);
  events.forEach(event => recorder.record('client', event));
  recorder.record('turn_end', { disconnected: false });
  const server = createApp({ lifetime: { tokens: 0, cost: 0 }, replay: new Replay(recorder.path) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url + path, { method: 'POST', body: JSON.stringify(body), headers });
const lines = async (response: Response) =>
  (await response.text())
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

it('reports the recording’s lifetime usage', async () => {
  const response = await fetch(`${url}/api/usage`);
  expect(await response.json()).toEqual({ lifetime: { tokens: 7, cost: 0.5 } });
});

it('rejects other websites, unknown routes and malformed requests before replaying anything', async () => {
  expect((await post('/api/chat', turn, { Origin: 'https://example.com' })).status).toBe(403);
  expect((await fetch(`${url}/api/nothing`)).status).toBe(404);

  const invalid = await post('/api/chat', { ...turn, fen: new Chess().fen() });
  expect(invalid.status).toBe(400);
  expect(await lines(invalid)).toEqual([
    { type: 'error', message: 'Position does not match move history' },
  ]);

  const notJson = await fetch(`${url}/api/chat`, { method: 'POST', body: '{' });
  expect(await lines(notJson)).toEqual([
    { type: 'error', message: 'Request body is not valid JSON' },
  ]);

  const mismatch = await post('/api/chat', { ...turn, message: 'Something else' });
  expect((await lines(mismatch))[0].message).toContain('Replay mismatch');
});

it('streams the recorded turn, then reports exhaustion', async () => {
  const response = await post('/api/chat', turn, { Origin: 'http://localhost:5173' });
  expect(response.headers.get('x-chess-replay')).toBe('true');
  expect(await lines(response)).toEqual(events);
  expect((await lines(await post('/api/chat', turn)))[0].message).toBe('Replay exhausted');
});

it('analyses positions, answering finished games without starting an engine', async () => {
  const mated = await post('/api/analysis', { fen: '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1' });
  expect(await mated.json()).toMatchObject({
    moves: [],
    evaluation: { type: 'mate', value: 0, winner: 'white' },
  });
  for (const path of ['/api/analysis', '/api/explorer']) {
    const invalid = await post(path, { fen: 'not a position' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ message: 'Invalid position' });
  }
});

it('lists chess.com games, validating the username first', async () => {
  const invalid = await fetch(`${url}/api/chesscom/games?username=a%20b`);
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ message: 'Enter a chess.com username' });
  expect((await post('/api/chesscom/games', {})).status).toBe(404);
});

it('reviews games only when the service is present', async () => {
  const response = await post('/api/games/review', { moves: ['e4'] });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ message: 'Game review is unavailable' });
});

it('has no opponent during replay', async () => {
  const response = await post('/api/opponent', {});
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ message: expect.stringContaining('unavailable') });
});
