/**
 * The markup a note's text carries (9 B3).
 *
 * The smallest thing that round-trips: `**bold**` and `__underline__`, the
 * two marks the editor offers. Not HTML — a note is stored, exported to
 * `notes.json`, and read by people, and none of those want tags. Plain text
 * is already valid, so every note written before this reads as itself.
 *
 * Nesting is one level: `**__both__**` is bold and underlined. An unclosed
 * mark is literal, so a reader who types two asterisks and stops sees two
 * asterisks.
 */

export interface Span {
  text: string;
  bold: boolean;
  underline: boolean;
}

const BOLD = '**';
const UNDER = '__';

/** The note's text as styled runs, in order. */
export function parseNote(text: string): Span[] {
  const out: Span[] = [];
  let bold = false;
  let underline = false;
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ text: buf, bold, underline });
    buf = '';
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if ((two === BOLD || two === UNDER) && closes(text, i, two)) {
      flush();
      if (two === BOLD) bold = !bold;
      else underline = !underline;
      i += 2;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** Whether the mark at `i` has a partner later on, so it is a mark at all. */
function closes(text: string, i: number, mark: string): boolean {
  return text.indexOf(mark, i + 2) !== -1 || isOpen(text, i, mark);
}

/** True when this occurrence is the closing half of a pair already opened. */
function isOpen(text: string, i: number, mark: string): boolean {
  let count = 0;
  for (let j = 0; j + 1 < i; j += 1) {
    if (text.slice(j, j + 2) === mark) {
      count += 1;
      j += 1;
    }
  }
  return count % 2 === 1;
}

/** The note without its markup, for a list, a tooltip or a search. */
export function plainNote(text: string): string {
  return parseNote(text)
    .map((s) => s.text)
    .join('');
}

/** The first line of a note, plain, for the annotations list (9 B1). */
export function noteFirstLine(text: string, max = 80): string {
  const line = plainNote(text).split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Wrap `[start, end)` of `text` in a mark, or unwrap it when it is already
 * wrapped — what the editor's Bold and Underline buttons do to a selection.
 * Returns the new text and where the selection should sit afterwards.
 */
export function toggleMark(text: string, start: number, end: number, mark: 'bold' | 'underline'): { text: string; start: number; end: number } {
  const m = mark === 'bold' ? BOLD : UNDER;
  if (start === end) return { text, start, end };
  const before = text.slice(0, start);
  const middle = text.slice(start, end);
  const after = text.slice(end);
  // Already wrapped, just inside the selection.
  if (middle.startsWith(m) && middle.endsWith(m) && middle.length > m.length * 2) {
    const inner = middle.slice(m.length, -m.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  // Or just outside it.
  if (before.endsWith(m) && after.startsWith(m)) {
    return {
      text: before.slice(0, -m.length) + middle + after.slice(m.length),
      start: start - m.length,
      end: end - m.length,
    };
  }
  return { text: `${before}${m}${middle}${m}${after}`, start: start + m.length, end: end + m.length };
}
