import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PageEntry, Token } from '../../types';
import { PageView } from './PageView';
import { indexAtOffset, spacerAfter, spacerBefore } from '../../utils/pageWindow';
import type { PageStack } from '../../hooks/usePageStack';

/**
 * The scrolling column of pages.
 *
 * Only the pages near the one in view are mounted; everything above and below
 * is a spacer as tall as those pages were measured to be, so the scrollbar
 * stands for the whole book.
 *
 * Three rules keep that from oscillating, which it did when the window
 * followed an intersection ratio:
 *
 *  1. **The page in view is the page under the viewport's midpoint**, by the
 *     elements' own geometry. A ratio picks the page that fills the observed
 *     band best, so a page taller than the viewport — which can never fill
 *     it — loses to a short neighbour, the window shifts, and the shift
 *     brings the tall page back: a loop with nothing to settle it.
 *  2. **The visible content is pinned across every re-render.** Before the
 *     browser paints, the page that was under the midpoint is put back where
 *     it was, whatever mounting, unmounting or measuring did to the spacers
 *     above it. Measured spacers alone are not enough: a page's height is
 *     only known after its first render.
 *  3. **Scrolls the reader makes itself are not read back.** A programmatic
 *     scroll raises a flag for as long as it takes to land, and scroll events
 *     are ignored while it is up, so a jump cannot be mistaken for the user
 *     scrolling somewhere and re-anchored out from under itself.
 */

interface ContinuousReaderProps {
  stack: PageStack;
  /** Highlights for a page, by its spine index. */
  matchesFor: (index: number) => readonly number[];
  onWordClick: (e: React.MouseEvent, token: Token) => void;
  /** Called with the page the reader is on whenever it changes. */
  onActivePage: (entry: PageEntry, index: number) => void;
  /** Called with the mounted pages, so their highlights can be fetched. */
  onMountedPages?: (entries: PageEntry[]) => void;
  /** Single-part books print the page number alone. */
  multiPart: boolean;
  onBackgroundClick?: () => void;
}

/** The page label as the book prints it: `1:24` in a multi-part book, `24` in one part. */
export function pageLabel(entry: PageEntry, multiPart: boolean): string {
  if (!multiPart) return entry.page_number || String(entry.page_id);
  const part = entry.part_label || String(entry.part_index + 1);
  return `${part}:${entry.page_number || entry.page_id}`;
}

export interface ScrollTarget {
  index: number;
  smooth: boolean;
}

/** What the header's Prev/Next and Go drive. */
export interface ContinuousReaderHandle {
  /** Move one page and glide there. */
  step: (direction: number) => void;
  /** Put this spine index at the top of the viewport. */
  jumpTo: (index: number) => void;
}

/**
 * How long a *smooth* scroll the reader makes itself is given to land. An
 * instant one is over within the frame, and suppressing longer than that
 * would swallow the user's own next scroll.
 */
const SETTLE_SMOOTH_MS = 700;

export const ContinuousReader = forwardRef<ContinuousReaderHandle, ContinuousReaderProps>(function ContinuousReader(
  {
    stack,
    matchesFor,
    onWordClick,
    onActivePage,
    onMountedPages,
    multiPart,
    onBackgroundClick,
  }: ContinuousReaderProps,
  ref
) {
  const { spine, mounted, pages, offsets, measure, setAnchorIndex, anchorIndex, scrollRequest } = stack;
  const containerRef = useRef<HTMLDivElement>(null);
  const elements = useRef<Map<number, HTMLElement>>(new Map());
  const [pending, setPending] = useState<ScrollTarget | null>(null);
  const rafPending = useRef(false);
  /** Until when scrolls are the reader's own doing and must not be read back. */
  const settleUntil = useRef(0);
  /** The page under the midpoint and where it sat, so it can be put back. */
  const pinned = useRef<{ index: number; top: number } | null>(null);

  /** Where the reader last put the scroll itself, while that is still true. */
  const selfTop = useRef<number | null>(null);

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /**
   * Is this scroll event the reader's own?
   *
   * An instant scroll is recognised by where it landed, not by when: a user
   * scroll in the same frame lands somewhere else, and ignoring it would
   * lose it — there is no second event to catch up on. A glide is
   * recognised by time, because every position it passes through is its own.
   */
  const isSelfScroll = (top: number) =>
    (selfTop.current !== null && Math.abs(top - selfTop.current) <= 2) || now() < settleUntil.current;
  /** An instant scroll is over at once: only the event it caused is ignored. */
  const holdFrame = useCallback((expected: number) => {
    selfTop.current = expected;
    requestAnimationFrame(() => {
      selfTop.current = null;
    });
  }, []);
  /** A glide takes time, and every position it passes would re-anchor. */
  const holdStill = useCallback((ms: number) => {
    settleUntil.current = Math.max(settleUntil.current, now() + ms);
  }, []);

  /**
   * The mounted page under the viewport's midpoint, from the elements' own
   * boxes. `null` when the midpoint is over a spacer, which a fling can do.
   */
  const pageAtMidpoint = useCallback((): number | null => {
    const c = containerRef.current;
    if (!c) return null;
    const box = c.getBoundingClientRect();
    const mid = box.top + box.height / 2;
    let best: { index: number; distance: number } | null = null;
    for (const [index, el] of elements.current) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (mid >= r.top && mid < r.bottom) return index;
      // Nothing is under the midpoint (a gap between cards): take the nearest.
      const distance = mid < r.top ? r.top - mid : mid - r.bottom;
      if (!best || distance < best.distance) best = { index, distance };
    }
    return best && best.distance < 64 ? best.index : null;
  }, []);

  /** Remember where the page in view sits, so a re-render can put it back. */
  const pin = useCallback(
    (index: number | null) => {
      const c = containerRef.current;
      if (!c || index === null) return;
      const el = elements.current.get(index);
      if (!el) return;
      pinned.current = { index, top: el.getBoundingClientRect().top - c.getBoundingClientRect().top };
    },
    []
  );

  const registerPage = useCallback((index: number, el: HTMLElement | null) => {
    if (el) elements.current.set(index, el);
    else elements.current.delete(index);
  }, []);

  // --- following the reader
  const handleScroll = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const c = containerRef.current;
      if (!c || spine.length === 0) return;
      if (isSelfScroll(c.scrollTop)) return;
      // Geometry first; the estimated offsets only answer for a fling that
      // has outrun the mounted window, where there is nothing to measure.
      const index = pageAtMidpoint() ?? indexAtOffset(offsets, c.scrollTop + c.clientHeight / 2);
      setAnchorIndex(index);
      pin(index);
    });
    // `isSelfScroll` and `now` are stable closures over refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsets, setAnchorIndex, spine.length, pageAtMidpoint, pin]);

  // --- hold the visible content still across every re-render
  //
  // Runs after the DOM is updated and before the browser paints. If the page
  // that was under the midpoint has moved — a page above it mounted, was
  // unmounted, or was measured for the first time — the scroll position is
  // corrected by exactly that much, so nothing on screen appears to move.
  useLayoutEffect(() => {
    const c = containerRef.current;
    const keep = pinned.current;
    if (!c || !keep) return;
    const el = elements.current.get(keep.index);
    if (!el) return;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top;
    const delta = top - keep.top;
    if (Math.abs(delta) < 0.5) return;
    holdFrame(c.scrollTop + delta);
    c.scrollTop += delta;
  });

  // --- something outside the reader moved the anchor: scroll there
  useEffect(() => {
    if (scrollRequest === 0) return;
    setPending({ index: anchorIndex, smooth: false });
    // anchorIndex is read once, when the request is made; following it here
    // would re-scroll on every page the reader passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  const step = useCallback(
    (direction: number) => {
      const next = Math.min(Math.max(anchorIndex + direction, 0), Math.max(0, spine.length - 1));
      if (next === anchorIndex) return;
      setAnchorIndex(next);
      setPending({ index: next, smooth: true });
    },
    [anchorIndex, spine.length, setAnchorIndex]
  );

  const jumpTo = useCallback(
    (index: number) => {
      setAnchorIndex(index);
      setPending({ index, smooth: false });
    },
    [setAnchorIndex]
  );

  useImperativeHandle(ref, () => ({ step, jumpTo }), [step, jumpTo]);

  // --- carry out a pending scroll, and keep carrying it out until the target
  //     page is really there: before it loads we can only scroll to its
  //     estimated offset, and measuring it moves everything below.
  useLayoutEffect(() => {
    if (!pending) return;
    const c = containerRef.current;
    if (!c) return;
    // The reader has scrolled somewhere else since, or the page never
    // loaded: stop chasing it.
    if (pending.index < mounted.start || pending.index >= mounted.end) {
      setPending(null);
      return;
    }
    // A scroll the reader is making itself: do not read it back as the user
    // moving, and do not let the pin drag it back to where it started.
    pinned.current = null;
    const target = elements.current.get(pending.index);
    if (target) {
      const box = c.getBoundingClientRect();
      const first = target.querySelector<HTMLElement>('[data-highlight-first="true"]');
      const anchorEl = first ?? target;
      const within = anchorEl.getBoundingClientRect().top - box.top;
      const top = Math.max(0, c.scrollTop + within - (first ? c.clientHeight / 3 : 0));
      if (pending.smooth) holdStill(SETTLE_SMOOTH_MS);
      else holdFrame(top);
      c.scrollTo({ top, behavior: pending.smooth ? 'smooth' : 'auto' });
      // Only a loaded page settles the scroll; a placeholder will still grow.
      if (pages.has(pending.index)) {
        setPending(null);
        pin(pending.index);
      }
    } else {
      const top = offsets[pending.index] ?? 0;
      holdFrame(top);
      c.scrollTo({ top, behavior: 'auto' });
    }
  }, [pending, pages, offsets, mounted, holdStill, holdFrame, pin]);

  // --- tell the rest of the app where the reader is
  const activeEntry = spine[anchorIndex];
  useEffect(() => {
    if (activeEntry) onActivePage(activeEntry, anchorIndex);
  }, [activeEntry, anchorIndex, onActivePage]);

  const mountedEntries = useMemo(() => {
    const out: PageEntry[] = [];
    for (let i = mounted.start; i < mounted.end; i++) {
      if (spine[i]) out.push(spine[i]);
    }
    return out;
  }, [spine, mounted]);

  useEffect(() => {
    onMountedPages?.(mountedEntries);
  }, [mountedEntries, onMountedPages]);

  const before = spacerBefore(mounted, offsets);
  const after = spacerAfter(mounted, offsets);

  const items: React.ReactNode[] = [];
  for (let i = mounted.start; i < mounted.end; i++) {
    const entry = spine[i];
    if (!entry) continue;
    const loaded = pages.get(i);
    const startsPart = i > 0 && spine[i - 1].part_index !== entry.part_index;
    if (!loaded) {
      items.push(
        <div key={`${entry.part_index}:${entry.page_id}`} data-page-index={i} ref={(el) => registerPage(i, el)} className="pb-6">
          <div
            className="bg-app-surface border border-app-border-light rounded-lg shadow-app-sm
                       px-10 py-12 text-sm text-app-text-tertiary"
            style={{ minHeight: 200 }}
          >
            Loading {pageLabel(entry, multiPart)}…
          </div>
        </div>
      );
      continue;
    }
    items.push(
      <PageView
        key={`${entry.part_index}:${entry.page_id}`}
        index={i}
        body={loaded.body}
        tokens={loaded.tokens}
        matched={matchesFor(i)}
        label={pageLabel(entry, multiPart)}
        startsPart={startsPart}
        partLabel={entry.part_label ? `Part ${entry.part_label}` : `Part ${entry.part_index + 1}`}
        onWordClick={onWordClick}
        onMeasure={measure}
        onMount={registerPage}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onClick={onBackgroundClick}
      className="flex-1 overflow-y-auto bg-app-bg"
      data-testid="reader-scroll"
    >
      {/* Each card carries its own gap below it (PageView's `pb-6`), so a
          spacer is exactly as tall as the pages it stands in for. */}
      <div className="max-w-4xl mx-auto px-6 pt-6">
        <div style={{ height: before }} aria-hidden data-testid="spacer-before" />
        {items}
        <div style={{ height: after }} aria-hidden data-testid="spacer-after" />
      </div>
    </div>
  );
});
