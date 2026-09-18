import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout } from './testLayout';

/**
 * The reader as the user meets it: a book that scrolls, with only a few of
 * its pages mounted at a time.
 *
 * jsdom has no layout, so heights are all zero and the spacers cannot be
 * checked here; what can be checked is which pages are mounted, that the
 * window follows the page in view, that a part boundary is drawn, and that
 * neither the mounted set nor the page cache grows as the reader scrolls
 * through the book. The pixel arithmetic is covered by pageWindow.test.ts.
 */

// ---------------------------------------------------------------- doubles

/**
 * The reader decides which page is in view from the elements' own boxes, so
 * the tests scroll a simulated container (testLayout.ts) rather than pretend
 * an observer fired.
 */
const PAGE_HEIGHT = 900;
let layout: FakeLayout;

/** A 200-page book in two parts, the second starting at page 101. */
function spineOf(pages = 200): PageEntry[] {
  return Array.from({ length: pages }, (_, i) => {
    const part = i < 100 ? 0 : 1;
    return {
      part_index: part,
      page_id: i + 1,
      part_label: String(part + 1),
      page_number: String(part === 0 ? i + 1 : i - 99),
    };
  });
}

function tokensFor(page: number): Token[] {
  return [
    { idx: 0, surface: 'معرفة', lemma: 'معرفة', root: 'ع.ر.ف', pos: 'noun' },
    { idx: 1, surface: 'الله', lemma: 'الله', root: null, pos: 'noun' },
    { idx: 2, surface: `صفحة${page}`, lemma: 'صفحة', root: 'ص.ف.ح', pos: 'noun' },
  ] as unknown as Token[];
}

function makeApi(spine: PageEntry[]) {
  const pageCalls: string[] = [];
  const api = {
    listBookPages: vi.fn(async () => spine),
    getPage: vi.fn(async (id: number, part: number, page: number): Promise<SearchResult> => {
      pageCalls.push(`${part}:${page}`);
      return {
        id,
        part_index: part,
        page_id: page,
        part_label: String(part + 1),
        page_number: String(page),
        body: `معرفة الله صفحة${page}`,
        score: 1,
        matched_token_indices: [],
      } as unknown as SearchResult;
    }),
    getPageTokens: vi.fn(async (_id: number, _part: number, page: number) => tokensFor(page)),
    getPageByLabel: vi.fn(async () => null),
    getMatchPositionsCombined: vi.fn(async () => []),
    getNameMatchPositions: vi.fn(async () => []),
    getAllBooks: vi.fn(async () => [
      { id: 7, title: 'كتاب', author_id: 1, parts: 2, in_corpus: true },
    ]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
  return { api, pageCalls };
}

function renderReader(api: SearchAPI, anchor = { part_index: 0, page_id: 1 }) {
  return render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={anchor} />
    </BooksProvider>
  );
}

/** Spine indices of the pages currently in the DOM. */
function mountedIndices(): number[] {
  return [...document.querySelectorAll('[data-page-index]')]
    .map((el) => Number((el as HTMLElement).dataset.pageIndex))
    .sort((a, b) => a - b);
}

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


// ---------------------------------------------------------------- tests

describe('the reader as a scrolling book', () => {
  it('fetches the spine once and mounts a window of pages, not the book', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api);

    await waitFor(() => expect(mountedIndices().length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText(/معرفة/).length).toBeGreaterThan(0));

    expect(api.listBookPages).toHaveBeenCalledTimes(1);
    expect(api.listBookPages).toHaveBeenCalledWith(7);
    // Anchored on the first page: nothing before it, three after.
    expect(mountedIndices()).toEqual([0, 1, 2, 3]);
    expect(api.getPage).toHaveBeenCalledTimes(4);
  });

  it('follows the page that comes into view and keeps at most 7 pages mounted', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api);
    await layout.settle();
    await waitFor(() => expect(mountedIndices()).toEqual([0, 1, 2, 3]));

    await layout.scrollToPage(3);
    await waitFor(() => expect(mountedIndices()).toEqual([0, 1, 2, 3, 4, 5, 6]));

    await layout.scrollToPage(6);
    await waitFor(() => expect(mountedIndices()).toEqual([3, 4, 5, 6, 7, 8, 9]));
    // The pages left behind are gone from the DOM.
    expect(mountedIndices()).not.toContain(0);
  });

  it('scrolling the length of the book leaves the mounted set and the fetches per page flat', async () => {
    const { api } = makeApi(spineOf(200));
    renderReader(api);
    await layout.settle();
    await waitFor(() => expect(mountedIndices()).toEqual([0, 1, 2, 3]));

    let widest = 0;
    // Ten pages at a time, the length of a 200-page book.
    for (let i = 0; i < 200; i += 10) {
      await layout.scrollToPage(i);
      widest = Math.max(widest, mountedIndices().length);
    }

    expect(widest).toBeLessThanOrEqual(7);
    expect(mountedIndices().length).toBeLessThanOrEqual(7);
    // No page is fetched twice on one pass through the book.
    const perPage = new Map<string, number>();
    for (const call of (api.getPage as ReturnType<typeof vi.fn>).mock.calls) {
      const key = `${call[1]}:${call[2]}`;
      perPage.set(key, (perPage.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perPage.values())).toBe(1);
    expect(api.listBookPages).toHaveBeenCalledTimes(1);
  }, 30000);

  it('draws a divider where a new part begins', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api, { part_index: 1, page_id: 101 });

    // Page 101 is spine index 100, the first page of part 2.
    await waitFor(() => expect(mountedIndices()).toContain(100));
    await waitFor(() => expect(screen.getByText('Part 2')).toBeInTheDocument());
    // The part before it is mounted too, and carries no divider of its own.
    expect(mountedIndices()).toContain(99);
    expect(screen.queryAllByText('Part 1')).toHaveLength(0);
  });

  it('the header label follows the page in view', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api);
    await waitFor(() => expect(screen.getByText('1:1 of 200')).toBeInTheDocument());

    await layout.scrollToPage(2);
    await waitFor(() => expect(screen.getByText('1:3 of 200')).toBeInTheDocument());
  });

  it('Next steps one page and Prev steps back', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api);
    await waitFor(() => expect(screen.getByText('1:1 of 200')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '← Next' }));
    await waitFor(() => expect(screen.getByText('1:2 of 200')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Prev →' }));
    await waitFor(() => expect(screen.getByText('1:1 of 200')).toBeInTheDocument());
  });

  it('Go jumps to a printed page number without asking the server', async () => {
    const { api } = makeApi(spineOf());
    renderReader(api);
    await waitFor(() => expect(screen.getByText('1:1 of 200')).toBeInTheDocument());

    const part = screen.getByLabelText('Volume');
    const page = screen.getByLabelText('Page number');
    await userEvent.clear(part);
    await userEvent.type(part, '2');
    await userEvent.clear(page);
    await userEvent.type(page, '5');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    // Part 2 page 5 is spine index 104.
    await waitFor(() => expect(screen.getByText('2:5 of 200')).toBeInTheDocument());
    expect(api.getPageByLabel).not.toHaveBeenCalled();
  });

  it('tells the app which page the reader is on', async () => {
    const { api } = makeApi(spineOf());
    const onActivePage = vi.fn();
    render(
      <BooksProvider api={api}>
        <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: 1 }} onActivePage={onActivePage} />
      </BooksProvider>
    );
    await waitFor(() => expect(onActivePage).toHaveBeenCalled());
    expect(onActivePage.mock.calls[0][0]).toMatchObject({ part_index: 0, page_id: 1 });

    await layout.scrollToPage(2);
    await waitFor(() =>
      expect(onActivePage).toHaveBeenCalledWith(expect.objectContaining({ part_index: 0, page_id: 3 }))
    );
  });

  it('falls back to one page at a time when the corpus serves no page list', async () => {
    const { api } = makeApi(spineOf());
    (api.listBookPages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'));
    renderReader(api);

    await waitFor(() =>
      expect(screen.getByText(/does not serve a page list/)).toBeInTheDocument()
    );
    expect(mountedIndices()).toEqual([]);
  });
});
