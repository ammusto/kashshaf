import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token, TocNode } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './testLayout';
import { resetTocPaneMemory, TOC_MIN_WIDTH, TOC_DEFAULT_WIDTH } from '../../hooks/useTocPane';
import { CARD_GAP } from './ContinuousReader';

/**
 * The contents pane beside the reader.
 *
 * Its tree is the shared `TocTree`; what is tested here is Kashshaf's use of
 * it: the highlighted entry following the page in view across a part
 * boundary, a click placing the entry's page at the top of the pane through
 * goTo, the width respecting the sidebar's minimum, and what the pane says
 * for a book without headings and for a source without a table of contents.
 */

const VIEWPORT = 600;
const PAGE = 900;
const PART_1 = 20;
const PAGES = 40;

function spine(): PageEntry[] {
  return Array.from({ length: PAGES }, (_, i) => ({
    part_index: i < PART_1 ? 0 : 1,
    page_id: i + 1,
    part_label: i < PART_1 ? '1' : '2',
    page_number: String(i < PART_1 ? i + 1 : i - PART_1 + 1),
  }));
}

/** Two chapters in part 1, one in part 2 with a section under it. */
function tree(): TocNode[] {
  const n = (id: number, parent: number, title: string, part_index: number, page_id: number, depth: number, children: TocNode[] = []): TocNode => ({
    id,
    parent,
    title,
    part_index,
    page_id,
    page_number: spine()[page_id - 1].page_number,
    depth,
    children,
  });
  return [
    n(1, 0, 'المقدمة', 0, 1, 0),
    n(2, 0, 'باب الصلاة', 0, 8, 0, [n(3, 2, 'فصل في الوقت', 0, 12, 1)]),
    n(4, 0, 'باب الزكاة', 1, 21, 0, [n(5, 4, 'فصل في النصاب', 1, 30, 1)]),
  ];
}

function makeApi(toc: TocNode[] | null | Error = tree()) {
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => ({
      id,
      part_index: part,
      page_id: page,
      part_label: String(part + 1),
      page_number: spine()[page - 1].page_number,
      body: `نص الصفحة ${page}`,
      score: 1,
      matched_token_indices: [],
    } as unknown as SearchResult)),
    getPageTokens: vi.fn(async (_i: number, _p: number, page: number) =>
      ['نص', 'الصفحة', String(page)].map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[]
    ),
    getBookToc: vi.fn(async () => {
      if (toc instanceof Error) throw toc;
      return toc;
    }),
    getPageByLabel: vi.fn(async () => null),
    getMatchPositionsCombined: vi.fn(async () => []),
    getNameMatchPositions: vi.fn(async () => []),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 2, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

let layout: FakeLayout;

function anchorOf(index: number) {
  const e = spine()[index];
  return { part_index: e.part_index, page_id: e.page_id };
}

/** Open the reader at a spine index as a result click would, so the pane opens. */
async function openAt(index: number, api = makeApi(), remote = false) {
  render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={anchorOf(index)} clickedMatches={{ ...anchorOf(index), indices: [0] }} remote={remote} />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector(`[data-page-index="${index}"]`)).toBeTruthy());
  await layout.settle();
  await layout.settle();
  return api;
}

function currentEntry(): string | null {
  const pane = screen.queryByTestId('toc-pane');
  if (!pane) return null;
  const el = pane.querySelector('[aria-current="true"]');
  return el ? (el.querySelector('span')?.textContent ?? null) : null;
}

/** The page under the top edge of the pane, by the simulated geometry. */
function observedIndex(): number | null {
  const c = layout.container();
  if (!c) return null;
  const probe = c.getBoundingClientRect().top + CARD_GAP + 1;
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-index]')) {
    const r = el.getBoundingClientRect();
    if (probe >= r.top && probe < r.bottom) return Number(el.dataset.pageIndex);
  }
  return null;
}

beforeEach(() => {
  resetTocPaneMemory();
  localStorage.clear();
  installResizeObserver(() => PAGE);
  layout = installLayout({ viewportHeight: VIEWPORT, pageHeight: () => PAGE });
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

describe('the contents pane', () => {
  it('opens with a book loaded from a result, and the highlighted entry follows the page across a part boundary', async () => {
    await openAt(9); // page 10, in باب الصلاة
    const pane = await screen.findByTestId('toc-pane');
    expect(within(pane).getByText('باب الصلاة')).toBeInTheDocument();
    await waitFor(() => expect(currentEntry()).toBe('باب الصلاة'));

    // Scroll on into the section under it: the path opens and it is current.
    await layout.scrollToPage(13); // page 14, under فصل في الوقت
    await waitFor(() => expect(currentEntry()).toBe('فصل في الوقت'));

    // Across the part boundary into part 2, page 32: under فصل في النصاب,
    // which was inside a closed subtree until now.
    await layout.scrollToPage(31);
    await waitFor(() => expect(currentEntry()).toBe('فصل في النصاب'));
    expect(within(pane).getByTestId('toc-toggle-4')).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking an entry places its page at the top of the pane, through goTo', async () => {
    await openAt(0);
    const pane = await screen.findByTestId('toc-pane');
    // Open part 2's chapter: its page is far away and not mounted.
    await userEvent.click(within(pane).getByText('باب الزكاة'));
    for (let i = 0; i < 6; i++) await layout.settle();
    expect(observedIndex()).toBe(20); // page 21
    await waitFor(() => expect(currentEntry()).toBe('باب الزكاة'));
    const el = document.querySelector('[data-page-index="20"]')!;
    const c = layout.container()!;
    expect(el.getBoundingClientRect().top - c.getBoundingClientRect().top).toBeCloseTo(CARD_GAP, 0);

    // And a mounted one: the section three pages on.
    await userEvent.click(within(pane).getByTestId('toc-toggle-4'));
    await userEvent.click(within(pane).getByText('فصل في النصاب'));
    for (let i = 0; i < 6; i++) await layout.settle();
    expect(observedIndex()).toBe(29); // page 30
  });

  it('is dragged from its left border, no narrower than the search sidebar', async () => {
    await openAt(0);
    const pane = await screen.findByTestId('toc-pane');
    expect(pane).toHaveStyle({ width: `${TOC_DEFAULT_WIDTH}px` });
    const handle = within(pane).getByTestId('toc-resize');

    // Wider: the border moves left.
    fireEvent.mouseDown(handle, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 900 });
    fireEvent.mouseUp(window);
    expect(pane).toHaveStyle({ width: `${TOC_DEFAULT_WIDTH + 100}px` });

    // Narrower than the minimum: it stops at the minimum.
    fireEvent.mouseDown(handle, { clientX: 900 });
    fireEvent.mouseMove(window, { clientX: 1500 });
    fireEvent.mouseUp(window);
    expect(pane).toHaveStyle({ width: `${TOC_MIN_WIDTH}px` });
    expect(localStorage.getItem('tocWidth')).toBe(String(TOC_MIN_WIDTH));
  });

  it('a book without headings says so and offers to collapse', async () => {
    await openAt(0, makeApi([]));
    const pane = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(pane).getByTestId('toc-empty')).toHaveTextContent('This text has no table of contents.'));
    await userEvent.click(within(pane).getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument();
  });

  it('a server without the route says a newer server is needed, rather than erroring', async () => {
    await openAt(0, makeApi(null), true);
    const pane = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(pane).getByTestId('toc-unavailable')).toHaveTextContent('Table of contents requires a newer server.'));
    expect(within(pane).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a corpus without toc.db says which corpus ships it', async () => {
    await openAt(0, makeApi(null), false);
    const pane = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(pane).getByTestId('toc-unavailable')).toHaveTextContent('ships with corpus 4.2.0'));
  });

  it('Ctrl+T and the toolbar button toggle it, and the state lasts the session', async () => {
    await openAt(0);
    expect(await screen.findByTestId('toc-pane')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Contents' }));
    expect(screen.getByTestId('toc-pane')).toBeInTheDocument();
    // Closed by the user, then another result is opened: it stays closed.
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument();
  });
});
