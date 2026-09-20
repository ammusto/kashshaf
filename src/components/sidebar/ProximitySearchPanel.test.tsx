import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchFormProvider } from '../../contexts/SearchFormContext';
import { ProximitySearchPanel } from './ProximitySearchPanel';

/**
 * The proximity form: two rows and a distance as ever; "Add term" chains a
 * third with its own distance, and no fourth; "Ordered" is a switch; "Add
 * page term" adds up to two rows set apart from the chain. What Search
 * emits is the chain query, blank page terms left out.
 */

function renderPanel() {
  const onSearch = vi.fn();
  render(
    <SearchFormProvider>
      <ProximitySearchPanel onSearch={onSearch} onClearForm={() => {}} loading={false} />
    </SearchFormProvider>
  );
  return { onSearch };
}

const typeInto = (label: string, text: string) => {
  const row = screen.getByText(label).closest('[data-testid$="-term-row"]')!;
  fireEvent.change(row.querySelector('input[type="text"]')!, { target: { value: text } });
};

describe('ProximitySearchPanel', () => {
  it('starts as two terms with one distance, no page terms', () => {
    renderPanel();
    expect(screen.getAllByTestId('proximity-term-row')).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(1);
    expect(screen.queryAllByTestId('page-term-row')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('emits the two-term query as a chain', () => {
    const { onSearch } = renderPanel();
    typeInto('Term 1', 'قال');
    typeInto('Term 2', 'الله');
    fireEvent.change(screen.getByLabelText('Distance 1'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledWith({
      terms: [
        { query: 'قال', mode: 'surface' },
        { query: 'الله', mode: 'surface' },
      ],
      distances: [7],
      ordered: false,
      pageTerms: [],
    });
  });

  it('chains a third term with its own distance, and no fourth', () => {
    const { onSearch } = renderPanel();
    fireEvent.click(screen.getByTestId('add-proximity-term'));
    expect(screen.getAllByTestId('proximity-term-row')).toHaveLength(3);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(2);
    expect(screen.queryByTestId('add-proximity-term')).toBeNull();
    typeInto('Term 1', 'قال');
    typeInto('Term 2', 'الله');
    typeInto('Term 3', 'رسول');
    fireEvent.change(screen.getByLabelText('Distance 2'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Ordered/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledWith({
      terms: [
        { query: 'قال', mode: 'surface' },
        { query: 'الله', mode: 'surface' },
        { query: 'رسول', mode: 'surface' },
      ],
      distances: [10, 3],
      ordered: true,
      pageTerms: [],
    });
    // The third row can be taken away again, with its link.
    fireEvent.click(screen.getByLabelText('Remove Term 3'));
    expect(screen.getAllByTestId('proximity-term-row')).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(1);
  });

  it('adds up to two page terms, set apart, and leaves a blank one out', () => {
    const { onSearch } = renderPanel();
    fireEvent.click(screen.getByTestId('add-page-term'));
    fireEvent.click(screen.getByTestId('add-page-term'));
    expect(screen.queryByTestId('add-page-term')).toBeNull();
    const rows = screen.getAllByTestId('page-term-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('page-terms')).toContainElement(rows[0]);
    typeInto('Term 1', 'قال');
    typeInto('Term 2', 'الله');
    typeInto('Page 1', 'النبي');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ pageTerms: [{ query: 'النبي', mode: 'surface' }] })
    );
  });
});
