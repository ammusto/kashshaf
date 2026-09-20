import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { PageBundleRequest, SearchAPI } from '../../api';

/**
 * Give a mocked API the one call the reader makes per page, composed from
 * the three it mocks — so a test's `getPage` counts and bodies still hold,
 * and its `getMatchPositionsCombined` can be asserted on.
 */
export function withPageBundle<T extends object>(api: T): T & SearchAPI {
  const a = api as unknown as SearchAPI & Record<string, unknown>;
  if (!a.getPageBundle) {
    a.getPageBundle = vi.fn(async (id: number, part: number, page: number, request: PageBundleRequest) => {
      const p = await a.getPage(id, part, page);
      if (!p) return null;
      const [tokens, matches] = await Promise.all([
        request.tokens ? a.getPageTokens(id, part, page) : Promise.resolve([]),
        request.namePatterns && request.namePatterns.length > 0
          ? a.getNameMatchPositions(id, part, page, request.namePatterns)
          : request.terms && request.terms.length > 0
            ? a.getMatchPositionsCombined(id, part, page, request.terms)
            : Promise.resolve(null),
      ]);
      // A mock may say where a match runs off the page (`continuesFor`).
      const continues = (a as { continuesFor?: (part: number, page: number) => { prev: boolean; next: boolean } }).continuesFor?.(part, page);
      return { page: p, tokens, matches, continues_prev: continues?.prev ?? false, continues_next: continues?.next ?? false };
    });
  }
  return a as T & SearchAPI;
}

/**
 * A scroll container with geometry, for jsdom, which has none.
 *
 * The reader decides which page is in view from the elements' own boxes, so a
 * test that cannot answer `getBoundingClientRect` cannot exercise the thing
 * that oscillated. This stands in a layout engine just deep enough: a
 * viewport of a fixed height, pages of known heights stacked under the
 * spacer the component rendered, and rects derived from the scroll position.
 *
 *     const layout = installLayout({ viewportHeight: 600, pageHeight: () => 1800 });
 *     await layout.scrollTo(900);
 *     layout.mounted();  // [0, 1, 2, 3]
 */

export interface LayoutOptions {
  viewportHeight?: number;
  /** Height of the page at a spine index, in px. */
  pageHeight?: (index: number) => number;
}

export interface FakeLayout {
  /** Scroll the container and let the reader react. */
  scrollTo: (top: number) => Promise<void>;
  /** Scroll so the page at this spine index sits under the viewport's midpoint. */
  scrollToPage: (index: number) => Promise<void>;
  /** The same, without waiting for the reader: a fling, one event after another. */
  scrollToPageQuick: (index: number) => void;
  /** Let pending frames and effects run without scrolling. */
  settle: () => Promise<void>;
  /** Spine indices mounted, in order. */
  mounted: () => number[];
  /** The scroll container, once rendered. */
  container: () => HTMLElement | null;
  scrollTop: () => number;
  restore: () => void;
}

const isPage = (el: Element): boolean => (el as HTMLElement).dataset?.pageIndex !== undefined;

export function installLayout(options: LayoutOptions = {}): FakeLayout {
  const viewportHeight = options.viewportHeight ?? 600;
  const pageHeight = options.pageHeight ?? (() => 900);
  const originalRect = Element.prototype.getBoundingClientRect;
  const scrollTops = new WeakMap<Element, number>();

  const container = () => document.querySelector<HTMLElement>('[data-testid="reader-scroll"]');

  const spacerBefore = (): number => {
    const el = document.querySelector<HTMLElement>('[data-testid="spacer-before"]');
    return el ? parseFloat(el.style.height || '0') || 0 : 0;
  };

  /** Where a mounted page sits in the scrolled content. */
  const contentTop = (index: number): number => {
    let top = spacerBefore();
    for (const el of document.querySelectorAll('[data-page-index]')) {
      const i = Number((el as HTMLElement).dataset.pageIndex);
      if (i === index) return top;
      top += pageHeight(i);
    }
    return top;
  };

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const c = container();
    if (this === c) {
      return { top: 0, left: 0, bottom: viewportHeight, right: 800, width: 800, height: viewportHeight, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (isPage(this)) {
      const index = Number((this as HTMLElement).dataset.pageIndex);
      const height = pageHeight(index);
      const top = contentTop(index) - (c ? scrollTops.get(c) ?? 0 : 0);
      return { top, left: 0, bottom: top + height, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    }
    return originalRect.call(this);
  };

  // The container's own scroll state, patched on the prototype so it is there
  // from the first render: the reader scrolls itself in a layout effect, and
  // jsdom implements neither `scrollTo` nor a meaningful `scrollTop`.
  const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  const originalScrollTo = Element.prototype.scrollTo;

  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrollTops.set(this, Math.max(0, v));
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return this === container() ? viewportHeight : 0;
    },
  });
  Element.prototype.scrollTo = function (this: Element, arg?: number | ScrollToOptions) {
    const top = typeof arg === 'number' ? arg : (arg?.top ?? 0);
    scrollTops.set(this, Math.max(0, top));
    this.dispatchEvent(new Event('scroll'));
  } as Element['scrollTo'];


  /**
   * Let the reader react. It answers a scroll in an animation frame, and
   * jsdom runs those on a ~16 ms timer, so waiting a macrotask is not enough:
   * wait for a frame of our own, which is queued behind the reader's.
   */
  const flush = async () => {
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => setTimeout(r, 20));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  return {
    async scrollTo(top: number) {
      const c = container();
      if (!c) throw new Error('the reader has not rendered');
      c.scrollTop = top;
      await act(async () => {
        c.dispatchEvent(new Event('scroll'));
      });
      await flush();
    },
    async scrollToPage(index: number) {
      let top = 0;
      for (let i = 0; i < index; i++) top += pageHeight(i);
      await this.scrollTo(Math.max(0, top + pageHeight(index) / 2 - viewportHeight / 2));
    },
    scrollToPageQuick(index: number) {
      const c = container();
      if (!c) throw new Error('the reader has not rendered');
      let top = 0;
      for (let i = 0; i < index; i++) top += pageHeight(i);
      c.scrollTop = Math.max(0, top + pageHeight(index) / 2 - viewportHeight / 2);
      act(() => {
        c.dispatchEvent(new Event('scroll'));
      });
    },
    async settle() {
      await flush();
    },
    mounted() {
      return [...document.querySelectorAll('[data-page-index]')]
        .map((el) => Number((el as HTMLElement).dataset.pageIndex))
        .sort((a, b) => a - b);
    },
    container,
    scrollTop() {
      const c = container();
      return c ? scrollTops.get(c) ?? 0 : 0;
    },
    restore() {
      Element.prototype.getBoundingClientRect = originalRect;
      Element.prototype.scrollTo = originalScrollTo;
      if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
      if (originalClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight);
    },
  };
}

export interface FakeResizeObserver {
  /**
   * Every observed element reports again, as after a layout change: pages
   * their current simulated height, anything else (the reader panel's root)
   * the given width. Called inside `act`.
   */
  fire: (width?: number) => void;
}

/**
 * A ResizeObserver that reports the simulated height once, on observe, and
 * again on `fire` — a sidebar opening, a window resized.
 */
export function installResizeObserver(pageHeight: (index: number) => number): FakeResizeObserver {
  const observed = new Map<Element, ResizeObserverCallback>();
  // Wide enough for the reader and the contents pane side by side; a test
  // narrows it through `fire`.
  let rootWidth = 1400;
  const report = (el: Element, cb: ResizeObserverCallback, ro: ResizeObserver) => {
    const index = Number((el as HTMLElement).dataset?.pageIndex);
    const contentRect = Number.isFinite(index) ? { height: pageHeight(index), width: rootWidth } : { height: 600, width: rootWidth };
    cb([{ target: el, contentRect } as unknown as ResizeObserverEntry], ro);
  };
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observed.set(el, this.cb);
      report(el, this.cb, this as unknown as ResizeObserver);
    }
    unobserve(el: Element) {
      observed.delete(el);
    }
    disconnect() {
      for (const [el, cb] of [...observed]) if (cb === this.cb) observed.delete(el);
    }
  }
  vi.stubGlobal('ResizeObserver', RO);
  return {
    fire(width?: number) {
      if (width !== undefined) rootWidth = width;
      act(() => {
        for (const [el, cb] of [...observed]) {
          if (el.isConnected) report(el, cb, {} as ResizeObserver);
        }
      });
    },
  };
}
