import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { PageEntry, SearchResult, Token, TocNode, SearchResults } from './types';
import type { SearchAPI } from './api';
import { SearchTabsProvider } from './contexts/SearchTabsContext';
import { SearchFormProvider } from './contexts/SearchFormContext';
import { resetTocPaneMemory } from './hooks/useTocPane';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './components/reader/testLayout';
import App from './App';

/**
 * Open Text and Search in Text, through the whole app.
 *
 * Open Text (corpus browser → detail view) mounts the reader at the book's
 * first page in reading order with the contents pane open and the results
 * pane at its minimum height; the selection and the loaded results stay,
 * and dragging the pane back up shows the results. Search in Text with no
 * selection sets this text and asks nothing; with a selection it asks, and
 * each answer does what it says, a text already selected is not added twice,
 * and the top bar's count follows every change.
 */

const BOOKS = [
  { id: 7, title: 'كتاب سبعة', author_id: 1, parts: 1, in_corpus: true, page_count: 3 },
  { id: 8, title: 'كتاب ثمانية', author_id: 1, parts: 1, in_corpus: true, page_count: 4 },
];

function spineOf(id: number): PageEntry[] {
  const n = id === 7 ? 3 : 4;
  return Array.from({ length: n }, (_, i) => ({ part_index: 0, page_id: i + 1, part_label: '1', page_number: String(i + 1) }));
}

const hit = (id: number, page: number): SearchResult =>
  ({ id, part_index: 0, page_id: page, part_label: '1', page_number: String(page), body: `نص ${page}`, score: 1, matched_token_indices: [0] }) as unknown as SearchResult;

const api = withPageBundle({
  combinedSearch: vi.fn(async (): Promise<SearchResults> => ({ query: 'نص', mode: 'surface', total_hits: 2, results: [hit(7, 2), hit(7, 3)], elapsed_ms: 1 })),
  getWalkStatus: vi.fn(async () => null),
  listBookPages: vi.fn(async (id: number) => spineOf(id)),
  getPage: vi.fn(async (id: number, part: number, page: number) => ({ id, part_index: part, page_id: page, part_label: '1', page_number: String(page), body: `نص ${page}`, score: 1, matched_token_indices: [] }) as unknown as SearchResult),
  getPageTokens: vi.fn(async (_i: number, _p: number, page: number) => ['نص', String(page)].map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[]),
  getBookToc: vi.fn(async () => [{ id: 1, parent: 0, title: 'باب', part_index: 0, page_id: 1, page_number: '1', depth: 0, children: [] }] as unknown as TocNode[]),
  getPageByLabel: vi.fn(async () => null),
  getMatchPositionsCombined: vi.fn(async () => [0]),
  getNameMatchPositions: vi.fn(async () => []),
  getAllBooks: vi.fn(async () => BOOKS),
  getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
  getGenres: vi.fn(async () => []),
} as unknown as SearchAPI);

vi.mock('./contexts/OperatingModeContext', () => ({
  useOperatingMode: () => ({
    mode: 'online',
    corpusDownloaded: false,
    loading: false,
    api,
    setMode: vi.fn(),
    refreshCorpusStatus: vi.fn(async () => {}),
    capabilities: null,
    refreshCapabilities: vi.fn(async () => {}),
  }),
  saveOnlineModePreference: vi.fn(async () => {}),
}));
vi.mock('./utils/platform', () => ({ isWebTarget: () => true, isDesktopTarget: () => false, getApiBaseUrl: () => '' }));
vi.mock('./utils/announcements', () => ({ getEligibleAnnouncements: vi.fn(async () => []) }));
// jsdom has no layout, so the virtual lists would render nothing: every row is "in view".
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: index, start: index * 56, size: 56 })),
    getTotalSize: () => opts.count * 56,
    scrollToIndex: () => {},
    scrollToOffset: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

let layout: FakeLayout;

beforeEach(() => {
  resetTocPaneMemory();
  localStorage.clear();
  installResizeObserver(() => 900);
  layout = installLayout({ viewportHeight: 600, pageHeight: () => 900 });
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

const status = () => screen.getByTestId('text-selection-status');
const readerFlex = () => (screen.getByTestId('reader-pane') as HTMLElement).style.flexGrow;
const resultRows = () => within(screen.getByTestId('results-pane')).queryAllByText('كتاب سبعة');

/** Render the app, run a search, and wait for the reader to open the first hit. */
async function boot() {
  render(
    <SearchTabsProvider>
      <SearchFormProvider>
        <App />
      </SearchFormProvider>
    </SearchTabsProvider>
  );
  await waitFor(() => expect(status()).toHaveTextContent('Searching: All Texts'));
  fireEvent.change(screen.getByPlaceholderText('ابحث...'), { target: { value: 'نص' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(resultRows().length).toBe(2));
  await waitFor(() => expect(document.querySelector('[data-page-index]')).toBeTruthy());
  await layout.settle();
}

/** Browse Texts → the book's row → Open Text. */
async function openText(title: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Browse Texts' }));
  const row = await screen.findByText(title);
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Text' }));
}

/** The reader's book, as its header names it. */
const readerTitle = () => within(screen.getByTestId('reader-pane')).getByTitle('View book details');

describe('Open Text', () => {
  it('reads the text from its first page with the contents pane open and the results pane at its minimum, keeping the selection and results', async () => {
    await boot();
    // A selection to keep: this text (no selection → set, no modal).
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    expect(status()).toHaveTextContent('Searching: 1 Texts');
    // The pane opened with the result; close it, so Open Text is seen to open it.
    await waitFor(() => expect(screen.queryByTestId('toc-pane')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument();
    expect(readerFlex()).toBe('0.6');

    await openText('كتاب ثمانية');

    // The reader is on book 8 at its first page in reading order.
    await waitFor(() => expect(readerTitle()).toHaveTextContent('كتاب ثمانية'));
    await waitFor(() => expect(api.getPage).toHaveBeenCalledWith(8, 0, 1));
    await layout.settle();
    expect(document.querySelector('[data-page-index="0"]')).toBeTruthy();
    // The contents pane is open, whatever the session had.
    expect(screen.getByTestId('toc-pane')).toBeInTheDocument();
    // The results pane is at its minimum height, the reader has the rest.
    expect(readerFlex()).toBe('0.8');
    // The browser closed; no search ran.
    expect(screen.queryByRole('button', { name: 'Open Text' })).not.toBeInTheDocument();
    expect(api.combinedSearch).toHaveBeenCalledTimes(1);
    // The selection and the loaded results are as they were.
    expect(status()).toHaveTextContent('Searching: 1 Texts');
    expect(resultRows().length).toBe(2);

    // Dragging the pane back up shows what was there.
    const splitter = screen.getByTestId('splitter');
    vi.spyOn(splitter.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 1000, left: 0, width: 800, right: 800, bottom: 1000, x: 0, y: 0, toJSON() {} } as DOMRect);
    fireEvent.mouseDown(splitter, { clientY: 800 });
    fireEvent.mouseMove(document, { clientY: 500 });
    fireEvent.mouseUp(document);
    expect(readerFlex()).toBe('0.5');
    expect(resultRows().length).toBe(2);
  });
});

describe('Search in Text', () => {
  it('with no selection sets this text and asks nothing; with one, each answer does what it says and the count follows', async () => {
    await boot();
    expect(status()).toHaveTextContent('Searching: All Texts');

    // No selection: set, no modal.
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent('Searching: 1 Texts');

    // Another text in the reader, with a selection: the question.
    await openText('كتاب ثمانية');
    await waitFor(() => expect(readerTitle()).toHaveTextContent('كتاب ثمانية'));
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Add this text to your current selection');

    // Add to Selection: two texts.
    fireEvent.click(screen.getByRole('button', { name: 'Add to Selection' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent('Searching: 2 Texts');
    expect(screen.getByText('Added to your selection. Searching 2 texts.')).toBeInTheDocument();

    // Adding it again: not duplicated, and said so.
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Selection' }));
    expect(status()).toHaveTextContent('Searching: 2 Texts');
    expect(screen.getByText('This text is already in your selection. Searching 2 texts.')).toBeInTheDocument();

    // Cancel: nothing changes.
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent('Searching: 2 Texts');

    // Clear Selection: this text alone.
    fireEvent.click(screen.getByRole('button', { name: 'Search in Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Selection' }));
    expect(status()).toHaveTextContent('Searching: 1 Texts');
    expect(screen.getByText('Selection cleared. Searching this text only.')).toBeInTheDocument();

    // No search was run by any of it.
    expect(api.combinedSearch).toHaveBeenCalledTimes(1);
  });
});
