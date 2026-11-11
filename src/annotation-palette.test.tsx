import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { Chess, type Square } from "chess.js";
import { expect, it } from "vitest";
import {
  annotationPalette,
  annotationColorNames,
  maxAnnotations,
} from "./annotation-palette";
import { remarkMoveLinks } from "./annotations";

it("offers twelve unique named colors without remapping the original four", () => {
  expect(annotationColorNames).toHaveLength(12);
  expect(new Set(Object.values(annotationPalette)).size).toBe(12);
  expect(maxAnnotations).toBeGreaterThanOrEqual(12);
  expect(annotationPalette).toMatchObject({
    blue: "#60a5fa",
    purple: "#c084fc",
    green: "#4ade80",
    orange: "#fb923c",
  });
});
it("preserves twelve explicit annotation identities through the existing Markdown plugin", () => {
  const arrows = annotationColorNames.map((id, i) => ({
    id,
    from: `${"abcdefgh"[i % 8]}2` as Square,
    to: `${"abcdefgh"[i % 8]}4` as Square,
    color: annotationPalette[id],
  }));
  const text = arrows
    .map((a) => `[${a.from} → ${a.to}](#annotation-${a.id})`)
    .join(" · ");
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [[remarkMoveLinks, { fen: new Chess().fen(), arrows }]],
      children: text,
    }),
  );
  for (const { id } of arrows)
    expect(html).toContain(`href="#annotation-${id}"`);
});
