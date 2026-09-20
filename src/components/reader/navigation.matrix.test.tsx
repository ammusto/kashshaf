import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Profiler } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import type { SearchContext } from '../../types/search';
import { highlightRequestOf, type HighlightRequest } from '../../utils/highlightRequest';
import { installLayout, installResizeObserver, type FakeLayout, type FakeResizeObserver, withPageBundle } from './testLayout';

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
  /**
   * A page whose reported height changes on every measurement, by a few
   * pixels either way: the layout jitter of a real browser (subpixel
   * rounding, a selection changing the wrap) that the pinning corrects on
   * every render.
   */
  jitter: { index: number; flip: boolean } | null;
}

function makeWorld(): World {
  const heights = new Map<number, number>();
  const jitter = null;
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
  return { api, heights, jitter };
}

let layout: FakeLayout;
let resizer: FakeResizeObserver;
let world: World;
/** Commits of the reader tree, for the settle assertions. */
let commits = 0;

const pageHeight = (i: number) => world.heights.get(i) ?? PAGE;

/**
 * The geometry the reader measures boxes from. With `world.jitter` set, one
 * page's box is a pixel taller on every other render — consistent within a
 * render, different between renders (the profiler below flips it once per
 * commit) — while the height the ResizeObserver reports for it stays put:
 * a real browser's subpixel rounding, which the pin corrects every render.
 */
const boxHeight = (i: number) => {
  const j = world.jitter;
  if (j && j.index === i) return pageHeight(i) + (j.flip ? 1 : 0);
  return pageHeight(i);
};

/** A reader that keeps committing is a loop; past this it is failed rather than waited for. */
const COMMIT_CAP = 2000;

function anchorOf(index: number) {
  const e = spine()[index];
  return { part_index: e.part_index, page_id: e.page_id };
}

/** Renders the reader; returns a way to change the anchor as the app would. */
function mountReader(index: number, highlight: HighlightRequest | null = null) {
  const onActivePage = vi.fn();
  const tree = (at: number, matches: boolean) => (
    <Profiler
      id="reader"
      onRender={() => {
        commits++;
        if (world.jitter) world.jitter.flip = !world.jitter.flip;
        if (commits > COMMIT_CAP) throw new Error(`the reader committed ${commits} times: a render loop`);
      }}
    >
      <BooksProvider api={world.api}>
        <ReaderPanel
          api={world.api}
          bookId={7}
          anchor={anchorOf(at)}
          clickedMatches={matches ? { ...anchorOf(at), indices: [0, 1] } : null}
          highlight={highlight}
          onActivePage={onActivePage}
        />
      </BooksProvider>
    </Profiler>
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

async function openAt(index: number, highlight: HighlightRequest | null = null) {
  const r = mountReader(index, highlight);
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
  commits = 0;
  resizer = installResizeObserver(pageHeight);
  layout = installLayout({ viewportHeight: VIEWPORT, pageHeight: boxHeight });
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

// ---------------------------------------------------------------- resize
//
// Not a navigation: the pane changes width under mounted pages — the sidebar
// folds or opens, the window is resized — and every card reports a new
// height. The reader must settle: the same page in view, and after the quiet
// period no more commits. A state update from a layout effect on every render
// once looped here ("Maximum update depth exceeded") when the sidebar
// reopened over a selection that spanned two cards.

/** A real DOM selection from a word on one card to a word on the next. */
function selectAcross(a: number, b: number) {
  const first = document.querySelector(`[data-page-index="${a}"] [data-token]`);
  const tokens = document.querySelectorAll(`[data-page-index="${b}"] [data-token]`);
  const last = tokens[tokens.length - 1];
  if (!first || !last) throw new Error(`cards ${a} and ${b} are not both loaded`);
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** The cards re-wrap: every mounted page gets a new height. */
function rewrap(factor: number) {
  for (const i of layout.mounted()) world.heights.set(i, Math.round(pageHeight(i) * factor));
}

type Resize = 'sidebarOpens' | 'sidebarCloses' | 'windowWidth' | 'selectionAcrossCards' | 'jitterAbove';
const RESIZES: Resize[] = ['sidebarOpens', 'sidebarCloses', 'windowWidth', 'selectionAcrossCards', 'jitterAbove'];

async function applyResize(kind: Resize) {
  switch (kind) {
    case 'sidebarOpens':
      // The pane narrows and the text re-wraps taller.
      rewrap(1.25);
      resizer.fire(500);
      break;
    case 'sidebarCloses':
      rewrap(0.8);
      resizer.fire(1100);
      break;
    case 'windowWidth':
      rewrap(1.1);
      window.dispatchEvent(new Event('resize'));
      resizer.fire(700);
      break;
    case 'jitterAbove':
      // The page above the pinned one sits a pixel differently on every
      // other render, so the pin nudges scrollTop on every render: the
      // reader must not read a direction of travel off those nudges.
      world.jitter = { index: 49, flip: false };
      rewrap(1.25);
      resizer.fire(500);
      break;
    case 'selectionAcrossCards': {
      // Select from the page in view into the next, then reopen the sidebar.
      const at = observedIndex()!;
      await waitFor(() => expect(document.querySelector(`[data-page-index="${at + 1}"] [data-token]`)).toBeTruthy());
      selectAcross(at, at + 1);
      rewrap(1.25);
      resizer.fire(500);
      break;
    }
  }
}

describe('resize', () => {
  it.each(RESIZES)('%s: the reader settles within the quiet period', async (kind) => {
    await openAt(50);
    const before = observedIndex();
    expect(before).toBe(50);

    await applyResize(kind);
    await settled();

    // Settled: the page in view is the one it was, and nothing moves on its own.
    const after = await quiet();
    const failures: string[] = [];
    if (observedIndex() !== before) failures.push(`observed page is ${observedIndex()}, not ${before}`);
    if (after.scrollMoved) failures.push('scroll moved on its own afterwards');
    if (after.windowChanged) failures.push('mounted window changed on its own afterwards');
    if (after.pageChanged) failures.push('page in view changed on its own afterwards');
    // And quiet: no commits at all once settled.
    const at = commits;
    for (let i = 0; i < 3; i++) await layout.settle();
    await new Promise((r) => setTimeout(r, 100));
    if (commits !== at) failures.push(`${commits - at} commit(s) after settling`);
    expect(failures, `${kind}: ${failures.join('; ')}`).toEqual([]);
  }, 20000);
});

// ---------------------------------------------------------------- scrolling under a search
//
// Reading on with a search running: every page comes with its highlights,
// and a proximity search's page terms come apart, for a second colour. Those
// arrays are props of every card. A card that is handed a new array on every
// render re-measures on every render, and a measurement is a state update:
// "Maximum update depth exceeded" at usePageStack's setHeights, from
// PageView. So: fifty pages down under each kind of search, and once settled
// no commits at all.

const PROXIMITY_WITH_PAGE_TERMS: SearchContext = {
  type: 'proximity',
  proximityQuery: {
    terms: [
      { query: 'نص', mode: 'surface' },
      { query: 'الصفحة', mode: 'surface' },
    ],
    distances: [3],
    ordered: false,
    pageTerms: [{ query: '100', mode: 'surface' }],
  },
};
const PROXIMITY_WITHOUT_PAGE_TERMS: SearchContext = {
  ...PROXIMITY_WITH_PAGE_TERMS,
  proximityQuery: { ...PROXIMITY_WITH_PAGE_TERMS.proximityQuery!, pageTerms: [] },
};
const SEARCHES: [string, SearchContext | null][] = [
  ['proximity with page terms', PROXIMITY_WITH_PAGE_TERMS],
  ['proximity without page terms', PROXIMITY_WITHOUT_PAGE_TERMS],
  ['no search', null],
];

describe('scrolling fifty pages under a search', () => {
  it.each(SEARCHES)('%s: the reader settles, and then commits nothing', async (_name, context) => {
    // The chain's words sit at 0 on every page, the page term at 1 (the
    // page number at 2 is digits, which the tokenizer does not count).
    (world.api.getMatchPositionsCombined as ReturnType<typeof vi.fn>).mockImplementation(
      async (_i: number, _p: number, _page: number, terms: { query: string }[]) => (terms.length === 1 ? [1] : [0])
    );
    // As in a browser, a card's box (border-box, what getBoundingClientRect
    // gives) is its gap taller than what the ResizeObserver reports for it
    // (content-box). Measured once per change the two agree soon enough;
    // measured on every render they never do.
    resizer = installResizeObserver((i) => pageHeight(i) - GAP);
    await openAt(50, highlightRequestOf(context));
    expect(observedIndex()).toBe(50);

    for (let i = 51; i <= 100; i++) {
      await layout.scrollToPage(i);
    }
    await settled();
    expect(observedIndex()).toBe(100);
    if (context) {
      // The highlights came with the pages.
      expect(document.querySelector('[data-page-index="100"] [data-highlight="true"]')).toBeTruthy();
      if (context.proximityQuery!.pageTerms.length > 0) {
        expect(document.querySelector('[data-page-index="100"] [data-highlight="page"]')).toBeTruthy();
      }
    }

    const after = await quiet();
    const failures: string[] = [];
    if (after.scrollMoved) failures.push('scroll moved on its own afterwards');
    if (after.windowChanged) failures.push('mounted window changed on its own afterwards');
    if (after.pageChanged) failures.push('page in view changed on its own afterwards');
    const at = commits;
    for (let i = 0; i < 3; i++) await layout.settle();
    await new Promise((r) => setTimeout(r, 100));
    if (commits !== at) failures.push(`${commits - at} commit(s) after settling`);
    expect(failures, failures.join('; ')).toEqual([]);
  }, 60000);
});
