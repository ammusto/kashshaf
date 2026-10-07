import type { BookMetadata } from '../types';
import type { SearchAPI } from '../api';

/**
 * The light catalogue (0.8.2): `/books` carries the eight fields the
 * search form, the filters, the browse table and the result rows need —
 * `id`, `title`, `author_id`, `death_ah`, `genre_id`, `page_count`,
 * `token_count`, `parts` — for in-corpus books only. Everything else is
 * fetched for one book when its detail view opens (`getBook`), or for many
 * at once for the metadata export (`getExportFields`). Desktop offline
 * still returns full rows from metadata.db, which are a superset.
 */

/** The hijri century of a death year, as the pipeline stamps it: ceil(year / 100), and 1 for a year of 0. */
export function centuryOf(deathAh: number | null | undefined): number | undefined {
  if (deathAh === null || deathAh === undefined) return undefined;
  return Math.max(1, Math.ceil(deathAh / 100));
}

/** A row from the light catalogue: the on-open fields have not been fetched. */
export function isLightRow(book: BookMetadata): boolean {
  return book.metadata_json === undefined && book.citation_json === undefined && book.tags === undefined;
}

/** The per-book cache of full rows, by corpus: a row never changes within a corpus version. */
const fullRows = new Map<number, Promise<BookMetadata | null>>();

/** Tests and a corpus change start afresh. */
export function resetFullRowCache(): void {
  fullRows.clear();
}

/** The full row for a book, fetched once; a light row is enough until it arrives. */
export function fetchFullBook(api: SearchAPI, book: BookMetadata): Promise<BookMetadata | null> {
  if (!isLightRow(book)) return Promise.resolve(book);
  let p = fullRows.get(book.id);
  if (!p) {
    p = api.getBook(book.id).catch((err) => {
      fullRows.delete(book.id);
      throw err;
    });
    fullRows.set(book.id, p);
  }
  return p;
}

/**
 * The books with the columns the metadata export writes beyond the
 * catalogue (`citation_json`, `paginated`, `corpus`, `original_id`), fetched
 * in one request for all of them. Rows that already carry them are left as
 * they are; a row the server does not know keeps what it had.
 */
export async function withExportFields(api: SearchAPI, books: BookMetadata[]): Promise<BookMetadata[]> {
  const light = books.filter(isLightRow);
  if (light.length === 0) return books;
  const fields = await api.getExportFields(light.map((b) => b.id));
  const byId = new Map(fields.map((f) => [f.id, f]));
  return books.map((b) => {
    const f = byId.get(b.id);
    if (!f) return b;
    return {
      ...b,
      citation_json: f.citation_json ?? undefined,
      paginated: f.paginated ?? undefined,
      corpus: f.corpus ?? undefined,
      original_id: f.original_id ?? undefined,
    };
  });
}
