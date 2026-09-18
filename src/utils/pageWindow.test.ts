import { describe, it, expect } from 'vitest';
import {
  windowFor,
  cacheRange,
  estimateHeight,
  pageOffsets,
  spacerBefore,
  spacerAfter,
  indexAtOffset,
  evictable,
  MOUNTED_BEFORE,
  MOUNTED_AFTER,
  CACHE_MARGIN,
  DEFAULT_PAGE_HEIGHT,
} from './pageWindow';

describe('windowFor', () => {
  it('mounts at most 7 pages, centred on the page in view', () => {
    const w = windowFor(50, 200);
    expect(w).toEqual({ start: 47, end: 54 });
    expect(w.end - w.start).toBe(MOUNTED_BEFORE + MOUNTED_AFTER + 1);
  });

  it('clamps at both ends of the book', () => {
    expect(windowFor(0, 200)).toEqual({ start: 0, end: 4 });
    expect(windowFor(199, 200)).toEqual({ start: 196, end: 200 });
    expect(windowFor(1, 3)).toEqual({ start: 0, end: 3 });
  });

  it('is empty for a book with no pages', () => {
    expect(windowFor(0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('never mounts more than 7 pages anywhere in a 200-page book', () => {
    for (let a = 0; a < 200; a++) {
      const w = windowFor(a, 200);
      expect(w.end - w.start).toBeLessThanOrEqual(7);
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(200);
    }
  });
});

describe('cacheRange', () => {
  it('keeps a small margin around the window', () => {
    expect(cacheRange(windowFor(50, 200), 200)).toEqual({ start: 45, end: 56 });
  });

  it('stays a fixed size however far the reader scrolls', () => {
    for (const a of [0, 7, 99, 150, 199]) {
      const r = cacheRange(windowFor(a, 200), 200);
      expect(r.end - r.start).toBeLessThanOrEqual(MOUNTED_BEFORE + MOUNTED_AFTER + 1 + 2 * CACHE_MARGIN);
    }
  });
});

describe('heights and offsets', () => {
  it('assumes a default height until something has been measured', () => {
    expect(estimateHeight(new Map())).toBe(DEFAULT_PAGE_HEIGHT);
    expect(pageOffsets(3, new Map())).toEqual([0, 900, 1800, 2700]);
  });

  it('uses measured heights where it has them and the running mean elsewhere', () => {
    const heights = new Map([
      [0, 400],
      [1, 600],
    ]);
    expect(estimateHeight(heights)).toBe(500);
    // page 2 is unmeasured, so it counts as the mean of the two measured
    expect(pageOffsets(3, heights)).toEqual([0, 400, 1000, 1500]);
  });

  it('spacers and mounted pages add up to the whole book', () => {
    const heights = new Map([
      [0, 400],
      [1, 600],
      [2, 800],
      [3, 1000],
    ]);
    const offsets = pageOffsets(6, heights);
    const w = { start: 2, end: 4 };
    const mounted = heights.get(2)! + heights.get(3)!;
    expect(spacerBefore(w, offsets) + mounted + spacerAfter(w, offsets)).toBe(offsets[6]);
  });

  it('a measured page that leaves the window is replaced by a spacer of its own height', () => {
    // Everything above the viewport keeps its height, so the scroll position
    // does not jump when the window moves on.
    const heights = new Map([
      [0, 400],
      [1, 600],
      [2, 800],
    ]);
    const offsets = pageOffsets(5, heights);
    const before = spacerBefore({ start: 1, end: 3 }, offsets) + heights.get(1)!;
    const after = spacerBefore({ start: 2, end: 4 }, offsets);
    expect(after).toBe(before);
  });
});

describe('indexAtOffset', () => {
  const heights = new Map([
    [0, 400],
    [1, 600],
    [2, 800],
  ]);
  const offsets = pageOffsets(4, heights); // [0, 400, 1000, 1800, 2400]

  it('finds the page containing a pixel', () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 399)).toBe(0);
    expect(indexAtOffset(offsets, 400)).toBe(1);
    expect(indexAtOffset(offsets, 999)).toBe(1);
    expect(indexAtOffset(offsets, 1000)).toBe(2);
    expect(indexAtOffset(offsets, 1799)).toBe(2);
    expect(indexAtOffset(offsets, 1800)).toBe(3);
  });

  it('clamps outside the book', () => {
    expect(indexAtOffset(offsets, -50)).toBe(0);
    expect(indexAtOffset(offsets, 99999)).toBe(3);
    expect(indexAtOffset([0], 10)).toBe(0);
  });
});

describe('evictable', () => {
  it('names the loaded pages outside the range worth keeping', () => {
    expect(evictable([1, 2, 3, 40, 41], { start: 2, end: 41 })).toEqual([1, 41]);
  });
});

describe('scrolling a 200-page book', () => {
  it('keeps the mounted set and the page cache flat', () => {
    const count = 200;
    const heights = new Map<number, number>();
    const loaded = new Set<number>();
    let maxMounted = 0;
    let maxLoaded = 0;

    for (let anchor = 0; anchor < count; anchor++) {
      const w = windowFor(anchor, count);
      for (let i = w.start; i < w.end; i++) {
        loaded.add(i);
        // a page is measured while it is mounted
        heights.set(i, 700 + (i % 5) * 100);
      }
      for (const i of evictable(loaded, cacheRange(w, count))) loaded.delete(i);
      maxMounted = Math.max(maxMounted, w.end - w.start);
      maxLoaded = Math.max(maxLoaded, loaded.size);
    }

    expect(maxMounted).toBe(7);
    // Scrolling forward, the cache holds the 7 mounted pages and the 2 just
    // left behind; the margin ahead is there for a scroll back.
    expect(maxLoaded).toBe(9);
    expect(loaded.size).toBeLessThanOrEqual(MOUNTED_BEFORE + MOUNTED_AFTER + 1 + 2 * CACHE_MARGIN);
    // Only the heights survive the whole book: two numbers a page.
    expect(heights.size).toBe(200);
  });
});
