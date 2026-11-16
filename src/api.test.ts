import { afterEach, expect, it, vi } from 'vitest';
import type { ChatRequest, ServerEvent } from '../shared/protocol';
import { requestOpponentMove, streamChat } from './api';

afterEach(() => vi.unstubAllGlobals());

const request: ChatRequest = { message: 'Hi', fen: 'fen', moves: [], playerColor: 'white' };
const signal = new AbortController().signal;

/** A response whose body arrives in the given chunks. */
function chunked(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

async function collect(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const events: ServerEvent[] = [];
  for await (const event of streamChat(request, signal)) events.push(event);
  return events;
}

it('reassembles events split across chunks, with or without a final newline', async () => {
  const events = await collect(
    chunked(['{"type":"text","del', 'ta":"é"}\n\n{"type":"status","text":"x"}\n{"type":"done"}']),
  );
  expect(events).toEqual([
    { type: 'text', delta: 'é' },
    { type: 'status', text: 'x' },
    { type: 'done' },
  ]);
});

it('surfaces the server’s message for failed requests in any body format', async () => {
  await expect(collect(chunked(['{"type":"error","message":"Too busy"}\n'], 503))).rejects.toThrow(
    /^Too busy$/,
  );
  await expect(collect(chunked(['plain text'], 500))).rejects.toThrow(/^plain text$/);
  await expect(collect(chunked([], 502))).rejects.toThrow('HTTP 502');

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ message: 'It is your turn' }, { status: 400 })),
  );
  const opponentRequest = { fen: 'fen', moves: [], playerColor: 'white' as const, elo: 1500 };
  await expect(requestOpponentMove(opponentRequest, signal)).rejects.toThrow(/^It is your turn$/);
});
