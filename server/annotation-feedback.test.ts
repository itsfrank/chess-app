import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { annotationErrors, repairAnnotations } from './annotation-feedback.ts';
import type { Annotation } from '../src/annotations.ts';
const board = new Chess(); board.move('d4');
const arrow: Annotation = { id: 'space', from: 'd4', to: 'e5', color: '#4ade80' };
const text = '[**1...Nf6**](#annotation-space)';
it('detects the recorded mismatch and supplies exact correction coordinates', () => {
  expect(annotationErrors(board.fen(), text, [arrow])[0]).toContain('g8→f6');
  expect(annotationErrors(board.fen(), text, [{ ...arrow, from: 'g8', to: 'f6' }])).toEqual([]);
  expect(annotationErrors(board.fen(), '[central pressure](#annotation-space)', [arrow])).toEqual([]);
  expect(annotationErrors(board.fen(), text, [])).toHaveLength(1);
  expect(annotationErrors(board.fen(), '`' + text + '`', [])).toEqual([]);
});
it('repairs once on success and stops after two failed repairs', async () => {
  let errors = ['wrong arrow']; let calls = 0;
  expect(await repairAnnotations({ errors: () => errors, cancelled: () => false, repair: async feedback => { expect(feedback).toContain('wrong arrow'); calls++; errors = []; } })).toEqual([]);
  expect(calls).toBe(1);
  calls = 0;
  expect(await repairAnnotations({ errors: () => ['still wrong'], cancelled: () => false, repair: async () => { calls++; } })).toEqual(['still wrong']);
  expect(calls).toBe(2);
});
it('does not repair after disconnect', async () => {
  await repairAnnotations({ errors: () => ['wrong'], cancelled: () => true, repair: async () => { throw new Error('should not run'); } });
});
