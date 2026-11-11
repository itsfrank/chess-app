// Synthetic visual QA, not a recorded engine/model result. Uses the existing replay API.
// Run: npx tsx docs/design/create-fixture.ts > /tmp/chess-design.jsonl
// Then: REPLAY_LOG=/tmp/chess-design.jsonl npm run server
import { Chess } from "chess.js";
import { annotationPalette } from "../../src/annotation-palette.ts";
const fen = new Chess().fen();
let seq = 0;
const record = (kind: string, data: unknown) =>
  console.log(
    JSON.stringify({
      version: 1,
      seq: seq++,
      at: "2026-01-01T00:00:00.000Z",
      kind,
      data,
    }),
  );
const arrows = Object.entries(annotationPalette).map(([name, color], i) => ({
  id: name,
  color,
  from: [
    "e2",
    "d2",
    "g1",
    "b1",
    "c2",
    "f2",
    "e7",
    "d7",
    "g8",
    "b8",
    "c7",
    "f7",
  ][i],
  to: ["e4", "d4", "f3", "c3", "c4", "f4", "e5", "d5", "f6", "c6", "c5", "f5"][
    i
  ],
}));
record("session", {
  model: "synthetic-visual-fixture",
  lifetime: { tokens: 0, cost: 0 },
});
const turn = (message: string, text: string, count: number) => {
  record("request", { message, fen, moves: [], playerColor: "white" });
  record("client", { type: "conversation", id: "design-fixture" });
  record("client", { type: "arrows", arrows: arrows.slice(0, count) });
  record("client", { type: "text", delta: text });
  record("client", { type: "done" });
  record("turn_end", { disconnected: false });
};
turn(
  "What should I look for?",
  `### Candidate moves

| Move | Purpose |
| --- | --- |
| [**e4**](#annotation-blue) | Controls d5 and f5 |
| [**d4**](#annotation-purple) | Controls c5 and e5 |
| [**Nf3**](#annotation-green) | Develops toward the center |
| [**Nc3**](#annotation-orange) | Supports d5 and e4 |

### Position notes

A central pawn move opens a bishop’s diagonal. A knight move develops a piece without committing your central pawns.

After [**e4**](#annotation-blue), develop the kingside knight and bishop to prepare castling. After [**d4**](#annotation-purple), the c-pawn can support a broader center with c4.

These are opening principles, not a Stockfish ranking.`,

  4,
);
turn(
  "Show the annotation palette.",
  `### Twelve ideas, one board
This is a **synthetic palette stress test**, not an engine recommendation. All twelve colors use the same annotation IDs and hover interaction as a normal explanation.

**White’s possibilities**

${arrows
  .slice(0, 6)
  .map((a) => `[${a.from} → ${a.to}](#annotation-${a.id})`)
  .join(" · ")}

**Black’s possibilities**

${arrows
  .slice(6)
  .map((a) => `[${a.from} → ${a.to}](#annotation-${a.id})`)
  .join(" · ")}

Focus or hover any colored reference to increase its arrow’s weight and fade the others. The square endpoints provide a second way to identify a line.`,
  12,
);
