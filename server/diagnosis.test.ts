import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { Analysis, Evaluation } from '../shared/protocol.ts';
import { diagnoseMove, gist, opponentIdea, passed, winnings } from './diagnosis.ts';

const cp = (value: number): Evaluation => ({ type: 'cp', value });
const line = (fen: string, sans: string[], evaluation: Evaluation): Analysis['moves'][number] => {
  const move = new Chess(fen).move(sans[0]);
  return { move: move.lan, san: move.san, evaluation, continuation: sans, depth: 20 };
};
const analysis = (fen: string, moves: Analysis['moves']): Analysis => ({
  fen,
  perspective: 'white',
  depth: 20,
  evaluation: moves[0].evaluation,
  moves,
});

// White: Ke1, Rd2. Black: Ke8, Qd5. White to move can win the queen with Rxd5.
const FEN = '4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1';

/** A scripted engine for the three searches a diagnosis makes. */
async function engine(fen: string, moves: string[] = []): Promise<Analysis> {
  const board = new Chess(fen);
  for (const san of moves) board.move(san);
  const at = board.fen();
  if (moves.includes('Rd3')) return analysis(at, [line(at, ['Qxd3'], cp(-1500))]);
  if (board.turn() === 'b') return analysis(at, [line(at, ['Qxd2+', 'Kxd2'], cp(-1500))]);
  return analysis(at, [line(at, ['Rxd5'], cp(1500)), line(at, ['Ke2'], cp(-600))]);
}

describe('diagnosing a move', () => {
  it('finds the reply a move allowed and what it wins', async () => {
    const found = await diagnoseMove(FEN, 'Rd3', engine);
    expect(found.category).toBe('allowed');
    expect(found.reply?.wins).toBe('a rook');
    expect(found.finding).toContain('Qxd3 (queen d5 takes rook on d3');
    expect(found.better).toEqual(['Rxd5']);
    expect(found.best?.wins).toBe('a queen');
    // Qxd2+ would lose the queen to Kxd2, so there was no threat before the move.
    expect(found.threatBefore).toBeUndefined();
    // The engine's moves and the move played, side by side.
    expect(found.candidates[0]).toMatch(
      /^Rxd5: \+15\.00, mover's winning chances \d+%; line Rxd5;/,
    );
    expect(found.candidates.at(-1)).toMatch(/^Rd3 \(played\): -15\.00/);
  });

  it("finds the opponent's idea by letting the side to move pass", async () => {
    // White to move; if White passed, Black's Qxd2+ would be met by Kxd2: no material in it.
    const idea = await opponentIdea(FEN, fen => engine(fen));
    expect(idea?.move).toContain('Qxd2+');
    expect(idea?.wins).toBeUndefined();
    expect(
      await opponentIdea('4k3/8/8/8/8/8/3q4/4K3 w - - 0 1', fen => engine(fen)),
    ).toBeUndefined();
  });

  it('passes the move to the other side, and not while in check', () => {
    expect(passed(FEN)?.split(' ')[1]).toBe('b');
    expect(passed('4k3/8/8/8/8/8/3q4/4K3 w - - 0 1')).toBeNull();
  });

  it('nets out what is given back', () => {
    const before = new Chess('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1');
    const after = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(winnings(before, after, 'w')).toBe('a queen for a rook');
  });

  it('compares positional facts without the counts that change every move', () => {
    expect(gist('White pawns: a2 b2; 2 islands; 1 on light squares, 1 on dark')).toBe(
      'White pawns: 2 islands',
    );
    expect(gist('White pieces have 22 safe moves in all')).toBe('');
  });
});
