import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './testLayout';

/**
 * Reader navigation as a matrix: every way the view can be asked to move,
 * against every shape the target can have.
 *
 *   entry points   open at page, Go, result click, ToC click
 *   targets        mounted, unmounted, adjacent at the top edge, adjacent at
 *                  the bottom edge, in another part, taller than the viewport
 *
 * The invariant is the same in every cell: once settled, the page under the
 * top edge of the pane is the target, the header and the input say so, and
 * nothing — not the scroll position, not the mounted set — changes without
 * the user doing anything for a quiet period afterwards.
 *
 * Kashshaf's reader has no table of contents; "ToC click" here is the entry
 * point one would use — the anchor prop changing from outside, without a
 * result's highlights — so that path is covered under that name.
 *
 * The quiet period the report asks for is two seconds. Here it is 500 ms
 * sampled every 50 ms: everything the reader does on its own (animation
 * frames, the highlight debounce, a glide's landing watch) is over well
 * inside that, and 24 cells at two seconds each would not be run.
 */

const VIEWPORT = 600;
const PAGE = 900;
const TALL = 1800;
/** The column's top padding and each card's gap below, in px (`pt-6`, `pb-6`). */
const GAP = 24;
const PART_1 = 200;
const PAGES = 400;

type Entry = 'open' | 'go' | 'result' | 'toc';
type Target = 'mounted' | 'unmounted' | 'adjacentTop' | 'adjacentBottom' | 'otherPart' | 'tall';
const ENTRIES: Entry[] = ['open', 'go', 'result', 'toc'];
const TARGETS: Target[] = ['mounted', 'unmounted', 'adjacentTop', 'adjacentBottom', 'otherPart', 'tall'];

function spine(): PageEntry[] {
  return Array.from({ length: PAGES }, (_, i) => ({
    part_index: i < PART_1 ? 0 : 1,
    page_id: i + 1,
    part_label: i < PART_1 ? '1' : '2',
    page_number: String(i < PART_1 ? i + 1 : i - PART_1 + 1),
  }));
}

function labelOf(index: number): string {
  const e = spine()[index];
  return `${e.part_label}:${e.page_number}`;
}

interface World {
  api: SearchAPI;
  heights: Map<number, number>;
}

function makeWorld(): World {
  const heights = new Map<number, number>();
  const api = withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => {
      return {
        id,
        part_index: part,
        page_id: page,
        part_label: String(part + 1),
        page_number: spine()[page - 1].page_number,
        body: `نص الصفحة ${page}`,
        score: 1,
        matched_token_indices: [],
      } as unknown as SearchResult;
    }),
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
  return { api, heights };
}

let layout: FakeLayout;
let world: World;

const pageHeight = (i: number) => world.heights.get(i) ?? PAGE;

function anchorOf(index: number) {
  const e = spine()[index];
  return { part_index: e.part_index, page_id: e.page_id };
}

/** Renders the reader; returns a way to change the anchor as the app would. */
function mountReader(index: number) {
  const onActivePage = vi.fn();
  const tree = (at: number, matches: boolean) => (
    <BooksProvider api={world.api}>
      <ReaderPanel
        api={world.api}
        bookId={7}
        anchor={anchorOf(at)}
        clickedMatches={matches ? { ...anchorOf(at), indices: [0, 1] } : null}
        onActivePage={onActivePage}
      />
    </BooksProvider>
  );
  const view = render(tree(index, false));
  return {
    onActivePage,
    /** A result on another page was clicked: anchor and highlights move together. */
    clickResult: (at: number) => view.rerender(tree(at, true)),
    /** A contents entry was clicked: the anchor moves, nothing is highlighted. */
    clickToc: (at: number) => view.rerender(tree(at, false)),
  };
}

// ---------------------------------------------------------------- observation

/** The page under the top edge of the pane, by the simulated geometry. */
function observedIndex(): number | null {
  const c = layout.container();
  if (!c) return null;
  const probe = c.getBoundingClientRect().top + GAP + 1;
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-index]')) {
    const r = el.getBoundingClientRect();
    if (probe >= r.top && probe < r.bottom) return Number(el.dataset.pageIndex);
  }
  return null;
}

function headerLabel(): string | null {
  const el = screen.queryByText(/ of 400$/);
  return el ? (el.textContent ?? '').split(' of ')[0] : null;
}

function inputLabel(): string {
  const part = (screen.getByLabelText('Volume') as HTMLInputElement).value;
  const page = (screen.getByLabelText('Page number') as HTMLInputElement).value;
  return `${part}:${page}`;
}

async function settled() {
  for (let i = 0; i < 6; i++) await layout.settle();
}

/** Nothing may change for a quiet period after settling. */
async function quiet(): Promise<{ scrollMoved: boolean; windowChanged: boolean; pageChanged: boolean }> {
  const top = layout.scrollTop();
  const mounted = layout.mounted().join(',');
  const page = headerLabel();
  let scrollMoved = false;
  let windowChanged = false;
  let pageChanged = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (Math.abs(layout.scrollTop() - top) > 1) scrollMoved = true;
    if (layout.mounted().join(',') !== mounted) windowChanged = true;
    if (headerLabel() !== page) pageChanged = true;
  }
  return { scrollMoved, windowChanged, pageChanged };
}

// ---------------------------------------------------------------- the cells

interface Cell {
  /** Where the reader starts (null: the entry point is "open at"). */
  start: number | null;
  target: number;
  /** Put the start page's next page half across the bottom before navigating. */
  bottomEdge?: boolean;
}

/** The start and target for a target shape. */
function cellFor(target: Target): Cell {
  switch (target) {
    case 'mounted':
      return { start: 50, target: 52 };
    case 'unmounted':
      return { start: 50, target: 300 };
    case 'adjacentTop':
      return { start: 50, target: 49 };
    case 'adjacentBottom':
      return { start: 50, target: 51, bottomEdge: true };
    case 'otherPart':
      return { start: 50, target: 250 };
    case 'tall':
      return { start: 50, target: 52 };
  }
}

async function openAt(index: number) {
  const r = mountReader(index);
  await waitFor(() => expect(document.querySelector(`[data-page-index="${index}"]`)).toBeTruthy());
  await settled();
  return r;
}

async function runCell(entry: Entry, target: Target) {
  const cell = cellFor(target);
  if (target === 'tall') world.heights.set(cell.target, TALL);

  const start = entry === 'open' ? cell.target : cell.start!;
  const r = await openAt(start);
  expect(observedIndex()).toBe(start);

  if (cell.bottomEdge) {
    const c = layout.container()!;
    const el = document.querySelector<HTMLElement>(`[data-page-index="${start}"]`)!;
    const top = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top;
    await layout.scrollTo(top + pageHeight(start) - VIEWPORT / 2 - 50);
    await settled();
    expect(observedIndex()).toBe(start);
  }

  switch (entry) {
    case 'open':
      break;
    case 'go': {
      const e = spine()[cell.target];
      const part = screen.getByLabelText('Volume');
      const page = screen.getByLabelText('Page number');
      await userEvent.clear(part);
      await userEvent.type(part, e.part_label);
      await userEvent.clear(page);
      await userEvent.type(page, e.page_number);
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));
      break;
    }
    case 'result':
      r.clickResult(cell.target);
      break;
    case 'toc':
      r.clickToc(cell.target);
      break;
  }

  await settled();

  const observed = observedIndex();
  const header = headerLabel();
  const input = inputLabel();
  const after = await quiet();
  return { cell, observed, header, input, after };
}

beforeEach(() => {
  world = makeWorld();
  installResizeObserver(pageHeight);
  layout = installLayout({ viewportHeight: VIEWPORT, pageHeight });
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

describe.each(ENTRIES)('%s', (entry) => {
  it.each(TARGETS)('→ %s', async (target) => {
    const { cell, observed, header, input, after } = await runCell(entry, target);
    const want = labelOf(cell.target);
    const failures: string[] = [];
    if (observed !== cell.target) failures.push(`observed page is ${observed === null ? 'none' : labelOf(observed)}, not ${want}`);
    if (header !== want) failures.push(`header says ${header}, not ${want}`);
    if (input !== want) failures.push(`input says ${input}, not ${want}`);
    if (after.scrollMoved) failures.push('scroll moved on its own afterwards');
    if (after.windowChanged) failures.push('mounted window changed on its own afterwards');
    if (after.pageChanged) failures.push('page in view changed on its own afterwards');
    expect(failures, `${entry} → ${target}: ${failures.join('; ')}`).toEqual([]);
  }, 20000);
});
