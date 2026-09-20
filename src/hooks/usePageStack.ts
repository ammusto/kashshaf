import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageEntry, Token } from '../types';
import type { SearchAPI } from '../api';
import type { HighlightRequest } from '../utils/highlightRequest';
import { perfMark, perfMeasure } from '../utils/perf';
import {
  cacheRange,
  evictable,
  pageOffsets,
  wantedFor,
  windowFor,
  type PageWindow,
  type ScrollDirection,
} from '../utils/pageWindow';

/** A page the reader has fetched: its place in the book, its text, its tokens, its highlights. */
export interface LoadedPage {
  entry: PageEntry;
  body: string;
  tokens: Token[];
  /** Token indices to mark, for the highlight request the page was fetched under; null when there was none. */
  matches: number[] | null;
  /** The `HighlightRequest.key` the page was fetched under; null when there was none. */
  highlightKey: string | null;
  /** A match runs in from the page before / out onto the page after. */
  continuesPrev: boolean;
  continuesNext: boolean;
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
  /** What to highlight on every page fetched: the running search's terms. */
  highlight?: HighlightRequest | null;
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
   * Which mounted pages are in the pane and which way it last moved. Only
   * these, and one page beyond them in that direction, are fetched: a
   * window of seven mounted pages is not seven requests.
   */
  setVisible: (indices: number[], direction: ScrollDirection) => void;
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

function sameIndices(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The reader's page stack: one book's spine, the pages loaded around the
 * one in view, and the measured heights that let the pages outside the
 * window be replaced by spacers of the right size.
 *
 * The spine (`list_book_pages`) is what makes this continuous rather than a
 * chain of neighbour lookups: it gives reading order across part boundaries,
 * which `page_id + 1` does not — 45 books restart their page ids in every
 * part — and it lets the scrollbar stand for the whole book from the start.
 *
 * A page is one request (`getPageBundle`): its text, its tokens and its
 * highlights for the running search together. Which pages are fetched is
 * decided by what the reader reports in view (`setVisible`), plus one page
 * ahead in the direction of travel; the rest of the mounted window stays a
 * placeholder until it is reached. Against the public API that is the
 * difference between a scroll and a rate limit.
 */
export function usePageStack({ api, bookId, anchor, highlight = null }: UsePageStackOptions): PageStack {
  const [spine, setSpine] = useState<PageEntry[]>([]);
  const [spineError, setSpineError] = useState<string | null>(null);
  const [loadingSpine, setLoadingSpine] = useState(false);
  const [pages, setPages] = useState<Map<number, LoadedPage>>(new Map());
  const [anchorIndex, setAnchorIndexState] = useState(0);
  const [request, setRequest] = useState<{ index: number; seq: number } | null>(null);
  const [heights, setHeights] = useState<Map<number, number>>(new Map());
  const [visible, setVisibleState] = useState<{ indices: number[]; direction: ScrollDirection }>({ indices: [], direction: 1 });

  // Which book/anchor the state belongs to, so a slow response for a book the
  // reader has left cannot overwrite the current one.
  const generation = useRef(0);
  const inFlight = useRef<Map<number, string | null>>(new Map());
  const requestedAnchor = useRef<PageAnchor | null>(null);
  /** The spine the requested anchor was last resolved against. */
  const resolvedAgainst = useRef<PageEntry[] | null>(null);
  const highlightKey = highlight?.key ?? null;

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
    setVisibleState({ indices: [], direction: 1 });
    setSpineError(null);
    setLoadingSpine(true);
    let cancelled = false;
    perfMark('reader:spine-fetch-start');
    api
      .listBookPages(bookId)
      .then((entries) => {
        if (cancelled || gen !== generation.current) return;
        perfMark('reader:spine-fetched');
        perfMeasure('reader:spine-fetch', 'reader:spine-fetch-start');
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
  const anchorIndexRef = useRef(anchorIndex);
  anchorIndexRef.current = anchorIndex;

  const setVisible = useCallback((indices: number[], direction: ScrollDirection) => {
    setVisibleState((prev) => (sameIndices(prev.indices, indices) && prev.direction === direction ? prev : { indices, direction }));
  }, []);

  // The pages worth fetching now: what is in view and one page on, or the
  // anchor page alone before the reader has reported anything.
  const wanted = useMemo(
    () => wantedFor(visible.indices.length > 0 ? visible.indices : [anchorIndex], visible.direction, mounted),
    [visible, anchorIndex, mounted]
  );

  // --- fetch what is wanted, drop what the window no longer covers
  useEffect(() => {
    if (bookId === null || spine.length === 0) return;
    const gen = generation.current;
    const keep = cacheRange(mounted, spine.length);

    for (const i of wanted) {
      const have = pages.get(i);
      // Loaded under the running search's terms: nothing to do. Loaded under
      // another search (or none), and still in view: asked for again, with
      // this search's highlights; the text stays up meanwhile.
      if (have && have.highlightKey === highlightKey) continue;
      if (inFlight.current.get(i) === highlightKey && inFlight.current.has(i)) continue;
      const entry = spine[i];
      if (!entry) continue;
      inFlight.current.set(i, highlightKey);
      const key = highlightKey;
      api
        .getPageBundle(bookId, entry.part_index, entry.page_id, {
          tokens: true,
          terms: highlight?.terms,
          namePatterns: highlight?.namePatterns,
        })
        .then((bundle) => {
          if (gen !== generation.current) return;
          if (!bundle) return;
          if (i === anchorIndexRef.current) {
            perfMark('reader:anchor-page-fetched');
            perfMeasure('reader:anchor-page-fetch', 'reader:spine-fetched');
          }
          setPages((prev) => {
            const next = new Map(prev);
            next.set(i, {
              entry,
              body: bundle.page.body ?? '',
              tokens: bundle.tokens,
              matches: bundle.matches,
              highlightKey: key,
              continuesPrev: bundle.continues_prev ?? false,
              continuesNext: bundle.continues_next ?? false,
            });
            return next;
          });
        })
        .catch(() => {
          /* one page failing leaves a gap; the rest of the book still reads */
        })
        .finally(() => {
          if (inFlight.current.get(i) === key) inFlight.current.delete(i);
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
    // `highlight` is read through its key; its arrays change identity with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, bookId, spine, mounted, pages, wanted, highlightKey]);

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
    setVisible,
    request,
    spineError,
    loadingSpine,
  };
}
