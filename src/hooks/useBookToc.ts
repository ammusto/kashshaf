import { useEffect, useMemo, useState } from 'react';
import { flattenToc } from '@kashshaf/shared';
import type { TocNode } from '../types';
import type { SearchAPI } from '../api';

/** What the contents pane can be showing. */
export type TocAvailability =
  /** Not asked yet, or being fetched. */
  | 'loading'
  /** The tree arrived (possibly empty: a book with no headings). */
  | 'ready'
  /** This source cannot serve one: no toc.db, or a server without the route. */
  | 'unavailable'
  | 'error';

export interface BookToc {
  availability: TocAvailability;
  tree: TocNode[];
  /** The tree as rows in reading order, for `entryForPage`. */
  rows: TocNode[];
  error: string | null;
}

const NONE: BookToc = { availability: 'loading', tree: [], rows: [], error: null };

/**
 * One book's table of contents, fetched once per book.
 *
 * `null` from the API is "cannot serve one" — a corpus older than 4.2.0 has
 * no toc.db, a server older than 0.5.2 has no route — and is reported as
 * such, not as an error; the pane says what it needs. A book with no
 * headings (1,116 of 7,199 have none) is an empty tree, and the pane says
 * that instead.
 */
export function useBookToc(api: SearchAPI, bookId: number | null): BookToc {
  const [state, setState] = useState<BookToc>(NONE);

  useEffect(() => {
    if (bookId === null) {
      setState(NONE);
      return;
    }
    let live = true;
    setState(NONE);
    // Through a promise even for a synchronous throw (a source without the
    // method at all), so nothing here can take the reader down.
    Promise.resolve()
      .then(() => api.getBookToc(bookId))
      .then((tree) => {
        if (!live) return;
        if (tree === null) {
          setState({ availability: 'unavailable', tree: [], rows: [], error: null });
          return;
        }
        setState({ availability: 'ready', tree, rows: flattenToc(tree), error: null });
      })
      .catch((e) => {
        if (!live) return;
        setState({ availability: 'error', tree: [], rows: [], error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [api, bookId]);

  return useMemo(() => state, [state]);
}
