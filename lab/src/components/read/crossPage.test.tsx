import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultRow } from './ResultRow';
import { SearchForm } from './SearchForm';
import { Pages } from '../../api/pages';
import type { Hit } from '../../api/search';

/**
 * Matches across page breaks in Lab's Read panel: the hit row says where
 * the rest of the match is (C1 label), and a phrase longer than the
 * boundary index covers gets a note under its input, not a refusal.
 */

const pages = new Pages(
  [
    { book_id: 7, part_index: 1, page_id: 9, part_label: '2', page_number: '9' },
    { book_id: 7, part_index: 1, page_id: 10, part_label: '2', page_number: '10' },
    { book_id: 7, part_index: 1, page_id: 11, part_label: '2', page_number: '11' },
  ],
  2
);

function hit(secondaryAfter: boolean): Hit {
  return {
    part_index: 1,
    page_id: 10,
    part_label: '2',
    page_number: '10',
    body: 'كلام قبل معرفة الله',
    score: 1,
    matched: [2, 3],
    crosses_page: true,
    secondary: secondaryAfter
      ? { part_index: 1, page_id: 11, part_label: '2', page_number: '11', matched: [0] }
      : { part_index: 1, page_id: 9, part_label: '2', page_number: '9', matched: [40] },
  };
}

describe('a hit across a page break', () => {
  it('says where the rest is, by the page label (C1: the number alone when the pages are all in one part)', () => {
    render(<ResultRow hit={hit(true)} pages={pages} section={null} onClick={() => {}} />);
    expect(screen.getByTestId('continuation')).toHaveTextContent('continues on p. 11');
  });

  it('says "continues from" when the match began on the page before', () => {
    render(<ResultRow hit={hit(false)} pages={pages} section={null} onClick={() => {}} />);
    expect(screen.getByTestId('continuation')).toHaveTextContent('continues from p. 9');
  });

  it('a plain hit has no marker', () => {
    render(<ResultRow hit={{ ...hit(true), crosses_page: false, secondary: undefined }} pages={pages} section={null} onClick={() => {}} />);
    expect(screen.queryByTestId('continuation')).not.toBeInTheDocument();
  });
});

describe('a long phrase in the search form', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `كلمة${i}`).join(' ');
  const form = (query: string) => (
    <SearchForm
      tab="and"
      onTab={() => {}}
      andInputs={[{ id: 1, query, mode: 'surface', cliticToggle: false }]}
      orInputs={[]}
      onChange={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      onSearch={() => {}}
      onClear={() => {}}
      running={false}
      disabled={false}
    />
  );
  it('gets a quiet note past 21 tokens', () => {
    const { rerender } = render(form(words(21)));
    expect(screen.queryByTestId('long-phrase-note')).not.toBeInTheDocument();
    rerender(form(words(22)));
    expect(screen.getByTestId('long-phrase-note')).toHaveTextContent('Long phrases may not be found where they cross a page break.');
    expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled();
  });
});
