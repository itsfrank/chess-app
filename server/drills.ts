import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Chess } from 'chess.js';
import { DEFAULT_EASE, drillKey, scheduleDrill, sortDrills } from '../shared/drills.ts';
import type { DrillCard, DrillInput, PlayerColor } from '../shared/protocol.ts';
import { MAX_HISTORY_MOVES } from './config.ts';
import { HttpError } from './http.ts';

const QUALITIES = new Set(['inaccuracy', 'mistake', 'blunder']);

const shortText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function validateDrillInput(raw: unknown): DrillInput & { fen: string } {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Invalid drill');
  const input = raw as Record<string, unknown>;
  const { moves, playerColor, played, best, loss, quality, opening, gameUrl, playedAt, rating } =
    input;
  if (
    !Array.isArray(moves) ||
    moves.length > MAX_HISTORY_MOVES ||
    !moves.every((m): m is string => typeof m === 'string')
  ) {
    throw new HttpError(400, 'Invalid drill moves');
  }
  if (playerColor !== 'white' && playerColor !== 'black') {
    throw new HttpError(400, 'Invalid player color');
  }
  if (typeof played !== 'string' || typeof best !== 'string') {
    throw new HttpError(400, 'Invalid drill candidate moves');
  }
  if (typeof quality !== 'string' || !QUALITIES.has(quality)) {
    throw new HttpError(400, 'Invalid drill quality');
  }
  const board = new Chess();
  try {
    for (const san of moves) board.move(san);
  } catch {
    throw new HttpError(400, 'Illegal move history in drill');
  }
  const fen = board.fen();
  const canonicalMoves = board.history();

  let canonicalPlayed: string;
  let canonicalBest: string;
  try {
    canonicalPlayed = new Chess(fen).move(played).san;
    canonicalBest = new Chess(fen).move(best).san;
  } catch {
    throw new HttpError(400, 'Drill played/best move is not legal in position');
  }

  return {
    fen,
    moves: canonicalMoves,
    playerColor: playerColor as PlayerColor,
    played: canonicalPlayed,
    best: canonicalBest,
    loss: typeof loss === 'number' && Number.isFinite(loss) ? Math.max(0, Math.min(100, loss)) : 0,
    quality: quality as DrillInput['quality'],
    opening: shortText(opening, 120) || null,
    gameUrl: shortText(gameUrl, 240),
    playedAt: shortText(playedAt, 40) || new Date().toISOString(),
    rating: typeof rating === 'number' && Number.isFinite(rating) ? rating : null,
  };
}

/** Persistent JSON store for spaced-repetition mistake drills. */
export class DrillStore {
  private readonly file?: string;
  private cards: DrillCard[] = [];

  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) this.cards = parsed as DrillCard[];
      } catch {
        this.cards = [];
      }
    }
  }

  list(nowMs = Date.now()): DrillCard[] {
    return sortDrills(this.cards, nowMs);
  }

  /**
   * Adds one or more drills (accepts `{ cards: DrillInput[] }` or a single `DrillInput`),
   * deduplicating against existing cards by position + played + best move.
   */
  addMany(body: unknown, now = new Date()): { added: DrillCard[]; cards: DrillCard[] } {
    const rawList =
      body && typeof body === 'object' && Array.isArray((body as { cards?: unknown }).cards)
        ? (body as { cards: unknown[] }).cards
        : [body];
    if (!rawList.length || rawList.length > 50) {
      throw new HttpError(400, 'Provide between 1 and 50 drills');
    }

    const existingKeys = new Set(this.cards.map(c => drillKey(c.fen, c.played, c.best)));
    const isoNow = now.toISOString();
    const added: DrillCard[] = [];

    for (const raw of rawList) {
      const valid = validateDrillInput(raw);
      const key = drillKey(valid.fen, valid.played, valid.best);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const card: DrillCard = {
        ...valid,
        id: randomUUID(),
        createdAt: isoNow,
        intervalDays: 0,
        ease: DEFAULT_EASE,
        reps: 0,
        lapses: 0,
        dueAt: isoNow,
        lastReviewedAt: null,
        lastResult: null,
      };
      this.cards.push(card);
      added.push(card);
    }

    if (added.length) this.save();
    return { added, cards: this.list(now.getTime()) };
  }

  /** Records a drill attempt outcome (`solved = true` for pass, `false` for miss/reveal). */
  review(id: string, body: unknown, now = new Date()): DrillCard {
    const solved = (body as { solved?: unknown } | null)?.solved;
    if (typeof solved !== 'boolean') throw new HttpError(400, 'Expected boolean solved');
    const index = this.cards.findIndex(c => c.id === id);
    if (index < 0) throw new HttpError(404, 'Drill not found');
    const updated = scheduleDrill(this.cards[index], solved, now);
    this.cards[index] = updated;
    this.save();
    return updated;
  }

  remove(id: string): { removed: boolean } {
    const before = this.cards.length;
    this.cards = this.cards.filter(c => c.id !== id);
    const removed = this.cards.length !== before;
    if (removed) this.save();
    return { removed };
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cards, null, 2));
    renameSync(tmp, this.file);
  }
}
