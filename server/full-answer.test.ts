import { describe, expect, it } from 'vitest';
import { fullAnswerRequest, needsFullAnswer, SHORT_REPLY_WORDS } from './chat.ts';

describe('the check for a reply that only captions its arrows', () => {
  it('asks again after arrows when the reply is short', () => {
    expect(needsFullAnswer("I've drawn the arrows on the board: green is Nf3.", true)).toBe(true);
    expect(needsFullAnswer('', true)).toBe(true);
  });
  it('leaves long replies and replies without arrows alone', () => {
    expect(needsFullAnswer('word '.repeat(SHORT_REPLY_WORDS), true)).toBe(false);
    expect(needsFullAnswer('Nf3 is best.', false)).toBe(false);
  });
  it('shows the model what the user saw', () => {
    expect(fullAnswerRequest('Green is Nf3.')).toContain('Green is Nf3.');
    expect(fullAnswerRequest('  ')).toContain('(nothing)');
  });
});
