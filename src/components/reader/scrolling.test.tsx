import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './testLayout';

/**
 * The reader must not oscillate.
 *
 * The bug: with a page taller than the viewport the reader bounced between
 * two pages and would not scroll on. Mounting a page changed a spacer,
 * which moved the scroll position, which changed which page the observer
 * thought was in view, which changed the window again.
 *
 * These drive a simulated scroll container (testLayout.ts) so the reader's
 * own geometry decides, as it does in a browser.
 */

const VIEWPORT = 600;
/** Three times the viewport: the shape that oscillated. */
const TALL = 1800;

function spine(pages = 60): PageEntry[] {
  return Array.from({ length: pages }, (_, i) => ({
    part_index: i < 30 ? 0 : 1,
    page_id: i + 1,
    part_label: i < 30 ? '1' : '2',
    page_number: String(i < 30 ? i + 1 : i - 29),
  }));
}

function makeApi() {
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => ({
      id,
      part_index: part,
      page_id: page,
      part_label: String(part + 1),
      page_number: String(page),
      body: `نص الصفحة ${page}`,
      score: 1,
      matched_token_indices: [],
    } as unknown as SearchResult)),
    getPageTokens: vi.fn(async (_i: number, _p: number, page: number) =>
      ['نص', 'الصفحة', String(page)].map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[]
    ),
    getPageByLabel: vi.fn(async () => null),
    getMatchPositionsCombined: vi.fn(async () => []),
    getNameMatchPositions: vi.fn(async () => []),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 2, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

let layout: FakeLayout;

async function renderReader(pageHeight: (i: number) => number = () => TALL) {
  const api = makeApi();
  installResizeObserver(pageHeight);
  layout = installLayout({ viewportHeight: VIEWPORT, pageHeight });
  render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: 1 }} />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector('[data-page-index]')).toBeTruthy());
  await layout.settle();
  return api;
}

/** The page the header says the reader is on. */
function shownPage(): string {
  const el = screen.getByText(/ of 60$/);
  return (el.textContent ?? '').split(' of ')[0];
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  });
});

afterEach(() => {
  layout?.restore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('scrolling a book of tall pages', () => {
  it('advances instead of bouncing between two pages', async () => {
    await renderReader();
    const seen: number[][] = [];
    const anchors: string[] = [];

    // Down the book in half-viewport steps, as a wheel would.
    for (let top = 0; top <= TALL * 6; top += VIEWPORT / 2) {
      await layout.scrollTo(top);
      seen.push(layout.mounted());
      anchors.push(shownPage());
    }

    // The window only ever moves forward.
    const starts = seen.map((w) => w[0]);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    }
    // And the reader actually got somewhere.
    expect(starts[starts.length - 1]).toBeGreaterThan(starts[0]);
    expect(anchors[anchors.length - 1]).not.toBe(anchors[0]);
  });

  it('settles after one scroll: the window does not flip again on its own', async () => {
    await renderReader();
    for (let top = 0; top <= TALL * 4; top += VIEWPORT) {
      await layout.scrollTo(top);
      const after = layout.mounted();
      // Nothing more happens without the user doing anything.
      await layout.settle();
      await layout.settle();
      expect(layout.mounted()).toEqual(after);
    }
  });

  it('keeps a tall page selected while it fills the viewport', async () => {
    await renderReader();
    // Page 2 (index 1) spans 1800..3600 in the content.
    await layout.scrollTo(TALL + 100);
    const first = shownPage();
    await layout.scrollTo(TALL + 700);
    expect(shownPage()).toBe(first);
    await layout.scrollTo(TALL + 1300);
    expect(shownPage()).toBe(first);
    // Crossing into the next page changes it, once.
    await layout.scrollTo(TALL * 2 + 400);
    expect(shownPage()).not.toBe(first);
  });

  it('holds the visible content still when the window shifts', async () => {
    await renderReader();
    // Far enough in that pages are being unmounted behind us.
    await layout.scrollTo(TALL * 5);
    const before = layout.scrollTop();
    const page = shownPage();
    await layout.settle();
    // Mounting and measuring moved spacers, not the reader's place in the book.
    expect(shownPage()).toBe(page);
    expect(Math.abs(layout.scrollTop() - before)).toBeLessThanOrEqual(TALL);
  });

  it('survives rapid scrollbar drags without bouncing', async () => {
    await renderReader();
    // A dragged scrollbar: large jumps, no intermediate positions.
    for (const top of [TALL * 20, TALL * 3, TALL * 40, TALL * 12, TALL * 55]) {
      await layout.scrollTo(top);
      const landed = layout.mounted();
      await layout.settle();
      // One move per drag: where it landed is where it stays.
      expect(layout.mounted()).toEqual(landed);
      expect(landed.length).toBeLessThanOrEqual(7);
    }
  });

  it('mixed page heights do not shift the window back and forth', async () => {
    // Short and tall pages alternating is the worst case for a ratio.
    await renderReader((i) => (i % 2 === 0 ? 300 : TALL));
    const starts: number[] = [];
    let top = 0;
    for (let i = 0; i < 24; i++) {
      top += 400;
      await layout.scrollTo(top);
      starts.push(layout.mounted()[0]);
    }
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    }
  });
});
