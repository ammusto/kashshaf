import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageEntry, Token } from '../types';
import type { SearchAPI } from '../api';
import {
  cacheRange,
  evictable,
  pageOffsets,
  windowFor,
  type PageWindow,
} from '../utils/pageWindow';

/** A page the reader has fetched: its place in the book, its text, its tokens. */
export interface LoadedPage {
  entry: PageEntry;
  body: string;
  tokens: Token[];
}

export interface PageAnchor {
  part_index: number;
  page_id: number;
}

export interface UsePageStackOptions {
  api: SearchAPI;
  bookId: number | null;
  /** Where the reader should be: a clicked result, a jump, a Prev/Next step. */
  anchor: PageAnchor | null;
}

export interface PageStack {
  /** Every page of the book in reading order; empty until it arrives. */
  spine: PageEntry[];
  /** Index into `spine` of the page the reader is on. */
  anchorIndex: number;
  /** The mounted range. */
  mounted: PageWindow;
  /** Fetched pages by spine index. Only indices near the window survive. */
  pages: ReadonlyMap<number, LoadedPage>;
  /** Cumulative pixel offsets, one longer than `spine`. */
  offsets: number[];
  /** Measured heights by spine index; a page absent here is still an estimate. */
  heights: ReadonlyMap<number, number>;
  /** Record a rendered page's height so its spacer can stand in for it. */
  measure: (index: number, height: number) => void;
  /** Follow the reader: called as pages scroll past. Does not scroll anything. */
  setAnchorIndex: (index: number) => void;
  /**
   * The latest request from outside the reader — opening at a page, a
   * clicked result, a contents entry — resolved to a spine index. The reader
   * answers it with `goTo`; the stack does not move the anchor itself, since
   * whether that means a glide or a placement is the reader's decision.
   */
  request: { index: number; seq: number } | null;
  /** Set when the book's spine could not be fetched; the reader falls back to one page. */
  spineError: string | null;
  /** The spine is still being fetched. */
  loadingSpine: boolean;
}

function sameAnchor(a: PageAnchor | null, b: PageAnchor | null): boolean {
  return !!a && !!b && a.part_index === b.part_index && a.page_id === b.page_id;
}

function indexOfAnchor(spine: PageEntry[], anchor: PageAnchor | null): number {
  if (!anchor) return 0;
  const i = spine.findIndex((e) => e.part_index === anchor.part_index && e.page_id === anchor.page_id);
  return i >= 0 ? i : 0;
}

/**
 * The reader's page stack: one book's spine, a window of pages loaded around
 * the one in view, and the measured heights that let the pages outside the
 * window be replaced by spacers of the right size.
 *
 * The spine (`list_book_pages`) is what makes this continuous rather than a
 * chain of neighbour lookups: it gives reading order across part boundaries,
 * which `page_id + 1` does not — 45 books restart their page ids in every
 * part — and it lets the scrollbar stand for the whole book from the start.
 */
export function usePageStack({ api, bookId, anchor }: UsePageStackOptions): PageStack {
  const [spine, setSpine] = useState<PageEntry[]>([]);
  const [spineError, setSpineError] = useState<string | null>(null);
  const [loadingSpine, setLoadingSpine] = useState(false);
  const [pages, setPages] = useState<Map<number, LoadedPage>>(new Map());
  const [anchorIndex, setAnchorIndexState] = useState(0);
  const [request, setRequest] = useState<{ index: number; seq: number } | null>(null);
  const [heights, setHeights] = useState<Map<number, number>>(new Map());

  // Which book/anchor the state belongs to, so a slow response for a book the
  // reader has left cannot overwrite the current one.
  const generation = useRef(0);
  const inFlight = useRef<Set<number>>(new Set());
  const requestedAnchor = useRef<PageAnchor | null>(null);
  /** The spine the requested anchor was last resolved against. */
  const resolvedAgainst = useRef<PageEntry[] | null>(null);

  // --- the spine, once per book
  useEffect(() => {
    if (bookId === null) {
      setSpine([]);
      setPages(new Map());
      setHeights(new Map());
      setSpineError(null);
      return;
    }
    const gen = ++generation.current;
    inFlight.current.clear();
    setSpine([]);
    setPages(new Map());
    setHeights(new Map());
    setSpineError(null);
    setLoadingSpine(true);
    let cancelled = false;
    api
      .listBookPages(bookId)
      .then((entries) => {
        if (cancelled || gen !== generation.current) return;
        // Resolve the anchor in the same render the spine lands in. Setting
        // the spine alone would mount the first pages for one frame, and
        // that frame is reported upward as "the reader is on page 1" — from
        // which the requested page is a jump, and the tab's anchor and the
        // reader's chase each other.
        const at = indexOfAnchor(entries, requestedAnchor.current);
        resolvedAgainst.current = entries;
        setSpine(entries);
        // The window mounts around the requested page in this same render,
        // so no other page is ever mounted or reported on the way there.
        setAnchorIndexState(at);
        setRequest((r) => ({ index: at, seq: (r?.seq ?? 0) + 1 }));
      })
      .catch((err) => {
        if (cancelled || gen !== generation.current) return;
        // An older server has no /book/{id}/pages. The reader still works,
        // one page at a time, rather than showing nothing.
        setSpineError(String(err));
      })
      .finally(() => {
        if (!cancelled && gen === generation.current) setLoadingSpine(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, bookId]);

  // --- an anchor from outside (clicked result, jump, Prev/Next) moves the stack
  useEffect(() => {
    if (!anchor) return;
    // Re-resolve when the anchor itself changed, and also when the spine
    // arrived after it: until then the anchor could only resolve to 0.
    if (sameAnchor(requestedAnchor.current, anchor) && resolvedAgainst.current === spine) return;
    requestedAnchor.current = anchor;
    resolvedAgainst.current = spine;
    if (spine.length === 0) return; // resolved when the spine lands
    const at = indexOfAnchor(spine, anchor);
    setRequest((r) => ({ index: at, seq: (r?.seq ?? 0) + 1 }));
  }, [anchor, spine]);

  const mounted = useMemo(() => windowFor(anchorIndex, spine.length), [anchorIndex, spine.length]);

  // --- fetch what the window needs, drop what it no longer does
  useEffect(() => {
    if (bookId === null || spine.length === 0) return;
    const gen = generation.current;
    const keep = cacheRange(mounted, spine.length);

    for (let i = mounted.start; i < mounted.end; i++) {
      if (pages.has(i) || inFlight.current.has(i)) continue;
      const entry = spine[i];
      inFlight.current.add(i);
      Promise.all([
        api.getPage(bookId, entry.part_index, entry.page_id),
        api.getPageTokens(bookId, entry.part_index, entry.page_id),
      ])
        .then(([page, tokens]) => {
          if (gen !== generation.current) return;
          if (!page) return;
          setPages((prev) => {
            // Between the request and the response the window may have moved
            // past this page; do not resurrect it.
            const next = new Map(prev);
            next.set(i, { entry, body: page.body ?? '', tokens });
            return next;
          });
        })
        .catch(() => {
          /* one page failing leaves a gap; the rest of the book still reads */
        })
        .finally(() => {
          inFlight.current.delete(i);
        });
    }

    const stale = evictable(pages.keys(), keep);
    if (stale.length > 0) {
      setPages((prev) => {
        const next = new Map(prev);
        for (const i of stale) next.delete(i);
        return next;
      });
    }
  }, [api, bookId, spine, mounted, pages]);

  const offsets = useMemo(() => pageOffsets(spine.length, heights), [spine.length, heights]);

  const measure = useCallback((index: number, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    setHeights((prev) => {
      const known = prev.get(index);
      // Ignore sub-pixel churn: re-measuring on every resize observation
      // would rebuild the offsets array for nothing.
      if (known !== undefined && Math.abs(known - height) < 1) return prev;
      const next = new Map(prev);
      next.set(index, height);
      return next;
    });
  }, []);

  const setAnchorIndex = useCallback(
    (index: number) => {
      setAnchorIndexState((prev) => {
        const clamped = Math.min(Math.max(index, 0), Math.max(0, spine.length - 1));
        if (clamped === prev) return prev;
        // The reader moved itself: remember where it is so the anchor prop
        // catching up later is not mistaken for a jump.
        const entry = spine[clamped];
        if (entry) requestedAnchor.current = { part_index: entry.part_index, page_id: entry.page_id };
        return clamped;
      });
    },
    [spine]
  );

  return {
    spine,
    anchorIndex,
    mounted,
    pages,
    offsets,
    heights,
    measure,
    setAnchorIndex,
    request,
    spineError,
    loadingSpine,
  };
}
