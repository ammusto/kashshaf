/**
 * The arithmetic behind the reader's continuous scroll, with no DOM in it.
 *
 * The reader shows one book as a single scrolling column, but mounts only a
 * few pages of it. Two things have to agree for that to feel like one
 * document:
 *
 *  - **the window**: which pages are mounted (a few around the one in view);
 *  - **the spacers**: the height of everything above and below them.
 *
 * A page's height is known only once it has been rendered and measured, so
 * `heights` fills in as the reader is used and every unmeasured page counts
 * as the running mean. Because a page is measured *before* it is unmounted,
 * the spacer that replaces it is exactly as tall as it was: content above the
 * viewport keeps its total height, and the scroll position does not jump.
 */

/** Pages mounted before and after the one in view (so at most 7). */
export const MOUNTED_BEFORE = 3;
export const MOUNTED_AFTER = 3;

/**
 * Pages kept loaded outside the mounted window. A small margin means a
 * one-page scroll back does not refetch, while the cache stays a fixed size
 * however far the reader scrolls.
 */
export const CACHE_MARGIN = 2;

/** Height assumed for a page nothing has measured yet, in px. */
export const DEFAULT_PAGE_HEIGHT = 900;

export interface PageWindow {
  /** First mounted index, inclusive. */
  start: number;
  /** Last mounted index, exclusive. */
  end: number;
}

/** The mounted window around `anchor`, clamped to the book. */
export function windowFor(anchor: number, count: number): PageWindow {
  if (count <= 0) return { start: 0, end: 0 };
  const a = Math.min(Math.max(anchor, 0), count - 1);
  return {
    start: Math.max(0, a - MOUNTED_BEFORE),
    end: Math.min(count, a + MOUNTED_AFTER + 1),
  };
}

/** Indices worth keeping loaded for `window`: the window plus a small margin. */
export function cacheRange(w: PageWindow, count: number): PageWindow {
  return {
    start: Math.max(0, w.start - CACHE_MARGIN),
    end: Math.min(count, w.end + CACHE_MARGIN),
  };
}

/** The height to assume for a page that has not been measured. */
export function estimateHeight(heights: ReadonlyMap<number, number>): number {
  if (heights.size === 0) return DEFAULT_PAGE_HEIGHT;
  let sum = 0;
  for (const h of heights.values()) sum += h;
  return sum / heights.size;
}

/**
 * Cumulative pixel offsets: `offsets[i]` is the height of pages before `i`,
 * and `offsets[count]` is the whole book. Measured heights are used where
 * they exist and the running mean everywhere else, so the scrollbar is
 * roughly honest from the first page and exact behind the reader.
 */
export function pageOffsets(count: number, heights: ReadonlyMap<number, number>): number[] {
  const estimate = estimateHeight(heights);
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i++) {
    offsets[i + 1] = offsets[i] + (heights.get(i) ?? estimate);
  }
  return offsets;
}

/** Height of the spacer standing in for the pages before the window. */
export function spacerBefore(w: PageWindow, offsets: number[]): number {
  return offsets[Math.min(w.start, offsets.length - 1)] ?? 0;
}

/** Height of the spacer standing in for the pages after the window. */
export function spacerAfter(w: PageWindow, offsets: number[]): number {
  const total = offsets[offsets.length - 1] ?? 0;
  return Math.max(0, total - (offsets[Math.min(w.end, offsets.length - 1)] ?? total));
}

/**
 * The page containing pixel `y`, by binary search over `offsets`. Used to
 * re-anchor after a scroll that moved faster than the mounted window — a
 * dragged scrollbar can land in a stretch where nothing is mounted, and no
 * observer would fire there.
 */
export function indexAtOffset(offsets: number[], y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (y <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Keys of `loaded` that fall outside the range worth keeping. */
export function evictable(loaded: Iterable<number>, keep: PageWindow): number[] {
  const out: number[] = [];
  for (const i of loaded) {
    if (i < keep.start || i >= keep.end) out.push(i);
  }
  return out;
}
