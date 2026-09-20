import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SearchResult } from '../../types';
import type { SearchAPI } from '../../api';
import { SearchResultRow } from './SearchResultRow';
import { BooksProvider } from '../../contexts/BooksContext';
import { SearchInputRow } from '../sidebar/SearchInputRow';
import { PageView } from '../reader/PageView';

/**
 * Matches across page breaks, as the app shows them: the result row says at
 * its edge where the rest of the match is, the page card marks the edge a
 * highlight runs off, and a phrase longer than the boundary index covers
 * gets a note under the input rather than a refusal.
 */

function api(parts: number) {
  return {
    getAllBooks: vi.fn(async () => [{ id: 7, title: 'كتاب', author_id: 1, parts, in_corpus: true }]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
}

function crossing(secondaryAfter: boolean): SearchResult {
  return {
    id: 7,
    part_index: 1,
    page_id: 10,
    part_label: '2',
    page_number: '10',
    body: 'كلام قبل معرفة الله',
    score: 1,
    matched_token_indices: [2, 3],
    crosses_page: true,
    secondary: secondaryAfter
      ? { part_index: 1, page_id: 11, part_label: '2', page_number: '11', matched_token_indices: [0] }
      : { part_index: 1, page_id: 9, part_label: '2', page_number: '9', matched_token_indices: [40] },
  };
}

describe('a result across a page break', () => {
  it('says where the rest is, by the C1 label, and highlights only its own share', async () => {
    render(
      <BooksProvider api={api(2)}>
        <SearchResultRow result={crossing(true)} onClick={() => {}} />
      </BooksProvider>
    );
    expect(await screen.findByTestId('continuation')).toHaveTextContent('continues on p. 2:11');
    // The primary page's share: the two last words.
    const marked = [...document.querySelectorAll('.bg-red-100')].map((e) => e.textContent);
    expect(marked.join(' ')).toContain('معرفة');
    expect(marked.join(' ')).not.toContain('كلام');
  });

  it('says "continues from" when the match began on the page before, without the volume in a one-part book', async () => {
    render(
      <BooksProvider api={api(1)}>
        <SearchResultRow result={crossing(false)} onClick={() => {}} />
      </BooksProvider>
    );
    expect(await screen.findByTestId('continuation')).toHaveTextContent('continues from p. 9');
  });

  it('a plain result has no marker', async () => {
    const r = { ...crossing(true), crosses_page: false, secondary: undefined };
    render(
      <BooksProvider api={api(2)}>
        <SearchResultRow result={r} onClick={() => {}} />
      </BooksProvider>
    );
    await screen.findByText(/معرفة/);
    expect(screen.queryByTestId('continuation')).not.toBeInTheDocument();
  });
});

describe('the page card', () => {
  const tokens = ['كلام', 'قبل', 'معرفة', 'الله'].map((surface, idx) => ({ idx, surface, lemma: surface, root: null, pos: 'noun', features: [], clitics: [] }));
  const props = {
    index: 3,
    body: 'كلام قبل معرفة الله',
    tokens: tokens as never,
    matched: [2, 3],
    label: '2:10',
    startsPart: false,
    partLabel: 'Part 2',
    onWordClick: () => {},
    onMeasure: () => {},
    onMount: () => {},
  };

  it('marks the edge a highlight runs off, and only that edge', () => {
    const { rerender } = render(<PageView {...props} continues={{ prev: false, next: true }} />);
    expect(screen.getByTestId('continues-next')).toBeInTheDocument();
    expect(screen.queryByTestId('continues-prev')).not.toBeInTheDocument();
    rerender(<PageView {...props} continues={{ prev: true, next: false }} />);
    expect(screen.getByTestId('continues-prev')).toBeInTheDocument();
    expect(screen.queryByTestId('continues-next')).not.toBeInTheDocument();
    rerender(<PageView {...props} />);
    expect(screen.queryByTestId('continues-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('continues-next')).not.toBeInTheDocument();
  });
});

describe('a long phrase', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `كلمة${i}`).join(' ');
  it('gets a quiet note past 21 tokens, and is not refused', () => {
    const { rerender } = render(
      <SearchInputRow input={{ id: 1, query: words(21), mode: 'surface', cliticToggle: false }} onChange={() => {}} onRemove={() => {}} canRemove={false} />
    );
    expect(screen.queryByTestId('long-phrase-note')).not.toBeInTheDocument();
    rerender(
      <SearchInputRow input={{ id: 1, query: words(22), mode: 'surface', cliticToggle: false }} onChange={() => {}} onRemove={() => {}} canRemove={false} />
    );
    expect(screen.getByTestId('long-phrase-note')).toHaveTextContent('Long phrases may not be found where they cross a page break.');
    // The input keeps its text: nothing is capped.
    expect((screen.getByPlaceholderText('ابحث...') as HTMLInputElement).value.split(' ')).toHaveLength(22);
  });
});
