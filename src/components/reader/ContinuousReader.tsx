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
 *  3. **Scrolls the reader makes itself are not read back.** A glide (Prev,
 *     Next) raises a flag until it has landed, and scroll events are ignored
 *     while it is up; landing is watched frame by frame, and the page in
 *     view is then read from the geometry, never assumed.
 *  4. **A jump is a placement, not a scroll.** Opening at a page, Go, a
 *     clicked result: the window is mounted centred on that page, the spacer
 *     above it is sized by estimate, and the page is pinned at the top of the
 *     viewport before the first paint. Nothing is followed until that page
 *     has loaded and been measured, so the estimate being wrong moves the
 *     spacer, not the reader. Opening at page 36 used to start at page 1 and
 *     scroll to a guess, then re-anchor as pages measured — and the frame at
 *     page 1 was reported upward and came back as a jump to page 1.
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

/** Where the reader has been told to be. */
interface Jump {
  index: number;
}

/** What the header's Prev/Next and Go drive. */
export interface ContinuousReaderHandle {
  /** Move one page and glide there. */
  step: (direction: number) => void;
  /** Put this spine index at the top of the viewport. */
  jumpTo: (index: number) => void;
}

/** The longest a glide is given before the reader stops waiting for it. */
const GLIDE_MAX_MS = 1200;

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
  const { spine, mounted, pages, offsets, heights, measure, setAnchorIndex, anchorIndex, scrollRequest } = stack;
  const containerRef = useRef<HTMLDivElement>(null);
  const elements = useRef<Map<number, HTMLElement>>(new Map());
  const [jump, setJump] = useState<Jump | null>(null);
  /** The jump in progress, readable from the scroll handler without a render. */
  const jumping = useRef<Jump | null>(null);
  jumping.current = jump;
  /** A glide (Prev/Next) is in flight; its landing is being watched. */
  const gliding = useRef(false);
  const rafPending = useRef(false);
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
   * lose it — there is no second event to catch up on. A glide is every
   * position between where it started and where it lands, and is flagged
   * for exactly as long as it is in flight.
   */
  const isSelfScroll = (top: number) =>
    (selfTop.current !== null && Math.abs(top - selfTop.current) <= 2) || gliding.current;
  /** An instant scroll is over at once: only the event it caused is ignored. */
  const holdFrame = useCallback((expected: number) => {
    selfTop.current = expected;
    requestAnimationFrame(() => {
      selfTop.current = null;
    });
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
      // Until a jump or a glide has landed nothing is followed: the only
      // scrolls are the reader's own.
      if (jumping.current || gliding.current) return;
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

  // --- something outside the reader moved the anchor: a jump, not a scroll
  useEffect(() => {
    if (scrollRequest === 0) return;
    pinned.current = null;
    gliding.current = false;
    setJump({ index: anchorIndex });
    // anchorIndex is read once, when the request is made; following it here
    // would re-place on every page the reader passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  const jumpTo = useCallback(
    (index: number) => {
      pinned.current = null;
      gliding.current = false;
      setAnchorIndex(index);
      setJump({ index });
    },
    [setAnchorIndex]
  );

  /**
   * A glide to a mounted, measured page: a smooth scroll that puts its
   * measured top at the top of the viewport. The window does not move while
   * it is in flight (the anchor is only updated on landing), so the target
   * cannot shift under it. Landing is watched frame by frame — at the
   * target, or no longer moving after having moved, or out of time — and
   * then the page in view is read from the geometry. If the glide did not
   * land where it aimed, that is what the header will say.
   */
  const glideTo = useCallback(
    (target: number): boolean => {
      const c = containerRef.current;
      const el = elements.current.get(target);
      if (!c || !el) return false;
      const top = Math.max(0, c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top);
      pinned.current = null;
      gliding.current = true;
      const started = now();
      const from = c.scrollTop;
      let last = from;
      let moved = false;
      let still = 0;
      c.scrollTo({ top, behavior: 'smooth' });
      const tick = () => {
        const cur = containerRef.current;
        if (!cur || !gliding.current) {
          gliding.current = false;
          return;
        }
        const at = cur.scrollTop;
        if (Math.abs(at - from) > 0.5) moved = true;
        still = Math.abs(at - last) < 0.5 ? still + 1 : 0;
        last = at;
        const landed = Math.abs(at - top) <= 1 || (moved && still >= 3) || now() - started > GLIDE_MAX_MS;
        if (!landed) {
          requestAnimationFrame(tick);
          return;
        }
        gliding.current = false;
        const observed = pageAtMidpoint() ?? target;
        setAnchorIndex(observed);
        pin(observed);
      };
      requestAnimationFrame(tick);
      return true;
    },
    [pageAtMidpoint, setAnchorIndex, pin]
  );

  /**
   * Prev/Next: one page from the page in view — the one under the midpoint,
   * read from the geometry, never a counter of presses. A mounted, measured
   * target is glided to; anything else is a jump, which mounts the window
   * around it and places it without a scroll.
   */
  const step = useCallback(
    (direction: number) => {
      if (spine.length === 0) return;
      const from = pageAtMidpoint() ?? anchorIndex;
      const target = Math.min(Math.max(from + direction, 0), spine.length - 1);
      if (target === from) return;
      const ready = pages.has(target) && heights.has(target) && elements.current.has(target);
      if (ready && glideTo(target)) return;
      jumpTo(target);
    },
    [spine.length, pageAtMidpoint, anchorIndex, pages, heights, glideTo, jumpTo]
  );

  useImperativeHandle(ref, () => ({ step, jumpTo }), [step, jumpTo]);

  // --- a jump: place the page at the top of the viewport before paint, and
  //     keep it there until it has loaded and been measured
  //
  // Runs on every render while a jump is open. The first render after the
  // request has the window mounted around the target and the spacer above it
  // sized by estimate; the page is put at the top and pinned, so from here on
  // the pin effect below keeps it there while the pages around it mount and
  // measure. Only a loaded, measured target settles the jump: until then the
  // element is a placeholder that will change height.
  useLayoutEffect(() => {
    if (!jump) return;
    const c = containerRef.current;
    if (!c) return;
    // The window is not around the target yet (the stack has not caught up).
    if (jump.index < mounted.start || jump.index >= mounted.end) return;
    const target = elements.current.get(jump.index);
    if (!target) return;
    const box = c.getBoundingClientRect();
    const first = target.querySelector<HTMLElement>('[data-highlight-first="true"]');
    const anchorEl = first ?? target;
    const within = anchorEl.getBoundingClientRect().top - box.top;
    const top = Math.max(0, c.scrollTop + within - (first ? c.clientHeight / 3 : 0));
    if (Math.abs(top - c.scrollTop) > 0.5) {
      holdFrame(top);
      c.scrollTop = top;
    }
    pin(jump.index);
    if (pages.has(jump.index) && heights.has(jump.index)) {
      // Landed. The pin holds it from here; nothing else needs to move.
      setJump(null);
    }
  }, [jump, pages, heights, mounted, holdFrame, pin]);

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

  // --- tell the rest of the app where the reader is
  //
  // During a jump the reader is, by definition, on the page it was asked for;
  // no frame in between is reported, so the tab cannot be told "page 1" on
  // the way to page 36 and hand that back as a jump to page 1.
  const activeEntry = spine[anchorIndex];
  useEffect(() => {
    if (!activeEntry) return;
    if (jump && jump.index !== anchorIndex) return;
    onActivePage(activeEntry, anchorIndex);
  }, [activeEntry, anchorIndex, onActivePage, jump]);

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
            className="bg-app-surface border border-app-border-light rounded shadow-app-sm
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
