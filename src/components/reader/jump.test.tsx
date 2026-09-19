import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './testLayout';
import { CARD_GAP } from './ContinuousReader';

/**
 * A jump is a placement, not a scroll.
 *
 * The bug: clicking a result for page 36 bounced between page 1 and page
 * 36. The reader opened at page 1, scrolled to an estimated offset, and
 * re-anchored as pages measured — and the frame at page 1 was reported to
 * the app, which handed it back as the tab's anchor: a jump to page 1.
 *
 * The page in view must be the requested page on the first settled frame,
 * and must not change without the user doing anything.
 */

const VIEWPORT = 600;
const PAGE = 1100;
const PAGES = 400;

/** 400 pages in two parts of 200. */
function spine(): PageEntry[] {
  return Array.from({ length: PAGES }, (_, i) => ({
    part_index: i < 200 ? 0 : 1,
    page_id: i + 1,
    part_label: i < 200 ? '1' : '2',
    page_number: String(i < 200 ? i + 1 : i - 199),
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

/** The label the header shows: `1:36` for spine index 35. */
function labelOf(index: number): string {
  const e = spine()[index];
  return `${e.part_label}:${e.page_number}`;
}

function shownPage(): string | null {
  const el = screen.queryByText(/ of 400$/);
  return el ? (el.textContent ?? '').split(' of ')[0] : null;
}

/** Opens the reader at a spine index and lets it settle completely. */
async function openAt(index: number, api = makeApi()) {
  const e = spine()[index];
  const onActivePage = vi.fn();
  const view = render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={{ part_index: e.part_index, page_id: e.page_id }} onActivePage={onActivePage} />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector(`[data-page-index="${index}"]`)).toBeTruthy());
  await layout.settle();
  await layout.settle();
  return { api, onActivePage, view };
}

/** Nothing happens for a while; the page in view must not change. */
async function leaveAlone() {
  for (let i = 0; i < 4; i++) await layout.settle();
}

beforeEach(() => {
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

describe('opening the reader at a page', () => {
  it('opens at page 36 of 400 and stays there', async () => {
    const { api, onActivePage } = await openAt(35);
    expect(shownPage()).toBe('1:36');
    // The window is centred on the page asked for; page 1 was never mounted
    // or fetched.
    expect(layout.mounted()).toEqual([32, 33, 34, 35, 36, 37, 38]);
    expect(api.getPage).not.toHaveBeenCalledWith(7, 0, 1);
    // Nobody was told the reader was anywhere else.
    for (const call of onActivePage.mock.calls) {
      expect(call[0]).toMatchObject({ part_index: 0, page_id: 36 });
    }
    await leaveAlone();
    expect(shownPage()).toBe('1:36');
    expect(layout.mounted()).toEqual([32, 33, 34, 35, 36, 37, 38]);
  });

  it('opens at the last page', async () => {
    const { onActivePage } = await openAt(PAGES - 1);
    expect(shownPage()).toBe(labelOf(PAGES - 1));
    expect(layout.mounted()).toEqual([396, 397, 398, 399]);
    await leaveAlone();
    expect(shownPage()).toBe(labelOf(PAGES - 1));
    for (const call of onActivePage.mock.calls) {
      expect(call[0]).toMatchObject({ part_index: 1, page_id: PAGES });
    }
  });

  it('opens at a page in the second part', async () => {
    // Spine index 250 is part 2, printed page 51.
    const { onActivePage } = await openAt(250);
    expect(shownPage()).toBe('2:51');
    expect(layout.mounted()).toEqual([247, 248, 249, 250, 251, 252, 253]);
    await leaveAlone();
    expect(shownPage()).toBe('2:51');
    expect(onActivePage.mock.calls.every((c) => c[0].part_index === 1 && c[0].page_id === 251)).toBe(true);
  });

  it('the page asked for sits at the top of the pane with the gap above it showing', async () => {
    await openAt(35);
    const el = document.querySelector('[data-page-index="35"]')!;
    const c = layout.container()!;
    expect(el.getBoundingClientRect().top - c.getBoundingClientRect().top).toBeCloseTo(CARD_GAP, 0);
  });
});

describe('jumping with Go', () => {
  async function go(part: string, page: string) {
    const partInput = screen.getByLabelText('Volume');
    const pageInput = screen.getByLabelText('Page number');
    await userEvent.clear(partInput);
    await userEvent.type(partInput, part);
    await userEvent.clear(pageInput);
    await userEvent.type(pageInput, page);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await layout.settle();
    await layout.settle();
  }

  it('jumps from 36 to 300 and back, landing exactly each time', async () => {
    const { onActivePage } = await openAt(35);
    expect(shownPage()).toBe('1:36');

    // Spine index 299 is part 2, printed page 100.
    await go('2', '100');
    await waitFor(() => expect(shownPage()).toBe('2:100'));
    expect(layout.mounted()).toEqual([296, 297, 298, 299, 300, 301, 302]);
    await leaveAlone();
    expect(shownPage()).toBe('2:100');

    await go('1', '36');
    await waitFor(() => expect(shownPage()).toBe('1:36'));
    expect(layout.mounted()).toEqual([32, 33, 34, 35, 36, 37, 38]);
    await leaveAlone();
    expect(shownPage()).toBe('1:36');

    // Only the three pages asked for were ever reported, in that order.
    const reported = onActivePage.mock.calls.map((c) => `${c[0].part_index}:${c[0].page_id}`);
    const distinct = reported.filter((p, i) => i === 0 || p !== reported[i - 1]);
    expect(distinct).toEqual(['0:36', '1:300', '0:36']);
  });

  it('a jump from outside, via the anchor prop, lands the same way', async () => {
    const api = makeApi();
    const onActivePage = vi.fn();
    const { rerender } = render(
      <BooksProvider api={api}>
        <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: 36 }} onActivePage={onActivePage} />
      </BooksProvider>
    );
    await waitFor(() => expect(document.querySelector('[data-page-index="35"]')).toBeTruthy());
    await layout.settle();
    expect(shownPage()).toBe('1:36');

    // A clicked result on page 300 of part 2.
    rerender(
      <BooksProvider api={api}>
        <ReaderPanel api={api} bookId={7} anchor={{ part_index: 1, page_id: 300 }} onActivePage={onActivePage} />
      </BooksProvider>
    );
    await waitFor(() => expect(shownPage()).toBe('2:100'));
    await leaveAlone();
    expect(shownPage()).toBe('2:100');
    expect(layout.mounted()).toEqual([296, 297, 298, 299, 300, 301, 302]);
    const reported = onActivePage.mock.calls.map((c) => `${c[0].part_index}:${c[0].page_id}`);
    expect(new Set(reported)).toEqual(new Set(['0:36', '1:300']));
  });
});
