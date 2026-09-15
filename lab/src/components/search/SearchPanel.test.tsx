import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * Search within the open text (spec 1.5 §D): Kashshaf's boolean form, so the
 * two apps answer the same query the same way. What is tested is the shape of
 * the query that reaches the backend — the AND and OR lists, the mode per
 * term, and the clitic expansion — and that a result row leads back into the
 * reader at the page it names.
 */

const api = vi.hoisted(() => ({
  search: { book: vi.fn() },
  lab: { listPages: vi.fn(async (): Promise<unknown[]> => []) },
}));

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/search', async () => {
  const real = await vi.importActual<typeof import('../../api/search')>('../../api/search');
  return { ...real, searchApi: api.search };
});

import { SearchPanel } from './SearchPanel';
import { expandWithClitics } from '../../api/search';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };

const results = {
  hits: [
    {
      part_index: 0,
      page_id: 12,
      part_label: 'ج١',
      page_number: '19',
      body: 'وقال حدثنا ابو بكر عن الزهد في الدنيا',
      score: 3.2,
      matched: [5, 6],
    },
  ],
  total: 1,
  elapsed_ms: 8,
  capped: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.lab.listPages.mockResolvedValue([{ book_id: 527, part_index: 0, page_id: 12, page_number: '19', part_label: 'ج١' }]);
  api.search.book.mockResolvedValue(results);
});

describe('SearchPanel', () => {
  it('asks for a text first', () => {
    render(<SearchPanel book={null} onShowHit={vi.fn()} />);
    expect(screen.getByText(/Open a text from the workspace/)).toBeInTheDocument();
  });

  it('sends an ANDed term on the layer chosen for it', async () => {
    render(<SearchPanel book={book} onShowHit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'الزهد' } });
    fireEvent.click(screen.getByRole('button', { name: 'Root' }));
    fireEvent.click(screen.getByTestId('run-search'));

    await waitFor(() =>
      expect(api.search.book).toHaveBeenCalledWith(
        expect.objectContaining({ book_id: 527, and_terms: [{ query: 'الزهد', mode: 'root' }], or_terms: [] })
      )
    );
  });

  it('turns the clitic toggle into the OR terms Kashshaf would send', async () => {
    render(<SearchPanel book={book} onShowHit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'الزهد' } });
    fireEvent.click(screen.getByLabelText('Ignore clitics'));
    fireEvent.click(screen.getByTestId('run-search'));

    await waitFor(() => expect(api.search.book).toHaveBeenCalled());
    const args = api.search.book.mock.calls[0][0];
    expect(args.and_terms).toEqual([]);
    // The word, then the word behind each of the five proclitics.
    expect(args.or_terms.map((t: { query: string }) => t.query)).toEqual(expandWithClitics('الزهد'));
    expect(args.or_terms).toHaveLength(6);
  });

  it('allows three terms at most on a tab', async () => {
    render(<SearchPanel book={book} onShowHit={vi.fn()} />);
    const add = () => screen.queryByRole('button', { name: '+ Add a term' });
    fireEvent.click(add()!);
    fireEvent.click(add()!);
    expect(screen.getAllByLabelText('Term')).toHaveLength(3);
    expect(add()).toBeNull();
  });

  it('labels a hit by its printed page and opens the reader there', async () => {
    const onShowHit = vi.fn();
    render(<SearchPanel book={book} onShowHit={onShowHit} />);
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'الزهد' } });
    fireEvent.click(screen.getByTestId('run-search'));

    const hit = await screen.findByTestId('search-hit');
    // Spec C1: one part, so the printed number alone -- not the page id 12.
    expect(hit).toHaveTextContent('19');
    expect(hit).toHaveTextContent('حدثنا ابو بكر');

    fireEvent.click(hit);
    expect(onShowHit).toHaveBeenCalledWith({ part_index: 0, page_id: 12 }, [5, 6]);
  });
});
