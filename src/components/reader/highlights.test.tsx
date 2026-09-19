import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchContext } from '../../types/search';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { highlightRequestOf } from '../../utils/highlightRequest';
import { installLayout, installResizeObserver, withPageBundle, type FakeLayout } from './testLayout';

/**
 * Highlights follow the query, not the click.
 *
 * The case from the report: معرفة الله is on pages 1 and 3 but not 2, and
 * only page 1 was clicked in the results list. Scrolling from 1 to 3 has to
 * mark page 3 too, although nobody ever clicked it and it was never in the
 * results the reader was opened from.
 *
 * Since 0.6.0 the highlights come with the page: one request per page
 * carries its text, its tokens and the hits for the running search, so a
 * page is never asked about twice and a page passed without stopping is
 * not asked about at all.
 */

/**
 * The reader decides which page is in view from the elements' own boxes, so
 * the tests scroll a simulated container (testLayout.ts) rather than pretend
 * an observer fired.
 */
const PAGE_HEIGHT = 900;
let layout: FakeLayout;

/** Two parts of six pages each; معرفة الله falls on pages 1, 3 and 8. */
const HITS = new Set([1, 3, 8]);

function spine(): PageEntry[] {
  return Array.from({ length: 12 }, (_, i) => ({
    part_index: i < 6 ? 0 : 1,
    page_id: i + 1,
    part_label: i < 6 ? '1' : '2',
    page_number: String(i < 6 ? i + 1 : i - 5),
  }));
}

function makeApi() {
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number): Promise<SearchResult> => ({
      id,
      part_index: part,
      page_id: page,
      part_label: String(part + 1),
      page_number: String(page),
      body: HITS.has(page) ? `معرفة الله صفحة${page}` : `كلام آخر صفحة${page}`,
      score: 1,
      matched_token_indices: [],
    } as unknown as SearchResult)),
    getPageTokens: vi.fn(async (_id: number, _part: number, page: number): Promise<Token[]> => {
      const words = (HITS.has(page) ? ['معرفة', 'الله'] : ['كلام', 'آخر']).concat(`صفحة${page}`);
      return words.map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[];
    }),
    // The lookup the page request carries, when a search is running.
    getMatchPositionsCombined: vi.fn(async (_id: number, _part: number, page: number) =>
      HITS.has(page) ? [0, 1] : []
    ),
    getNameMatchPositions: vi.fn(async () => []),
    getPageByLabel: vi.fn(async () => null),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 2, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

const searchContext: SearchContext = {
  type: 'combined',
  combinedQuery: {
    andInputs: [{ id: 1, query: 'معرفة الله', mode: 'surface', cliticToggle: false }],
    orInputs: [],
  },
};

/** The reader wired the way App wires it: the search as the highlight request. */
function Harness({
  api,
  anchor,
  context = searchContext,
}: {
  api: SearchAPI;
  anchor: { part_index: number; page_id: number };
  context?: SearchContext | null;
}) {
  return (
    <ReaderPanel
      api={api}
      bookId={7}
      anchor={anchor}
      clickedMatches={{ part_index: anchor.part_index, page_id: anchor.page_id, indices: HITS.has(anchor.page_id) ? [0, 1] : [] }}
      highlight={highlightRequestOf(context)}
    />
  );
}

function renderReader(api: SearchAPI, anchor = { part_index: 0, page_id: 1 }, context?: SearchContext | null) {
  return render(
    <BooksProvider api={api}>
      <Harness api={api} anchor={anchor} context={context} />
    </BooksProvider>
  );
}

/** Highlighted words on the page at this spine index. */
function highlightedWords(index: number): string[] {
  const page = document.querySelector(`[data-page-index="${index}"]`);
  if (!page) return [];
  return [...page.querySelectorAll('[data-highlight="true"]')].map((el) => el.textContent ?? '');
}

const asked = (api: SearchAPI) => (api.getMatchPositionsCombined as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as number);

beforeEach(() => {
  installResizeObserver(() => PAGE_HEIGHT);
  layout = installLayout({ viewportHeight: 600, pageHeight: () => PAGE_HEIGHT });
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

describe('highlights follow the query', () => {
  it('marks page 3 after scrolling there from page 1, though only page 1 was clicked', async () => {
    const api = makeApi();
    renderReader(api);

    // Page 1: the clicked result's own highlights, there at once.
    await waitFor(() => expect(highlightedWords(0)).toEqual(['معرفة', 'الله']));

    // Scroll to page 3: fetched with its hits as it comes into view, and it
    // was never clicked.
    await layout.scrollToPage(2);
    await waitFor(() => expect(screen.getByText('1:3 of 12')).toBeInTheDocument());
    await waitFor(() => expect(highlightedWords(2)).toEqual(['معرفة', 'الله']), { timeout: 2000 });
    expect(highlightedWords(1)).toEqual([]);
    expect(api.getMatchPositionsCombined).toHaveBeenCalledWith(7, 0, 3, [
      { query: 'معرفة الله', mode: 'surface' },
    ]);
  });

  it('marks a hit across a part boundary, in the terms of that page', async () => {
    const api = makeApi();
    // Page 8 is the second page of part 2, five pages after the clicked hit.
    renderReader(api, { part_index: 0, page_id: 5 });
    // Placed and settled on page 5 before the scroll, or the placement
    // would put the scroll back.
    await waitFor(() => expect(document.querySelector('[data-page-index="4"]')?.textContent).toContain('صفحة5'));
    await layout.settle();
    await layout.settle();

    await layout.scrollToPage(7); // spine index 7 = page 8
    await waitFor(() => expect(highlightedWords(7)).toEqual(['معرفة', 'الله']), { timeout: 2000 });
    expect(api.getMatchPositionsCombined).toHaveBeenCalledWith(7, 1, 8, expect.anything());
    // The page before the boundary has no hit and is plain.
    await layout.scrollToPage(5);
    await waitFor(() => expect(document.querySelector('[data-page-index="5"]')?.textContent).toContain('كلام'));
    expect(highlightedWords(5)).toEqual([]);
  });

  it('a page with no hits renders plain', async () => {
    const api = makeApi();
    renderReader(api);
    await layout.scrollToPage(1);
    await waitFor(() => expect(document.querySelector('[data-page-index="1"]')?.textContent).toContain('كلام'));
    expect(highlightedWords(1)).toEqual([]);
  });

  it('asks nothing when no search is running', async () => {
    const api = makeApi();
    renderReader(api, { part_index: 0, page_id: 1 }, null);
    await waitFor(() => expect(document.querySelector('[data-page-index="0"]')?.textContent).toContain('معرفة'));
    await layout.scrollToPage(2);
    await layout.settle();
    expect(api.getMatchPositionsCombined).not.toHaveBeenCalled();
    // The page's request carried no terms.
    for (const call of (api.getPageBundle as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[3].terms).toBeUndefined();
    }
  });

  it('scrolling fast does not ask about every page passed', async () => {
    const api = makeApi();
    renderReader(api);
    await waitFor(() => expect(document.querySelector('[data-page-index="0"]')?.textContent).toContain('معرفة'));
    (api.getMatchPositionsCombined as ReturnType<typeof vi.fn>).mockClear();

    // Straight through the book without pausing. A fling is one scroll
    // event after another with no frame between, so the reader is not
    // waited for in between.
    for (let i = 1; i < 12; i++) {
      layout.scrollToPageQuick(i);
    }
    await layout.settle();
    await layout.settle();

    // The pages it came to rest on and one ahead, not the eleven it passed.
    expect(new Set(asked(api)).size).toBeLessThanOrEqual(4);
  });

  it('asks for each page once, however often it is mounted', async () => {
    const api = makeApi();
    renderReader(api);
    await waitFor(() => expect(document.querySelector('[data-page-index="0"]')?.textContent).toContain('معرفة'));

    await layout.scrollToPage(3);
    await layout.settle();
    await layout.scrollToPage(1);
    await layout.settle();
    await layout.scrollToPage(3);
    await layout.settle();

    const perPage = new Map<number, number>();
    for (const page of asked(api)) perPage.set(page, (perPage.get(page) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBe(1);
  });

  it('a new search on an open book asks the pages in view again, and only those', async () => {
    const api = makeApi();
    const { rerender } = renderReader(api);
    await waitFor(() => expect(highlightedWords(0)).toEqual(['معرفة', 'الله']));
    await layout.settle();
    (api.getMatchPositionsCombined as ReturnType<typeof vi.fn>).mockClear();

    const other: SearchContext = {
      type: 'combined',
      combinedQuery: { andInputs: [{ id: 1, query: 'كلام', mode: 'surface', cliticToggle: false }], orInputs: [] },
    };
    rerender(
      <BooksProvider api={api}>
        <Harness api={api} anchor={{ part_index: 0, page_id: 1 }} context={other} />
      </BooksProvider>
    );
    await waitFor(() => expect(api.getMatchPositionsCombined).toHaveBeenCalledWith(7, 0, 1, [{ query: 'كلام', mode: 'surface' }]));
    await layout.settle();
    // Page 1 and the one ahead of it; nothing further into the book.
    expect(new Set(asked(api)).size).toBeLessThanOrEqual(2);
  });
});
