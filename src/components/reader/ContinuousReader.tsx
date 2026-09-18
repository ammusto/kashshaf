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
 * stands for the whole book and the position never jumps when the window
 * moves on.
 *
 * Which page the reader is on is decided by an IntersectionObserver over a
 * band across the middle of the viewport: the page crossing that band is the
 * one whose label, citation and highlights are current. A dragged scrollbar
 * can land where nothing is mounted and no observer would fire, so the scroll
 * handler re-anchors from the offsets as well.
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

export const ContinuousReader = forwardRef<ContinuousReaderHandle, ContinuousReaderProps>(function ContinuousReader({
  stack,
  matchesFor,
  onWordClick,
  onActivePage,
  onMountedPages,
  multiPart,
  onBackgroundClick,
}: ContinuousReaderProps, ref) {
  const { spine, mounted, pages, offsets, measure, setAnchorIndex, anchorIndex, scrollRequest } = stack;
  const containerRef = useRef<HTMLDivElement>(null);
  const elements = useRef<Map<number, HTMLElement>>(new Map());
  const observer = useRef<IntersectionObserver | null>(null);
  const [pending, setPending] = useState<ScrollTarget | null>(null);
  const rafPending = useRef(false);

  // --- the page crossing the middle band is the page the reader is on
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const root = containerRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        // A scroll in progress is authoritative about where it is going;
        // let it finish before following the pages it passes.
        let best: { index: number; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const index = Number((e.target as HTMLElement).dataset.pageIndex);
          if (!Number.isFinite(index)) continue;
          if (!best || e.intersectionRatio > best.ratio) best = { index, ratio: e.intersectionRatio };
        }
        if (best) setAnchorIndex(best.index);
      },
      { root, rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );
    observer.current = io;
    for (const el of elements.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [setAnchorIndex]);

  const registerPage = useCallback((index: number, el: HTMLElement | null) => {
    const known = elements.current.get(index);
    if (known && observer.current) observer.current.unobserve(known);
    if (el) {
      elements.current.set(index, el);
      observer.current?.observe(el);
    } else {
      elements.current.delete(index);
    }
  }, []);

  // --- a fling can outrun the mounted window; the offsets always know where we are
  const handleScroll = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const el = containerRef.current;
      if (!el || spine.length === 0) return;
      setAnchorIndex(indexAtOffset(offsets, el.scrollTop + el.clientHeight / 2));
    });
  }, [offsets, setAnchorIndex, spine.length]);

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
    const el = containerRef.current;
    if (!el) return;
    // The reader has scrolled somewhere else since, or the page never
    // loaded: stop chasing it.
    if (pending.index < mounted.start || pending.index >= mounted.end) {
      setPending(null);
      return;
    }
    const target = elements.current.get(pending.index);
    if (target) {
      const first = target.querySelector<HTMLElement>('[data-highlight-first="true"]');
      const top = first
        ? first.offsetTop - el.clientHeight / 3
        : target.offsetTop;
      el.scrollTo({ top: Math.max(0, top), behavior: pending.smooth ? 'smooth' : 'auto' });
      // Only a loaded page settles the scroll; an empty placeholder will move.
      if (pages.has(pending.index)) setPending(null);
    } else {
      el.scrollTo({ top: offsets[pending.index] ?? 0, behavior: 'auto' });
    }
  }, [pending, pages, offsets, mounted]);

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
        <div
          key={`${entry.part_index}:${entry.page_id}`}
          data-page-index={i}
          ref={(el) => registerPage(i, el)}
          className="px-16 py-12 text-sm text-app-text-tertiary"
          style={{ minHeight: 200 }}
        >
          Loading {pageLabel(entry, multiPart)}…
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
      className="flex-1 overflow-y-auto bg-white"
      data-testid="reader-scroll"
    >
      <div className="max-w-4xl mx-auto">
        <div style={{ height: before }} aria-hidden />
        {items}
        <div style={{ height: after }} aria-hidden />
      </div>
    </div>
  );
});
