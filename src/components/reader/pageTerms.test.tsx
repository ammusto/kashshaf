import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PageEntry, SearchResult, Token } from '../../types';
import type { SearchTerm, SearchAPI } from '../../api';
import type { SearchContext } from '../../types/search';
import { ReaderPanel } from '../panels/ReaderPanel';
import { BooksProvider } from '../../contexts/BooksContext';
import { highlightRequestOf } from '../../utils/highlightRequest';
import { toRuns } from './PageView';
import { installLayout, installResizeObserver, withPageBundle, type FakeLayout } from './testLayout';

/**
 * A proximity search's page-level terms are highlighted apart from the
 * chain: the chain in the match colour, the page terms in a second one. The
 * page request carries them separately, so the reader can tell them apart.
 */

const PAGE_HEIGHT = 900;
let layout: FakeLayout;

const WORDS = ['قال', 'الله', 'النبي', 'كلام'];

function spine(): PageEntry[] {
  return Array.from({ length: 3 }, (_, i) => ({ part_index: 0, page_id: i + 1, part_label: '1', page_number: String(i + 1) }));
}

function makeApi() {
  return withPageBundle({
    listBookPages: vi.fn(async () => spine()),
    getPage: vi.fn(async (id: number, part: number, page: number): Promise<SearchResult> => ({
      id,
      part_index: part,
      page_id: page,
      part_label: '1',
      page_number: String(page),
      body: WORDS.join(' '),
      score: 1,
      matched_token_indices: [],
    } as unknown as SearchResult)),
    getPageTokens: vi.fn(async (): Promise<Token[]> =>
      WORDS.map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun' })) as unknown as Token[]
    ),
    // The chain's terms sit at 0 and 1; the page term at 2.
    getMatchPositionsCombined: vi.fn(async (_id: number, _part: number, _page: number, terms: SearchTerm[]) =>
      terms.some((t) => t.query === 'النبي') ? [2] : [0, 1]
    ),
    getNameMatchPositions: vi.fn(async () => []),
    getPageByLabel: vi.fn(async () => null),
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI);
}

const context: SearchContext = {
  type: 'proximity',
  proximityQuery: {
    terms: [
      { query: 'قال', mode: 'surface' },
      { query: 'الله', mode: 'surface' },
    ],
    distances: [3],
    ordered: false,
    pageTerms: [{ query: 'النبي', mode: 'surface' }],
  },
};

function marked(index: number, kind: 'true' | 'page'): string[] {
  const page = document.querySelector(`[data-page-index="${index}"]`);
  if (!page) return [];
  return [...page.querySelectorAll(`[data-highlight="${kind}"]`)].map((el) => el.textContent ?? '');
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

describe('page terms in the reader', () => {
  it('the highlight request carries the page terms apart from the chain, in its key', () => {
    const req = highlightRequestOf(context)!;
    expect(req.terms).toEqual([
      { query: 'قال', mode: 'surface' },
      { query: 'الله', mode: 'surface' },
    ]);
    expect(req.pageTerms).toEqual([{ query: 'النبي', mode: 'surface' }]);
    const without = highlightRequestOf({ ...context, proximityQuery: { ...context.proximityQuery!, pageTerms: [] } })!;
    expect(without.pageTerms).toBeUndefined();
    expect(without.key).not.toBe(req.key);
  });

  it('marks the chain in the match colour and the page term in the second', async () => {
    const api = makeApi();
    render(
      <BooksProvider api={api}>
        <ReaderPanel api={api} bookId={7} anchor={{ part_index: 0, page_id: 2 }} highlight={highlightRequestOf(context)} />
      </BooksProvider>
    );
    await waitFor(() => expect(marked(1, 'true')).toEqual(['قال', 'الله']));
    expect(marked(1, 'page')).toEqual(['النبي']);
    // Two lookups per page: the chain's, and the page terms'.
    const calls = (api.getMatchPositionsCombined as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[2] === 2);
    expect(calls.map((c) => (c[3] as SearchTerm[]).map((t) => t.query))).toEqual(
      expect.arrayContaining([['قال', 'الله'], ['النبي']])
    );
  });

  it('a character in both sets is the match', () => {
    const runs = toRuns('ab cd', [0, 0, null, 1, 1], new Set([0, 1]), new Set([0, 1, 3, 4]));
    expect(runs).toEqual([
      { text: 'ab', token: 0, highlighted: true, secondary: false },
      { text: ' ', token: null, highlighted: false, secondary: false },
      { text: 'cd', token: 1, highlighted: false, secondary: true },
    ]);
  });
});
