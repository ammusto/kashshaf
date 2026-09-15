import { describe, it, expect } from 'vitest';
import { parseNote, plainNote, noteFirstLine, toggleMark } from './noteText';

/**
 * The note markup (9 B3). What matters is that it round-trips: whatever the
 * editor writes, the reader reads back, and a note written before any of
 * this existed is still itself.
 */

describe('note markup', () => {
  it('reads plain text as plain text', () => {
    expect(parseNote('a note')).toEqual([{ text: 'a note', bold: false, underline: false }]);
    expect(plainNote('a note')).toBe('a note');
  });

  it('marks bold and underline, and both at once', () => {
    expect(parseNote('say **this** now')).toEqual([
      { text: 'say ', bold: false, underline: false },
      { text: 'this', bold: true, underline: false },
      { text: ' now', bold: false, underline: false },
    ]);
    expect(parseNote('__here__')).toEqual([{ text: 'here', bold: false, underline: true }]);
    expect(parseNote('**__both__**')).toEqual([{ text: 'both', bold: true, underline: true }]);
  });

  it('leaves an unclosed mark alone, because the writer is mid-word', () => {
    expect(plainNote('two ** asterisks')).toBe('two ** asterisks');
    expect(parseNote('**')).toEqual([{ text: '**', bold: false, underline: false }]);
  });

  it('round-trips through plain text and back', () => {
    const text = 'the **isnād** is __broken__ here';
    expect(plainNote(text)).toBe('the isnād is broken here');
    expect(parseNote(text).map((s) => s.text).join('')).toBe(plainNote(text));
  });

  it('takes the first non-empty line for the list, and cuts a long one', () => {
    expect(noteFirstLine('\n**first**\nsecond')).toBe('first');
    expect(noteFirstLine('x'.repeat(200))).toHaveLength(80);
    expect(noteFirstLine('x'.repeat(200)).endsWith('…')).toBe(true);
  });

  it('wraps a selection, and unwraps it again', () => {
    const a = toggleMark('say this now', 4, 8, 'bold');
    expect(a.text).toBe('say **this** now');
    expect(a.text.slice(a.start, a.end)).toBe('this');

    // Inside the marks.
    expect(toggleMark(a.text, a.start, a.end, 'bold').text).toBe('say this now');
    // Or with the marks inside the selection.
    expect(toggleMark('say **this** now', 4, 12, 'bold').text).toBe('say this now');
  });

  it('does nothing to an empty selection', () => {
    expect(toggleMark('a', 1, 1, 'underline')).toEqual({ text: 'a', start: 1, end: 1 });
  });
});
