/**
 * Checks concrete board claims in a companion answer against the position.
 * A model reads the answer and writes each claim down in a fixed form; whether
 * a claim is true is then decided by the rules of chess, not by a model.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { pinnedPieces } from '../server/facts.ts';

/** A piece as an answer refers to it: "the knight", "White's queen", "the rook on c7". */
export type PieceRef = { color?: 'white' | 'black'; piece?: PieceSymbol; square?: string };

export type Claim = {
  /** The words of the answer the claim is taken from. */
  quote: string;
  /** Which position `line` starts from: the one asked about, or the one before its last move. */
  from: 'snapshot' | 'before';
  /** SAN moves to play before the claim holds; empty when it is about the starting position. */
  line: string[];
  kind: 'attacks' | 'defends' | 'captures' | 'check' | 'piece_on' | 'pinned';
  subject: PieceRef;
  object?: PieceRef;
};
export type Verdict = 'true' | 'false' | 'bad-line' | 'unclear';

export const EXTRACTOR_PROMPT = `You extract concrete, checkable chess claims from a coach's answer. You do not judge them.

Output only a JSON array. Each element is one claim:
{"quote": "<the answer's words>", "from": "snapshot" | "before", "line": ["SAN", ...], "kind": "attacks" | "defends" | "captures" | "check" | "piece_on" | "pinned", "subject": {"color": "white" | "black", "piece": "k|q|r|b|n|p", "square": "e4"}, "object": {...}}

- "line" is the exact sequence of moves, in SAN without move numbers, that the answer says are played before the claim holds, starting from the position named in "from". Use "snapshot" for the position the question is about and "before" for the position one move earlier (given when it exists). An empty line means the claim is about that position itself.
- attacks: subject piece attacks object piece (also "hits", "threatens to take", "forks": one claim per forked piece). defends: subject protects object, same colour. captures: the LAST move of "line" is made by subject and takes object. check: after "line" the side to move is in check; subject is the checking piece if named. piece_on: subject (with square) stands there. pinned: subject cannot move without exposing its king.
- Fill in "color", "piece" and "square" only as far as the answer states or plainly implies them; omit a field you would have to guess. Do not correct the answer: if it says a knight on c3 attacks the queen on a5, record exactly that.
- Skip evaluations, plans, general advice, and anything about squares without a piece. Skip claims whose moves you cannot place. Record a claim once.
- If there are none, output [].`;

const COLOR: Record<string, Color> = { white: 'w', black: 'b' };
type Placed = { square: Square; type: PieceSymbol; color: Color };

const matches = (ref: PieceRef, piece: Placed) =>
  (!ref.color || COLOR[ref.color] === piece.color) &&
  (!ref.piece || ref.piece === piece.type) &&
  (!ref.square || ref.square === piece.square);

/**
 * Whether the claim holds, read generously: it is true if any pieces fitting
 * its description stand in the stated relation. `bad-line` means its moves
 * cannot be played, which may be the answer's mistake or the extraction's.
 */
export function verify(claim: Claim, snapshot: string, before?: string): Verdict {
  const start = claim.from === 'before' ? before : snapshot;
  if (!start || !claim.subject) return 'unclear';
  const board = new Chess(start);
  let last;
  try {
    for (const san of claim.line ?? []) last = board.move(san);
  } catch {
    return 'bad-line';
  }
  const pieces = board
    .board()
    .flat()
    .filter(piece => piece !== null) as Placed[];
  const subjects = pieces.filter(piece => matches(claim.subject, piece));
  const objects = claim.object ? pieces.filter(piece => matches(claim.object!, piece)) : [];
  const related = (sameColor: boolean) =>
    subjects.some(subject =>
      objects.some(
        object =>
          (object.color === subject.color) === sameColor &&
          object.square !== subject.square &&
          board.attackers(object.square, subject.color).includes(subject.square),
      ),
    );

  switch (claim.kind) {
    case 'attacks':
      return claim.object ? (related(false) ? 'true' : 'false') : 'unclear';
    case 'defends':
      return claim.object ? (related(true) ? 'true' : 'false') : 'unclear';
    case 'captures': {
      if (!last) return 'unclear';
      const mover = { square: last.from, type: last.piece, color: last.color };
      // The subject's square, if given, may name where it came from or where it lands.
      const subjectFits =
        matches({ ...claim.subject, square: undefined }, mover) &&
        (!claim.subject.square || [last.from, last.to].includes(claim.subject.square as Square));
      const taken = last.captured && {
        square: last.to,
        type: last.captured,
        color: last.color === 'w' ? ('b' as const) : ('w' as const),
      };
      const objectFits =
        !!taken && (!claim.object || matches({ ...claim.object, square: undefined }, taken));
      return subjectFits && objectFits ? 'true' : 'false';
    }
    case 'check':
      return board.isCheck() ? 'true' : 'false';
    case 'piece_on':
      return claim.subject.square ? (subjects.length ? 'true' : 'false') : 'unclear';
    case 'pinned':
      return pinnedPieces(board).some(piece => matches(claim.subject, piece)) ? 'true' : 'false';
    default:
      return 'unclear';
  }
}

/** The claims in a model's reply, which should be a JSON array and nothing else. */
export function parseClaims(reply: string): Claim[] {
  const json = reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1);
  const parsed: unknown = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? (parsed as Claim[]) : [];
}
