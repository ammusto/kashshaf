import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout } from './testLayout';

/**
 * Prev and Next move the view one page, and the input says where the view is.
 *
 * The bug: from page 750 with part of 749 visible, Prev went to 749; a second
 * Prev set the input to 748 while the view stayed on 749. The input was a
 * counter the buttons decremented, apart from the page under the midpoint,
 * and 748 was outside the mounted window, so the scroll aimed at an estimate
 * that the landed-position guard threw away.
 *
 * Now the target is one page from the page in view, read from the geometry,
 * and the input only ever shows the page in view. After every press the two
 * must agree, and the view must have moved by exactly one page.
 */

const VIEWPORT = 600;
const PAGE = 900;
const PAGES = 1000;

function spine(): PageEntry[] {
  return Array.from({ length: PAGES }, (_, i) => ({
    part_index: 0,
    page_id: i + 1,
    part_label: '1',
    page_number: String(i + 1),
  }));
}

function makeApi() {
  return {
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => ({
      id,
      part_index: part,
      page_id: page,
      part_label: '1',
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
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
}

let layout: FakeLayout;

/** What the header says the reader is on, as a page number. */
function shownPage(): number {
  const el = screen.getByText(/ of 1,000$/);
  return Number((el.textContent ?? '').split(' of ')[0]);
}

/** What the page-number box says. */
function inputPage(): number {
  return Number((screen.getByLabelText('Page number') as HTMLInputElement).value);
}

/** The page under the viewport's midpoint, by the simulated geometry. */
function viewPage(): number {
  const c = layout.container()!;
  const mid = c.getBoundingClientRect().top + VIEWPORT / 2;
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-index]')) {
    const r = el.getBoundingClientRect();
    if (mid >= r.top && mid < r.bottom) return Number(el.dataset.pageIndex) + 1;
  }
  throw new Error('the midpoint is over no mounted page');
}

async function openAt(page: number) {
  const api = makeApi();
  render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: page }} />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector(`[data-page-index="${page - 1}"]`)).toBeTruthy());
  await layout.settle();
  await layout.settle();
  expect(shownPage()).toBe(page);
  return api;
}

/** Press, let the glide or the jump land, let the window catch up. */
async function press(name: '← Next' | 'Prev →') {
  await userEvent.click(screen.getByRole('button', { name }));
  await layout.settle();
  await layout.settle();
  await layout.settle();
}

/** The three things that must agree after every press. */
function expectOn(page: number) {
  expect(viewPage()).toBe(page);
  expect(shownPage()).toBe(page);
  expect(inputPage()).toBe(page);
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

describe('Prev and Next', () => {
  it('from a page at the top edge: ten Prev, ten Next, one page each', async () => {
    await openAt(750);
    expectOn(750);
    for (let i = 1; i <= 10; i++) {
      await press('Prev →');
      expectOn(750 - i);
    }
    for (let i = 9; i >= 0; i--) {
      await press('← Next');
      expectOn(750 - i);
    }
  }, 60000);

  it('from a page half-visible at the bottom edge', async () => {
    await openAt(750);
    // Scroll so 750 is under the midpoint and 751 shows across the bottom
    // of the viewport: the shape the report started from.
    const c = layout.container()!;
    const el = document.querySelector<HTMLElement>('[data-page-index="749"]')!;
    const top750 = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top;
    await layout.scrollTo(top750 + PAGE - VIEWPORT / 2 - 50);
    await layout.settle();
    expect(viewPage()).toBe(750);
    const bottomVisible = document.querySelector<HTMLElement>('[data-page-index="750"]')!.getBoundingClientRect().top;
    expect(bottomVisible).toBeLessThan(VIEWPORT);
    expectOn(750);

    for (let i = 1; i <= 10; i++) {
      await press('Prev →');
      expectOn(750 - i);
    }
    for (let i = 9; i >= 0; i--) {
      await press('← Next');
      expectOn(750 - i);
    }
  }, 60000);

  it('the second Prev from the report: 750, 749, 748 — view and input together', async () => {
    await openAt(750);
    await press('Prev →');
    expectOn(749);
    await press('Prev →');
    expectOn(748);
  });

  it('stops at the first and last page', async () => {
    await openAt(1);
    await press('Prev →');
    expectOn(1);
    // The window is small at the edge; a jump lands the last page.
    const pageInput = screen.getByLabelText('Page number');
    await userEvent.clear(pageInput);
    await userEvent.type(pageInput, String(PAGES));
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await layout.settle();
    await layout.settle();
    expectOn(PAGES);
    await press('← Next');
    expectOn(PAGES);
  });
});
