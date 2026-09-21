import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SearchAPI } from '../../api';
import type { SearchResult } from '../../types';
import { BooksProvider } from '../../contexts/BooksContext';
import { SearchResultRow } from './SearchResultRow';

/**
 * A 0.8.0 server sends a result row's body already cut to the snippet
 * around its first highlight, with `snippet_start_token` saying which page
 * token it starts at; the row places the page's highlight indices in it by
 * that offset. An older server sends the page and no offset, and the row
 * cuts it itself as before.
 */

function api(): SearchAPI {
  return {
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts: 1, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
}

const base = {
  id: 7,
  part_index: 0,
  page_id: 10,
  part_label: '1',
  page_number: '10',
  score: 1,
} as unknown as SearchResult;

function row(result: Partial<SearchResult>) {
  return render(
    <BooksProvider api={api()}>
      <SearchResultRow result={{ ...base, ...result } as SearchResult} onClick={() => {}} />
    </BooksProvider>
  );
}

function highlighted(): string[] {
  return [...document.querySelectorAll('span.bg-red-100')].map((el) => el.textContent ?? '');
}

describe('a result row with a snippet from the server', () => {
  it('places the page highlight indices by the snippet start', () => {
    row({ body: 'كلمة اولى معرفة الله كلمة', matched_token_indices: [37, 38], snippet_start_token: 35 });
    expect(highlighted()).toEqual(['معرفة', 'الله']);
    expect(screen.getByText(/^… /)).toBeInTheDocument();
  });

  it('shows no ellipsis when the snippet is the head of the page', () => {
    row({ body: 'معرفة الله كلمة', matched_token_indices: [0, 1], snippet_start_token: 0 });
    expect(highlighted()).toEqual(['معرفة', 'الله']);
    expect(screen.queryByText(/^… /)).toBeNull();
  });

  it('still cuts a whole page from an older server', () => {
    const words = Array.from({ length: 80 }, (_, i) => `كلمة${'ا'.repeat(i % 3)}`);
    words[40] = 'معرفة';
    row({ body: words.join(' '), matched_token_indices: [40] });
    expect(highlighted()).toEqual(['معرفة']);
    expect(screen.getByText(/^… /)).toBeInTheDocument();
  });
});
