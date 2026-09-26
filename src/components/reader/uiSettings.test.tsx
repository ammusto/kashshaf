import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { PageEntry, SearchResult, Token, TocNode } from '../../types';
import type { SearchAPI } from '../../api';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { resetTocPaneMemory } from '../../hooks/useTocPane';
import { SettingsModal } from '../modals/SettingsModal';
import { installLayout, installResizeObserver, type FakeLayout, withPageBundle } from './testLayout';

vi.mock('../../contexts/OperatingModeContext', () => ({
  useOperatingMode: () => ({ capabilities: null, refreshCapabilities: vi.fn() }),
}));

/**
 * The two behaviour preferences are honoured: with "auto-show table of
 * contents" off, a book opened from a result does not open the pane; the
 * Settings dialog's toggles report their changes. (Persistence across a
 * reload is tested on the store, in utils/uiSettings.test.ts.)
 */

function spine(): PageEntry[] {
  return Array.from({ length: 6 }, (_, i) => ({ part_index: 0, page_id: i + 1, part_label: '1', page_number: String(i + 1) }));
}

function makeApi() {
  const toc: TocNode[] = [{ id: 1, parent: 0, title: 'باب الصلاة', part_index: 0, page_id: 1, level: 1, children: [] } as unknown as TocNode];
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number) => ({ id, part_index: part, page_id: page, part_label: '1', page_number: String(page), body: `نص ${page}`, score: 1, matched_token_indices: [] } as unknown as SearchResult)),
    getPageTokens: vi.fn(async (_i: number, _p: number, page: number) => ['نص', String(page)].map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[]),
    getBookToc: vi.fn(async () => toc),
    getPageByLabel: vi.fn(async () => null),
    getMatchPositionsCombined: vi.fn(async () => []),
    getNameMatchPositions: vi.fn(async () => []),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

let layout: FakeLayout;

async function open(autoShowToc: boolean) {
  const api = makeApi();
  render(
    <BooksProvider api={api}>
      <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: 1 }} clickedMatches={{ part_index: 0, page_id: 1, indices: [0] }} autoShowToc={autoShowToc} />
    </BooksProvider>
  );
  await waitFor(() => expect(document.querySelector('[data-page-index="0"]')).toBeTruthy());
  await layout.settle();
}

beforeEach(() => {
  resetTocPaneMemory();
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

describe('auto-show table of contents', () => {
  it('opens the pane from a result when on', async () => {
    await open(true);
    await waitFor(() => expect(screen.queryByTestId('toc-pane')).toBeInTheDocument());
  });

  it('leaves the pane closed when off, and the button still opens it', async () => {
    await open(false);
    await layout.settle();
    expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }));
    await waitFor(() => expect(screen.queryByTestId('toc-pane')).toBeInTheDocument());
  });
});

describe('the Settings dialog', () => {
  it('shows both preferences and reports a change', () => {
    const onUiChange = vi.fn();
    render(<SettingsModal onClose={() => {}} isOnlineMode ui={{ autoCollapseSidebar: true, autoShowToc: false }} onUiChange={onUiChange} />);
    const collapse = screen.getByTestId('setting-auto-collapse') as HTMLInputElement;
    const toc = screen.getByTestId('setting-auto-toc') as HTMLInputElement;
    expect(collapse.checked).toBe(true);
    expect(toc.checked).toBe(false);
    fireEvent.click(collapse);
    fireEvent.click(toc);
    expect(onUiChange).toHaveBeenCalledWith('autoCollapseSidebar', false);
    expect(onUiChange).toHaveBeenCalledWith('autoShowToc', true);
  });
});
