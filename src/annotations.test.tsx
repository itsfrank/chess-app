import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import { remarkMoveLinks, type Annotation } from './annotations';
const board = new Chess(); board.move('e4');
const arrows: Annotation[] = [{ id: 'knight', from: 'g8', to: 'f6', color: '#4ade80' }, { id: 'pawn', from: 'e7', to: 'e6', color: '#60a5fa' }];
const render = (text: string, position = board.fen(), annotations = arrows) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, [remarkMoveLinks, { fen: position, arrows: annotations }]], children: text }));
it('links plain and bold SAN including black move prefixes', () => {
  const html = render('...Nf6 and **…Nf6**, or 1...e6. Not Nf60 or aNf6.');
  expect(html.match(/href="#annotation-knight"/g)).toHaveLength(2);
  expect(html).toContain('href="#annotation-pawn"');
  expect(html).toContain('Not Nf60 or aNf6');
});
it('preserves explicit links and skips code', () => {
  const html = render('[**Nf6**](#annotation-knight) and `Nf6`\n\n```\nNf6\n```');
  expect(html.match(/href="#annotation-knight"/g)).toHaveLength(1);
  expect(html).toContain('<code>Nf6</code>');
});
it('does not infer a link for unrelated positions or ambiguous arrows', () => {
  expect(render('Nf6', new Chess().fen())).not.toContain('<a');
  expect(render('Nf6', board.fen(), [...arrows, { ...arrows[0], id: 'other' }])).not.toContain('<a');
});
it('rejects the recorded d4-space arrow mislabeled as 1...Nf6', () => {
  const position = new Chess(); position.move('d4');
  const space: Annotation = { id: 'd4-space', from: 'd4', to: 'e5', color: '#4ade80' };
  const html = render('[**1...Nf6**](#annotation-d4-space)', position.fen(), [space]);
  expect(html).not.toContain('<a');
  expect(html).toContain('<strong>1...Nf6</strong>');
  expect(render('[Nf6](#annotation-d4-space)', position.fen(), [space, arrows[0]])).toContain('href="#annotation-knight"');
});
it('renders GFM tables with linked moves, lists and emphasis', () => {
  const html = render('| Move | Eval |\n| --- | ---: |\n| **Nf6** | +0.2 |\n| e6 | +0.3 |\n\n- Develop\n- **Protect** the center');
  expect(html).toContain('<table>'); expect(html).toContain('<thead>'); expect(html).toContain('<tbody>');
  expect(html).toContain('href="#annotation-knight"'); expect(html).toContain('<ul>'); expect(html).toContain('<strong>Protect</strong>');
});
