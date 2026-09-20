/**
 * Matches across page breaks (corpus 4.3.0's boundary index), as both apps
 * show them.
 *
 * A hit that straddles a break is one result on its primary page — the page
 * holding more of the match, the earlier on a tie — with the other page as
 * `secondary`. The row says where the rest is; the reader marks the edge of
 * the card where the highlight runs off it.
 */

/** The other page of a match across a page break, and its share of it. */
export interface SecondarySpan {
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  matched_token_indices: number[];
}

/**
 * The longest span the boundary index guarantees to find: one token on one
 * side of the break and the rest on the other, out of 20 + 20.
 */
export const CROSS_PAGE_MAX_SPAN = 21;

/** A phrase of more words than the guarantee covers. */
export function phraseExceedsCrossPageSpan(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length > CROSS_PAGE_MAX_SPAN;
}

/** The note under a long phrase. */
export const LONG_PHRASE_NOTE = 'Long phrases may not be found where they cross a page break.';

/**
 * The page label rule (C1): `part_label:page_number` in a multi-part book,
 * the page number alone otherwise; the page id when nothing is printed.
 */
export function pageLabelC1(partLabel: string | undefined, pageNumber: string | undefined, pageId: number, partIndex: number, multiPart: boolean): string {
  const printed = pageNumber?.trim() || String(pageId);
  if (!multiPart) return printed;
  const part = partLabel?.trim() || String(partIndex + 1);
  return `${part}:${printed}`;
}

/**
 * What the row says at its edge for a match across a page break: whether the
 * rest is on the page after (`continues on p. 11`) or before (`continues
 * from p. 10`). `secondaryIsAfter` is decided by the caller from the spine
 * (or, without one, by page order within the part).
 */
export function continuationLabel(secondary: SecondarySpan, secondaryIsAfter: boolean, multiPart: boolean): string {
  const label = pageLabelC1(secondary.part_label, secondary.page_number, secondary.page_id, secondary.part_index, multiPart);
  return secondaryIsAfter ? `continues on p. ${label}` : `continues from p. ${label}`;
}

/** Whether the secondary page comes after the primary, without a spine: by (part, page). */
export function secondaryIsAfter(primary: { part_index: number; page_id: number }, secondary: { part_index: number; page_id: number }): boolean {
  return secondary.part_index > primary.part_index || (secondary.part_index === primary.part_index && secondary.page_id > primary.page_id);
}
