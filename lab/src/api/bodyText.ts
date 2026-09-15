/**
 * The page body as the reader shows it (Phase 7 A2).
 *
 * Two things were wrong. The body's newlines survived `stripHtml` but CSS
 * collapsed them, so a page of verse arrived as one paragraph. And
 * `<title id=N parent=M>` was deleted along with every other tag, so a
 * heading ran straight into the prose after it.
 *
 * Both are fixed without touching the token overlay. `stripHtml` is still
 * what produces the text, and `buildCharToTokenMap` still runs on exactly
 * that string, so every token index is unchanged: this only reports *where*
 * the headings ended up, in the stripped text's own coordinates, and the
 * reader styles those characters differently.
 */

import { stripHtml } from '@kashshaf/shared';

/** A heading's span in the stripped text, `end` exclusive. */
export interface HeadingRange {
  start: number;
  end: number;
  /** The tag's own id and parent, for the contents pane to match on. */
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
 * Walk the body once, stripping tags exactly as `stripHtml` does while
 * recording where each `<title>` block lands in the output.
 *
 * `stripHtml` turns `<br>` into a newline and deletes everything else, so
 * the walk mirrors that and nothing else.
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
