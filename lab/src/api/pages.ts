/**
 * Page labels — the one place Lab decides how a page is written (spec 1.5 §C1).
 *
 * The rule, everywhere: a single-part book shows the printed page number
 * alone (`24`); a multi-part book shows part and page (`1:24`). Never
 * `0:24` — parts are counted from one for the reader, whatever the corpus's
 * zero-based `part_index` — never `:24`, and never `Page 20 of 405`.
 *
 * The printed number lives in the index, not in `page_tokens`, so the
 * backend hands the reader a `PageEntry` per page and [`Pages`] is the
 * lookup every table and header uses.
 */

import { useEffect, useState } from 'react';
import { labApi, type PageEntry } from './lab';

/** A page's coordinates, as every panel stores them. */
export interface At {
  part_index: number;
  page_id: number;
}

export function sameAt(a: At | null | undefined, b: At | null | undefined): boolean {
  return !!a && !!b && a.part_index === b.part_index && a.page_id === b.page_id;
}

/** Order two positions the way a book reads. */
export function compareAt(a: At, b: At): number {
  return a.part_index - b.part_index || a.page_id - b.page_id;
}

/**
 * One book's page list, with the label rule and the lookups the panels need.
 *
 * Built once when a text is opened and passed down; a panel that has not got
 * one yet can use [`Pages.empty`], which falls back to the raw page id so a
 * label is never blank.
 */
export class Pages {
  readonly entries: PageEntry[];
  readonly multiPart: boolean;
  private readonly byAt = new Map<string, number>();

  constructor(entries: PageEntry[] = [], parts?: number | null) {
    this.entries = entries;
    const distinctParts = new Set(entries.map((e) => e.part_index)).size;
    // The entries are authoritative when we have them; `parts` covers the
    // moment before they arrive.
    this.multiPart = entries.length > 0 ? distinctParts > 1 : (parts ?? 1) > 1;
    entries.forEach((e, i) => this.byAt.set(key(e.part_index, e.page_id), i));
  }

  static empty(parts?: number | null): Pages {
    return new Pages([], parts);
  }

  get length(): number {
    return this.entries.length;
  }

  /** The label for a page, by its coordinates (spec §C1). */
  label(partIndex: number, pageId: number): string {
    const e = this.entry(partIndex, pageId);
    const printed = e?.page_number?.trim() || String(pageId);
    return this.multiPart ? `${partIndex + 1}:${printed}` : printed;
  }

  /** The same for a whole entry, without a lookup. */
  labelOf(e: PageEntry): string {
    const printed = e.page_number?.trim() || String(e.page_id);
    return this.multiPart ? `${e.part_index + 1}:${printed}` : printed;
  }

  /** The printed number alone — what the page input holds. */
  printed(partIndex: number, pageId: number): string {
    const e = this.entry(partIndex, pageId);
    return e?.page_number?.trim() || String(pageId);
  }

  entry(partIndex: number, pageId: number): PageEntry | undefined {
    const i = this.byAt.get(key(partIndex, pageId));
    return i === undefined ? undefined : this.entries[i];
  }

  indexOf(partIndex: number, pageId: number): number {
    return this.byAt.get(key(partIndex, pageId)) ?? -1;
  }

  at(index: number): PageEntry | undefined {
    return this.entries[index];
  }

  /**
   * The page a reader typed: a printed number, and a part when the book has
   * several. Falls back to matching the page id, so a book whose printed
   * numbers are missing is still navigable.
   */
  find(pageInput: string, partInput?: string): PageEntry | undefined {
    const page = pageInput.trim();
    if (!page) return undefined;
    const part = partInput?.trim();
    const partIndex = part ? Number(part) - 1 : undefined;
    const inPart = (e: PageEntry) => partIndex === undefined || !this.multiPart || e.part_index === partIndex;
    return (
      this.entries.find((e) => inPart(e) && e.page_number.trim() === page) ??
      this.entries.find((e) => inPart(e) && String(e.page_id) === page)
    );
  }

  /** Distinct part numbers as the reader counts them (1-based). */
  partNumbers(): number[] {
    return [...new Set(this.entries.map((e) => e.part_index))].sort((a, b) => a - b).map((p) => p + 1);
  }
}

function key(partIndex: number, pageId: number): string {
  return `${partIndex}:${pageId}`;
}

/**
 * A label without a page list — for a row whose book is not the open one
 * (a reuse target, say). Falls back to the page id, and to `part:page` when
 * the book is known to have parts.
 */
export function plainPageLabel(partIndex: number, pageId: number, parts?: number | null, pageNumber?: string | null): string {
  const printed = pageNumber?.trim() || String(pageId);
  return (parts ?? 1) > 1 ? `${partIndex + 1}:${printed}` : printed;
}

/**
 * One book's page list, loaded once. Every panel that shows a page label
 * holds one of these, so they all name a page the same way (spec 1.5 §C1).
 *
 * Until it arrives, and if it fails, the fallback still labels a page: the
 * raw page id, with the part when the book has several. A missing label is
 * worse than an approximate one.
 */
export function usePages(bookId: number | null, parts?: number | null): Pages {
  const [pages, setPages] = useState<Pages>(() => Pages.empty(parts));

  useEffect(() => {
    if (bookId == null) {
      setPages(Pages.empty(parts));
      return;
    }
    let live = true;
    setPages(Pages.empty(parts));
    labApi
      .listPages(bookId)
      .then((entries) => live && setPages(new Pages(entries, parts)))
      .catch(() => live && setPages(Pages.empty(parts)));
    return () => {
      live = false;
    };
  }, [bookId, parts]);

  return pages;
}
