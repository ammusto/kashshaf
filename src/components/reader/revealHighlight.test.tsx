import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, withPageBundle, type FakeLayout } from './testLayout';

/**
 * A clicked result's match is brought into view.
 *
 * A placement puts the page's top at the top of the pane. On a page taller
 * than the pane whose match sits near the foot, that left the highlight
 * below the fold and the reader looking as if it had not found anything.
 * Now, once the page has landed and its highlights are drawn, the pane
 * moves down within the page so the first highlight is a third of the way
 * down; a match already in view moves nothing.
 */

const VIEWPORT = 600;
const PAGE = 1800;

function spine(): PageEntry[] {
  return Array.from({ length: 50 }, (_, i) => ({ part_index: 0, page_id: i + 1, part_label: '1', page_number: String(i + 1) }));
}

function makeApi() {
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => ({
      id,
      part_index: part,
      page_id: page,
      part_label: '1',
      page_number: String(page),
      body: 'نص الصفحة هنا',
      score: 1,
      matched_token_indices: [],
    } as unknown as SearchResult)),
    getPageTokens: vi.fn(async () =>
      ['نص', 'الصفحة', 'هنا'].map((surface, idx) => ({ idx, surface, lemma: surface, pos: 'noun', features: [], clitics: [] })) as unknown as Token[]
    ),
    getPageByLabel: vi.fn(async () => null),
    getMatchPositionsCombined: vi.fn(async () => []),
    getNameMatchPositions: vi.fn(async () => []),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

let layout: FakeLayout;

async function open(highlightTop: number) {
  installResizeObserver(() => PAGE);
  layout = installLayout({ viewportHeight: VIEWPORT, pageHeight: () => PAGE, highlightTop: () => highlightTop });
  const api = makeApi();
  render(
    <BooksProvider api={api}>
      <ReaderPanel
        api={api}
        bookId={7}
        anchor={{ part_index: 0, page_id: 20 }}
        clickedMatches={{ part_index: 0, page_id: 20, indices: [2] }}
        onActivePage={vi.fn()}
      />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector('[data-page-index="19"] [data-highlight="true"]')).toBeTruthy());
  await layout.settle();
  await layout.settle();
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

describe('a clicked result is scrolled into view', () => {
  it('moves down within the page when the match is below the fold', async () => {
    await open(1500);
    const pageTop = 19 * PAGE; // the fake layout stacks pages from the spacer; the gap is inside the card
    const scrollTop = layout.scrollTop();
    // Past the page's top, so the match (1,500 px down a 1,800 px page) is
    // on screen, and never above the page itself.
    expect(scrollTop).toBeGreaterThan(pageTop);
    const highlightInView = pageTop + 1500 - scrollTop;
    expect(highlightInView).toBeGreaterThan(0);
    expect(highlightInView).toBeLessThan(VIEWPORT);
    // Still page 20 at the top of the pane.
    const label = document.querySelector('[data-page-index="19"]')?.getAttribute('data-page-label');
    expect(label).toBe('20');
  });

  it('leaves the view alone when the match is already in view', async () => {
    await open(200);
    const pageTop = 19 * PAGE;
    expect(Math.abs(layout.scrollTop() - pageTop)).toBeLessThanOrEqual(24);
  });
});
