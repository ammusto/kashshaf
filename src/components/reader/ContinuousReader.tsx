import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { perfMark, perfMeasure } from '../../utils/perf';
import type { PageEntry, Token } from '../../types';
import { PageView } from './PageView';
import { estimateHeight, indexAtOffset, spacerAfter, spacerBefore, type ScrollDirection } from '../../utils/pageWindow';
import type { PageStack } from '../../hooks/usePageStack';

/**
 * The scrolling column of pages.
 *
 * Only the pages near the one in view are mounted; everything above and below
 * is a spacer as tall as those pages were measured to be, so the scrollbar
 * stands for the whole book.
 *
 * There is one way the view moves: `goTo(index)`. Opening at a page, Go, a
 * clicked result and a contents entry all call it and nothing else, so there
 * is one rule to get right. Between those, the column scrolls: the wheel,
 * the arrow keys, the scrollbar. There are no Prev/Next buttons.
 *
 *  - **target mounted and measured**: one smooth scroll that puts the page's
 *    measured top at the top of the pane, with the gap above it showing.
 *    Nothing else happens — the window does not move until the scroll has
 *    landed, so the target cannot shift under it, and there is no pin
 *    adjustment or correction afterwards.
 *  - **target not mounted**: the window is mounted around it before the first
 *    paint, the spacer above sized by estimate, the page put at the top of
 *    the pane and pinned. No scroll. Nothing is followed until the page has
 *    loaded and been measured.
 *
 * In both cases the page under the top edge of the pane is the target on the
 * first settled frame. That is also how the page in view is *observed*: the
 * page under a probe just below the top edge, from the elements' own boxes.
 * Placement and observation use the same point, so they cannot disagree — a
 * midpoint rule disagreed with a top placement on every page shorter than
 * half the viewport, and the header and the view drifted apart.
 *
 * The visible content is pinned across every re-render: if the page in view
 * has moved because something above it mounted, unmounted or was measured,
 * the scroll position is corrected by exactly that much before paint. A
 * page that changes height after mounting (a ResizeObserver report) is
 * re-pinned synchronously, in the same frame, for the same reason.
 *
 * Scrolls the reader makes itself are not read back: an instant placement is
 * recognised by where it landed, a glide is flagged until it has landed.
 */

interface ContinuousReaderProps {
  stack: PageStack;
  /** Highlights for a page, by its spine index. */
  matchesFor: (index: number) => readonly number[];
  /** Whether a highlighted match runs off the top or the bottom of a page. */
  continuesFor?: (index: number) => { prev: boolean; next: boolean };
  onWordClick: (e: React.MouseEvent, token: Token) => void;
  /** Called with the page the reader is on whenever it changes. */
  onActivePage: (entry: PageEntry, index: number) => void;
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

/** What the header and the app drive. */
export interface ContinuousReaderHandle {
  /** The one way the view moves. */
  goTo: (index: number) => void;
}

/**
 * The gap between cards, in px (`pb-6` on each page, `pt-6` on the column).
 * A page is placed so that this much of the gap above it shows, and the
 * observation probe sits just inside the page below it.
 */
export const CARD_GAP = 24;

/** The longest a glide is given before the reader stops waiting for it. */
const GLIDE_MAX_MS = 1200;

/** A placement in progress: the target, until it has loaded and been measured. */
interface Placement {
  index: number;
}

export const ContinuousReader = forwardRef<ContinuousReaderHandle, ContinuousReaderProps>(function ContinuousReader(
  {
    stack,
    matchesFor,
    continuesFor,
    onWordClick,
    onActivePage,
    multiPart,
    onBackgroundClick,
  }: ContinuousReaderProps,
  ref
) {
  const { spine, mounted, pages, offsets, heights, measure, setAnchorIndex, setVisible, anchorIndex, request } = stack;
  const containerRef = useRef<HTMLDivElement>(null);
  const elements = useRef<Map<number, HTMLElement>>(new Map());
  const [placing, setPlacing] = useState<Placement | null>(null);
  /** The placement in progress, readable from the scroll handler without a render. */
  const placingRef = useRef<Placement | null>(null);
  placingRef.current = placing;
  /** A glide is in flight; its landing is being watched. */
  const gliding = useRef(false);
  const rafPending = useRef(false);
  /** The page in view and where its top sat, so a re-render can put it back. */
  const pinned = useRef<{ index: number; top: number } | null>(null);
  /** Where the reader last put the scroll itself, while that is still true. */
  const selfTop = useRef<number | null>(null);
  /** The scroll position last reported, for the direction of travel. */
  const lastTop = useRef(0);

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const isSelfScroll = (top: number) =>
    (selfTop.current !== null && Math.abs(top - selfTop.current) <= 2) || gliding.current;
  /** An instant scroll is over at once: only the event it caused is ignored. */
  const holdFrame = useCallback((expected: number) => {
    selfTop.current = expected;
    requestAnimationFrame(() => {
      selfTop.current = null;
    });
  }, []);

  // ---------------------------------------------------------------- geometry

  /** A page's top, in scroll-content coordinates, from its own box. */
  const topOf = useCallback((el: HTMLElement): number => {
    const c = containerRef.current!;
    return c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top;
  }, []);

  /**
   * The page in view: the mounted page under a probe just inside the top
   * edge of the pane, past the gap. `null` when the probe is over a spacer,
   * which a dragged scrollbar can do.
   */
  const pageAtTop = useCallback((): number | null => {
    const c = containerRef.current;
    if (!c) return null;
    const probe = c.getBoundingClientRect().top + CARD_GAP + 1;
    let below: { index: number; top: number } | null = null;
    for (const [index, el] of elements.current) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (probe >= r.top && probe < r.bottom) return index;
      // The probe is in the column's own top padding, above the first card.
      if (r.top > probe && (!below || r.top < below.top)) below = { index, top: r.top };
    }
    return below && below.top - probe <= CARD_GAP + 1 ? below.index : null;
  }, []);

  /**
   * Tell the stack which mounted pages are in the pane and which way the
   * reader is moving: that, plus one page on, is what it fetches.
   */
  const reportVisible = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const top = c.getBoundingClientRect().top;
    const bottom = top + c.clientHeight;
    const seen: number[] = [];
    for (const [index, el] of elements.current) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > top && r.top < bottom) seen.push(index);
    }
    seen.sort((a, b) => a - b);
    const direction: ScrollDirection = c.scrollTop < lastTop.current ? -1 : 1;
    lastTop.current = c.scrollTop;
    setVisible(seen, direction);
  }, [setVisible]);

  /** Remember where the page in view sits, so a re-render can put it back. */
  const pin = useCallback((index: number) => {
    const c = containerRef.current;
    const el = elements.current.get(index);
    if (!c || !el) return;
    pinned.current = { index, top: el.getBoundingClientRect().top - c.getBoundingClientRect().top };
  }, []);

  /**
   * Put the pinned page back where it was. Called before paint: from the
   * layout effect after every render, and synchronously from a resize
   * report, so a page that changed height after mounting moves nothing on
   * screen.
   */
  const repin = useCallback(() => {
    const c = containerRef.current;
    const keep = pinned.current;
    if (!c || !keep) return;
    const el = elements.current.get(keep.index);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - c.getBoundingClientRect().top - keep.top;
    if (Math.abs(delta) < 0.5) return;
    holdFrame(c.scrollTop + delta);
    c.scrollTop += delta;
  }, [holdFrame]);

  const registerPage = useCallback((index: number, el: HTMLElement | null) => {
    if (el) elements.current.set(index, el);
    else elements.current.delete(index);
  }, []);

  /** A page reported its height: record it, and hold the view still. */
  const onMeasure = useCallback(
    (index: number, height: number) => {
      measure(index, height);
      repin();
    },
    [measure, repin]
  );

  // ---------------------------------------------------------------- following

  const handleScroll = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const c = containerRef.current;
      if (!c || spine.length === 0) return;
      // Until a placement or a glide has landed nothing is followed: the
      // only scrolls are the reader's own.
      if (placingRef.current || gliding.current) return;
      if (isSelfScroll(c.scrollTop)) return;
      // Geometry first; the estimated offsets only answer for a fling that
      // has outrun the mounted window, where there is nothing to measure.
      const index = pageAtTop() ?? indexAtOffset(offsets, c.scrollTop + CARD_GAP + 1);
      setAnchorIndex(index);
      pin(index);
      reportVisible();
    });
    // `isSelfScroll` closes over refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsets, setAnchorIndex, spine.length, pageAtTop, pin, reportVisible]);

  // ---------------------------------------------------------------- goTo

  /** A glide to a mounted, measured page: one smooth scroll, then nothing. */
  const glideTo = useCallback(
    (target: number): boolean => {
      const c = containerRef.current;
      const el = elements.current.get(target);
      if (!c || !el) return false;
      const top = Math.max(0, topOf(el) - CARD_GAP);
      pinned.current = null;
      gliding.current = true;
      const started = now();
      const from = c.scrollTop;
      let last = from;
      let moved = false;
      let still = 0;
      c.scrollTo({ top, behavior: 'smooth' });
      // Landing is watched frame by frame: at the target, or no longer
      // moving after having moved, or out of time. Only then is the anchor
      // updated, so the window does not move under the glide.
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
        const observed = pageAtTop() ?? target;
        setAnchorIndex(observed);
        pin(observed);
      };
      requestAnimationFrame(tick);
      return true;
    },
    [topOf, pageAtTop, setAnchorIndex, pin]
  );

  /**
   * The one way the view moves. A mounted, measured target is glided to;
   * anything else is placed: the window mounted around it before paint, the
   * page at the top of the pane, pinned, no scroll.
   */
  const goTo = useCallback(
    (index: number) => {
      if (spine.length === 0) return;
      const target = Math.min(Math.max(index, 0), spine.length - 1);
      const ready = pages.has(target) && heights.has(target) && elements.current.has(target);
      if (ready && glideTo(target)) return;
      pinned.current = null;
      gliding.current = false;
      setAnchorIndex(target);
      setPlacing({ index: target });
    },
    [spine.length, pages, heights, glideTo, setAnchorIndex]
  );

  useImperativeHandle(ref, () => ({ goTo }), [goTo]);

  // --- a request from outside (opening at a page, a clicked result, a
  //     contents entry): goTo, like everything else
  useEffect(() => {
    if (!request) return;
    goTo(request.index);
    // The request's sequence number identifies a new one; goTo is read at
    // that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);

  // --- a placement: the page at the top of the pane before paint, kept
  //     there until it has loaded and been measured
  useLayoutEffect(() => {
    if (!placing) return;
    const c = containerRef.current;
    if (!c) return;
    if (placing.index < mounted.start || placing.index >= mounted.end) return;
    const target = elements.current.get(placing.index);
    if (!target) return;
    const top = Math.max(0, topOf(target) - CARD_GAP);
    if (Math.abs(top - c.scrollTop) > 0.5) {
      holdFrame(top);
      c.scrollTop = top;
    }
    pin(placing.index);
    if (pages.has(placing.index) && heights.has(placing.index)) {
      setPlacing(null);
      perfMark('reader:placed');
      perfMeasure('reader:click-to-placed', 'reader:click');
      // The frame after this commit is the first the page is painted in.
      requestAnimationFrame(() => {
        perfMark('reader:first-paint');
        perfMeasure('reader:click-to-first-paint', 'reader:click');
      });
    }
  }, [placing, pages, heights, mounted, topOf, holdFrame, pin]);

  // --- hold the visible content still across every re-render, and say
  //     what is in view now that it is
  useLayoutEffect(() => {
    repin();
    reportVisible();
  });

  // --- tell the rest of the app where the reader is
  //
  // During a placement the reader is, by definition, on the page it was asked
  // for; no frame in between is reported.
  const activeEntry = spine[anchorIndex];
  useEffect(() => {
    if (!activeEntry) return;
    if (placing && placing.index !== anchorIndex) return;
    onActivePage(activeEntry, anchorIndex);
  }, [activeEntry, anchorIndex, onActivePage, placing]);

  const before = spacerBefore(mounted, offsets);
  const after = spacerAfter(mounted, offsets);
  // A page not yet fetched stands at the height the offsets assume for it,
  // so what is below it does not move when it arrives.
  const placeholderHeight = Math.max(200, estimateHeight(heights) - CARD_GAP);

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
            style={{ minHeight: placeholderHeight }}
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
        continues={continuesFor?.(i)}
        label={pageLabel(entry, multiPart)}
        startsPart={startsPart}
        partLabel={entry.part_label ? `Part ${entry.part_label}` : `Part ${entry.part_index + 1}`}
        onWordClick={onWordClick}
        onMeasure={onMeasure}
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
