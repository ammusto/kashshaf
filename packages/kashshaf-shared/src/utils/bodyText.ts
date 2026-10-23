/**
 * The page body as a reader shows it.
 *
 * `stripHtml` is what produces the display text, and `buildCharToTokenMap`
 * runs on exactly that string, so every token index depends on it. This
 * walks the body once, stripping tags exactly as `stripHtml` does, and
 * reports *where* each `<title id=N parent=M>` heading landed in the
 * stripped text's own coordinates. The reader styles those characters and
 * gives them their own line; nothing about the string changes.
 *
 * Ported from Lab's `src/api/bodyText.ts`, which fixed the same two faults
 * there: newlines collapsed by CSS, and headings running into the prose.
 */

import { stripHtml } from './arabicTokenizer';

/** A heading's span in the stripped text, `end` exclusive. */
export interface HeadingRange {
  start: number;
  end: number;
  /** The tag's own id and parent, for a contents pane to match on. */
  id: number;
  parent: number;
}

export interface BodyText {
  /** Exactly `stripHtml(body)`: the string the token map is built from. */
  plain: string;
  headings: HeadingRange[];
}

const TITLE_OPEN = /<title\s+id=(\d+)\s+parent=(\d+)\s*>/gi;
const ANY_TAG = /<br\s*\/?>|<[^>]*>/gi;

/**
 * Strip tags as `stripHtml` does (`<br>` becomes a newline, every other tag
 * is deleted) while recording where each `<title>` block lands.
 */
export function readBody(body: string): BodyText {
  if (!body) return { plain: '', headings: [] };

  const headings: HeadingRange[] = [];
  let plain = '';
  let at = 0;
  let open: { start: number; id: number; parent: number } | null = null;

  ANY_TAG.lastIndex = 0;
  for (let m = ANY_TAG.exec(body); m !== null; m = ANY_TAG.exec(body)) {
    plain += body.slice(at, m.index);
    const tag = m[0];
    if (/^<br/i.test(tag)) {
      plain += '\n';
    } else {
      TITLE_OPEN.lastIndex = 0;
      const t = TITLE_OPEN.exec(tag);
      if (t) {
        open = { start: plain.length, id: Number(t[1]), parent: Number(t[2]) };
      } else if (/^<\/title/i.test(tag) && open) {
        headings.push({ start: open.start, end: plain.length, id: open.id, parent: open.parent });
        open = null;
      }
    }
    at = m.index + tag.length;
  }
  plain += body.slice(at);

  // A heading cut off by the end of the page still reads as one.
  if (open && plain.length > open.start) {
    headings.push({ start: open.start, end: plain.length, id: open.id, parent: open.parent });
  }

  // The contract: this must be what `stripHtml` returns, or every token
  // index moves. Cheap to assert, and a silent drift here is invisible.
  if (plain !== stripHtml(body)) {
    return { plain: stripHtml(body), headings: [] };
  }
  return { plain, headings };
}

/** Whether a character position falls inside a heading. */
export function headingAt(headings: HeadingRange[], pos: number): HeadingRange | null {
  for (const h of headings) {
    if (pos >= h.start && pos < h.end) return h;
  }
  return null;
}
