/**
 * Checks the companion's reply against the board before the turn ends: a
 * cheap model writes down the concrete claims it makes (what attacks, defends,
 * captures, checks or pins what, after which moves), the rules of chess decide
 * each one, and the false ones are handed back to be corrected.
 */
import { verify, type Claim, type PieceRef } from './claims.ts';
import { positionFacts } from './facts.ts';

/** Asks a model for one reply to `message` under `system`. */
export type Ask = (system: string, message: string) => Promise<string>;

const describe = (name: string, fen: string) => {
  const { white, black, toMove } = positionFacts(fen);
  return `${name}: ${fen}\n  White: ${white}\n  Black: ${black}\n  ${toMove} to move`;
};

/**
 * The extractor's instructions, for a terse line format rather than JSON: the same claims in a
 * fraction of the output, which is most of the time the check takes.
 */
export const COMPACT_EXTRACTOR_PROMPT = `You list the concrete, checkable chess claims in a coach's answer. You do not judge them.

Write one claim per line, fields separated by " ; ", and nothing else:
kind ; from ; line ; subject ; object ; quote

- kind: attacks (also "hits", "threatens to take", "forks": one line per forked piece), defends (protects a piece of its own side), captures (the last move of line is made by subject and takes object), check (after line the side to move is in check), on (subject stands on its square), pinned (subject is pinned to its king or to a more valuable piece behind it).
- from: snapshot (the position asked about) or before (the position one move earlier, when given).
- line: the SAN moves, without numbers and separated by spaces, that the answer says are played before the claim holds, starting from "from"; "-" for the position itself.
- subject and object: colour, piece letter (k q r b n p) and square, in that order, each written only if the answer states or plainly implies it, e.g. "black n c3", "white q", "r e1"; "-" for none.
- quote: at most eight words of the answer.
- Do not correct the answer: record what it says. Skip evaluations, plans, advice, squares without a piece, and claims whose moves you cannot place. Record a claim once. If there are none, write: none`;

const KINDS: Record<string, Claim['kind']> = {
  attacks: 'attacks',
  defends: 'defends',
  captures: 'captures',
  check: 'check',
  on: 'piece_on',
  pinned: 'pinned',
};

/** "black n c3" → a piece reference; fields are recognised by their shape, in any order. */
function pieceRef(text: string): PieceRef {
  const ref: PieceRef = {};
  for (const word of text.trim().toLowerCase().split(/\s+/)) {
    if (word === 'white' || word === 'black') ref.color = word;
    else if (/^[kqrbnp]$/.test(word)) ref.piece = word as PieceRef['piece'];
    else if (/^[a-h][1-8]$/.test(word)) ref.square = word;
  }
  return ref;
}

/** The claims in the extractor's lines; lines that do not fit the format are dropped. */
export function parseCompactClaims(reply: string): Claim[] {
  return reply.split('\n').flatMap(row => {
    const fields = row.split(' ; ').map(field => field.trim());
    const kind = KINDS[fields[0]?.toLowerCase()];
    if (fields.length < 5 || !kind) return [];
    const [, from, line, subject, object, ...quote] = fields;
    return [
      {
        kind,
        from: from === 'before' ? 'before' : 'snapshot',
        line: line === '-' ? [] : line.split(/\s+/).filter(Boolean),
        subject: subject === '-' ? {} : pieceRef(subject),
        ...(object && object !== '-' && { object: pieceRef(object) }),
        quote: quote.join(' ; '),
      } satisfies Claim,
    ];
  });
}

/** The reply in parts of about `size` characters, split between paragraphs, to extract in parallel. */
export function parts(reply: string, size = 700): string[] {
  const out: string[] = [];
  for (const paragraph of reply.split(/\n\s*\n/)) {
    if (out.length && out[out.length - 1].length + paragraph.length < size)
      out[out.length - 1] += `\n\n${paragraph}`;
    else out.push(paragraph);
  }
  return out.filter(part => part.trim());
}

/** The position a reply is about, as the claim check needs it. */
export type Position = {
  fen: string;
  /** The position before the snapshot's last move, and that move numbered ("12… Nxe5"). */
  before?: { fen: string; move: string };
  /** The game's moves after the snapshot, when a finished game is under review. */
  continuation?: string[];
};

/**
 * Checks a reply while it is being written: each run of whole paragraphs of about `size`
 * characters is sent off as soon as it is complete, so by the end of the reply only its last
 * part is still being read.
 */
export class ClaimCheck {
  private readonly context: string;
  private readonly pending: Promise<Claim[]>[] = [];
  /** How much of the reply has been sent off. */
  private sent = 0;

  constructor(
    private readonly ask: Ask,
    private readonly position: Position,
    private readonly size = 700,
  ) {
    const { fen, before, continuation } = position;
    this.context = [
      describe('snapshot', fen),
      before
        ? `${describe('before', before.fen)}\n  then ${before.move} was played, giving the snapshot`
        : '',
      continuation?.length
        ? `The game continued from the snapshot: ${continuation.slice(0, 12).join(' ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Sends off the reply's complete paragraphs not yet sent, once there are enough of them. */
  update(reply: string) {
    const end = reply.lastIndexOf('\n\n');
    if (end > this.sent && end - this.sent >= this.size)
      this.send(reply.slice(this.sent, end), end);
  }

  /** The false claims in `reply`, once the rest of it has been read. */
  async finish(reply: string): Promise<Claim[]> {
    if (reply.length > this.sent) this.send(reply.slice(this.sent), reply.length);
    const claims = (await Promise.all(this.pending)).flat();
    const { fen, before } = this.position;
    return claims.filter(claim => verify(claim, fen, before?.fen) === 'false');
  }

  private send(part: string, end: number) {
    this.sent = end;
    if (!part.trim()) return;
    this.pending.push(
      this.ask(COMPACT_EXTRACTOR_PROMPT, `${this.context}\n\nAnswer to list claims from:\n${part}`)
        .then(parseCompactClaims)
        .catch(() => []),
    );
  }
}

/** The claims in `reply` that the board shows to be false, read in parallel parts. */
export async function falseClaims(ask: Ask, reply: string, position: Position): Promise<Claim[]> {
  const check = new ClaimCheck(ask, position);
  for (let at = reply.indexOf('\n\n'); at >= 0; at = reply.indexOf('\n\n', at + 2))
    check.update(reply.slice(0, at + 2));
  return check.finish(reply);
}

/** What the companion is told when its reply says something the board contradicts. */
export function claimFeedback(claims: Claim[]): string {
  const where = (claim: Claim) =>
    claim.line?.length
      ? ` (after ${claim.line.join(' ')} from the ${claim.from === 'before' ? 'position before the last move' : 'snapshot'})`
      : '';
  return [
    'Checked against the board, these statements in your reply are false:',
    ...claims.map(claim => `- "${claim.quote}"${where(claim)}`),
    'Write your complete reply again with them corrected or removed, as a replacement the user will read instead of the first one, not an addendum. Use analyze_position or diagnose_move if you need the facts. Keep the arrows unless they show something false, and keep every move link matching its arrow.',
  ].join('\n');
}
