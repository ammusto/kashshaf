import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { SearchAPI } from '../../api';
import type { SearchResult } from '../../types';
import { BooksProvider } from '../../contexts/BooksContext';
import { SearchResultRow } from './SearchResultRow';
import { VirtualizedResultsList } from './VirtualizedResultsList';

/**
 * The row of the page open in the reader (the clicked one, or the first of a
 * new search) is marked with the same light accent the Boolean form's AND /
 * OR toggle uses; every other row keeps its hover.
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, size: 48, start: index * 48, key: index })),
    scrollToIndex: () => {},
  }),
}));

function api(): SearchAPI {
  return {
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
}

const result = (page_id: number): SearchResult =>
  ({ id: 7, part_index: 0, page_id, part_label: '1', page_number: String(page_id), body: 'نص', score: 1, matched_token_indices: [] }) as unknown as SearchResult;

describe('the selected result row', () => {
  it('is marked, and an unselected one is not', () => {
    const { container, rerender } = render(
      <BooksProvider api={api()}>
        <SearchResultRow result={result(10)} onClick={() => {}} selected />
      </BooksProvider>
    );
    const row = container.querySelector('[data-selected="true"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.className).toContain('bg-app-accent-light');
    expect(row.getAttribute('aria-selected')).toBe('true');

    rerender(
      <BooksProvider api={api()}>
        <SearchResultRow result={result(10)} onClick={() => {}} />
      </BooksProvider>
    );
    expect(container.querySelector('[data-selected]')).toBeNull();
    expect((container.firstChild as HTMLElement).className).toContain('hover:bg-app-surface-variant');
  });

  it('the list marks exactly the row whose page is open', () => {
    const { container } = render(
      <BooksProvider api={api()}>
        <VirtualizedResultsList
          results={[result(10), result(11), result(12)]}
          onResultClick={() => {}}
          onLoadMore={() => {}}
          loadingMore={false}
          totalHits={3}
          maxResults={100}
          selected={{ id: 7, part_index: 0, page_id: 11 }}
        />
      </BooksProvider>
    );
    const marked = [...container.querySelectorAll('[data-selected="true"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('11');
  });
});
