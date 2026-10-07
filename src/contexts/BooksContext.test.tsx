import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { BookMetadata } from '../types';
import type { SearchAPI } from '../api';
import { BooksProvider, useBooks, useFullBook } from './BooksContext';
import { resetFullRowCache } from '../utils/catalog';

/**
 * The provider over the light catalogue: rows without an `in_corpus` field
 * are kept (the server already filtered), a desktop row saying false is
 * dropped; and `useFullBook` shows the light row at once, fetches the full
 * row once, and does not fetch for a row that is already full.
 */

const light = (id: number, extra: Partial<BookMetadata> = {}): BookMetadata =>
  ({ id, title: `كتاب ${id}`, author_id: 1, death_ah: 450, genre_id: 2, page_count: 10, token_count: 100, parts: 1, ...extra });

function makeApi(rows: BookMetadata[]) {
  return {
    getAllBooks: vi.fn(async () => rows),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => [[2, 'فقه']]),
    getBook: vi.fn(async (id: number) => ({ ...light(id), metadata_json: `{"id":${id}}`, citation_json: '{}', tags: '["t"]' })),
  } as unknown as SearchAPI;
}

function Count() {
  const { books, loading } = useBooks();
  return <div data-testid="count">{loading ? 'loading' : books.map((b) => b.id).join(',')}</div>;
}

function Detail({ id }: { id: number }) {
  const { booksMap } = useBooks();
  const book = useFullBook(booksMap.get(id));
  return <div data-testid="detail">{book ? `${book.title}|${book.metadata_json ?? 'light'}` : 'none'}</div>;
}

beforeEach(() => resetFullRowCache());

describe('the catalogue provider', () => {
  it('keeps light rows and drops a desktop row marked out of the corpus', async () => {
    const api = makeApi([light(1), light(2, { in_corpus: false }), light(3, { in_corpus: true })]);
    render(
      <BooksProvider api={api}>
        <Count />
      </BooksProvider>
    );
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1,3'));
  });
});

describe('useFullBook', () => {
  it('shows the light row at once and the full row once fetched, fetching once', async () => {
    const api = makeApi([light(5)]);
    const { rerender } = render(
      <BooksProvider api={api}>
        <Detail id={5} />
      </BooksProvider>
    );
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('كتاب 5|'));
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('كتاب 5|{"id":5}'));
    rerender(
      <BooksProvider api={api}>
        <Detail id={5} />
      </BooksProvider>
    );
    expect(api.getBook).toHaveBeenCalledTimes(1);
  });

  it('does not fetch for a row that is already full', async () => {
    const api = makeApi([light(6, { metadata_json: '{"full":true}', citation_json: '{}', tags: '[]' })]);
    render(
      <BooksProvider api={api}>
        <Detail id={6} />
      </BooksProvider>
    );
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('{"full":true}'));
    expect(api.getBook).not.toHaveBeenCalled();
  });
});
