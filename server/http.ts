import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_CHARS } from './config.ts';

/** An error whose message is safe to show the user, with the HTTP status to send. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const errorMessage = (error: unknown, fallback = 'Request failed') =>
  error instanceof Error && error.message ? error.message : fallback;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_CHARS) throw new HttpError(413, 'Request too large');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed) return;
  res
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}
