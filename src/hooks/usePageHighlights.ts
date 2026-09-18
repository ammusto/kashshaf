import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageEntry } from '../types';
import type { SearchAPI } from '../api';
import type { SearchContext } from '../types/search';
import { getSearchTermsFromContext } from './useReaderNavigation';

/** Wait after the last page mounts before asking for its highlights. */
export const HIGHLIGHT_DEBOUNCE_MS = 200;

/** Pages whose highlights are remembered. Far more than can be on screen. */
export const HIGHLIGHT_CACHE_LIMIT = 400;

export interface PageHighlights {
  /** Highlights for a page, or undefined while they are unknown. */
  matchesFor: (entry: PageEntry) => readonly number[] | undefined;
  /** Told which pages are mounted; fetches their highlights once scrolling settles. */
  onMountedPages: (entries: PageEntry[]) => void;
}

export interface UsePageHighlightsOptions {
  api: SearchAPI;
  bookId: number | null;
  /** The search the reader is reading under; null when none is running. */
  searchContext: SearchContext | null;
}

function pageKey(entry: PageEntry): string {
  return `${entry.part_index}:${entry.page_id}`;
}

/**
 * A string that changes exactly when the highlights would: the terms of the
 * running search. Cached highlights survive a re-render, a scroll and a tab
 * switch, and are dropped when the query or the book changes.
 */
export function queryKeyOf(context: SearchContext | null): string | null {
  if (!context) return null;
  if (context.type === 'name') {
    const patterns = context.namePatterns?.flat() ?? [];
    return patterns.length > 0 ? `name|${patterns.join('|')}` : null;
  }
  const terms = getSearchTermsFromContext(context);
  if (!terms || terms.length === 0) return null;
  return `${context.type}|${terms.map((t) => `${t.mode}:${t.query}`).join('|')}`;
}

/**
 * Highlights that follow the query rather than the click.
 *
 * The old reader highlighted the page whose result was clicked and nothing
 * else, so reading on from a hit meant the next pages appeared to have none.
 * Here every page that scrolls into view is asked about, so scrolling from a
 * hit on one page through a page with none to a hit three pages later shows
 * all of them, without any of those pages having been clicked or even having
 * been in the results list.
 *
 * The lookups are debounced: flinging through fifty pages asks about the
 * handful the reader stops on, not about every page it passed.
 */
export function usePageHighlights({ api, bookId, searchContext }: UsePageHighlightsOptions): PageHighlights {
  const queryKey = useMemo(() => queryKeyOf(searchContext), [searchContext]);
  const [matches, setMatches] = useState<Map<string, number[]>>(new Map());
  const pending = useRef<PageEntry[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  // What the cache is for; a response for anything else is dropped.
  const scope = useRef<{ bookId: number | null; queryKey: string | null }>({ bookId, queryKey });
  scope.current = { bookId, queryKey };

  // A different book or a different query means different highlights.
  useEffect(() => {
    setMatches(new Map());
    inFlight.current.clear();
    pending.current = [];
  }, [bookId, queryKey]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const fetchFor = useCallback(
    async (entries: PageEntry[]) => {
      const book = bookId;
      const key = queryKey;
      if (book === null || !key || !searchContext) return;
      const wanted = entries.filter((e) => {
        const k = pageKey(e);
        return !inFlight.current.has(k);
      });
      if (wanted.length === 0) return;

      await Promise.all(
        wanted.map(async (entry) => {
          const k = pageKey(entry);
          inFlight.current.add(k);
          try {
            let indices: number[] = [];
            if (searchContext.type === 'name' && searchContext.namePatterns) {
              indices = await api.getNameMatchPositions(
                book,
                entry.part_index,
                entry.page_id,
                searchContext.namePatterns.flat()
              );
            } else {
              const terms = getSearchTermsFromContext(searchContext);
              if (terms && terms.length > 0) {
                indices = await api.getMatchPositionsCombined(book, entry.part_index, entry.page_id, terms);
              }
            }
            // The reader may have moved to another book or search while this
            // was in the air.
            if (scope.current.bookId !== book || scope.current.queryKey !== key) return;
            setMatches((prev) => {
              const next = new Map(prev);
              next.set(k, indices);
              if (next.size > HIGHLIGHT_CACHE_LIMIT) {
                // Oldest first: a Map iterates in insertion order.
                const excess = next.size - HIGHLIGHT_CACHE_LIMIT;
                let dropped = 0;
                for (const old of next.keys()) {
                  if (dropped++ >= excess) break;
                  next.delete(old);
                }
              }
              return next;
            });
          } catch {
            /* a page whose highlights cannot be fetched renders plain */
          } finally {
            inFlight.current.delete(k);
          }
        })
      );
    },
    [api, bookId, queryKey, searchContext]
  );

  const onMountedPages = useCallback(
    (entries: PageEntry[]) => {
      pending.current = entries;
      if (!queryKey) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        // Only the pages the reader came to rest on, and only those not
        // already answered for.
        const todo = pending.current.filter((e) => !matches.has(pageKey(e)));
        if (todo.length > 0) void fetchFor(todo);
      }, HIGHLIGHT_DEBOUNCE_MS);
    },
    [fetchFor, matches, queryKey]
  );

  const matchesFor = useCallback(
    (entry: PageEntry): readonly number[] | undefined => {
      if (!queryKey) return undefined;
      return matches.get(pageKey(entry));
    },
    [matches, queryKey]
  );

  return { matchesFor, onMountedPages };
}
