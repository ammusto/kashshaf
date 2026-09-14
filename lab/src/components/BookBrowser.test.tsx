import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';
import { BookBrowser } from './BookBrowser';

function book(id: number, title: string, death?: number): BookMetadata {
  return { id, title, death_ah: death, page_count: 100, in_corpus: true };
}

const BOOKS = [
  book(1, 'صحيح البخاري', 256),
  book(2, 'الكامل في التاريخ', 630),
  book(3, 'مسند أحمد', 241),
];

describe('BookBrowser', () => {
  it('lists every book with its count', () => {
    render(
      <BookBrowser books={BOOKS} currentId={null} onSelect={vi.fn()} loading={false} error={null} />
    );
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByTestId('book-count')).toHaveTextContent('3 of 3 books');
  });

  it('filters by title and by id', () => {
    render(
      <BookBrowser books={BOOKS} currentId={null} onSelect={vi.fn()} loading={false} error={null} />
    );
    const input = screen.getByLabelText('Search titles');
    fireEvent.change(input, { target: { value: 'البخاري' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByTestId('book-count')).toHaveTextContent('1 of 3 books');

    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('الكامل في التاريخ')).toBeInTheDocument();
  });

  it('ignores punctuation in the query, as Kashshaf does', () => {
    render(
      <BookBrowser books={BOOKS} currentId={null} onSelect={vi.fn()} loading={false} error={null} />
    );
    fireEvent.change(screen.getByLabelText('Search titles'), {
      target: { value: '«البخاري»،' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('says so when nothing matches', () => {
    render(
      <BookBrowser books={BOOKS} currentId={null} onSelect={vi.fn()} loading={false} error={null} />
    );
    fireEvent.change(screen.getByLabelText('Search titles'), { target: { value: 'زززز' } });
    expect(screen.getByText('No book matches that.')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('marks the current book as selected and reports a choice', () => {
    const onSelect = vi.fn();
    render(
      <BookBrowser books={BOOKS} currentId={2} onSelect={onSelect} loading={false} error={null} />
    );
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(options[2]);
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('shows loading and error states instead of an empty list', () => {
    const { rerender } = render(
      <BookBrowser books={[]} currentId={null} onSelect={vi.fn()} loading error={null} />
    );
    expect(screen.getByTestId('book-count')).toHaveTextContent('Loading books…');

    rerender(
      <BookBrowser
        books={[]}
        currentId={null}
        onSelect={vi.fn()}
        loading={false}
        error="Corpus frequency is not available in this mode"
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('not available in this mode');
    expect(screen.getByTestId('book-count')).toHaveTextContent('Books unavailable');
  });
});
