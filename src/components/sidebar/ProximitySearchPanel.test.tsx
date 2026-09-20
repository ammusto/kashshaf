import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchFormProvider } from '../../contexts/SearchFormContext';
import { ProximitySearchPanel } from './ProximitySearchPanel';

/**
 * The proximity form: two unlabelled rows and a distance as ever; "+ Add
 * Proximity Term" chains a third with its own distance, and no fourth;
 * "Ordered" is a switch; "+ Add AND Term" adds up to two rows set apart
 * under "Also on the page", a heading that is not there until the first.
 * What Search emits is the chain query, blank AND terms left out.
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

const rows = (kind: 'proximity' | 'page') => screen.queryAllByTestId(`${kind}-term-row`);
const typeInto = (kind: 'proximity' | 'page', i: number, text: string) => {
  fireEvent.change(rows(kind)[i].querySelector('input[type="text"]')!, { target: { value: text } });
};
const search = () => fireEvent.click(screen.getByRole('button', { name: 'Search' }));

describe('ProximitySearchPanel', () => {
  it('starts as two terms with one distance, no AND terms, and no labels on the rows', () => {
    renderPanel();
    expect(rows('proximity')).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(1);
    expect(rows('page')).toHaveLength(0);
    expect(screen.queryByText(/^Term \d/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(screen.getByText('Reset Search')).toBeInTheDocument();
  });

  it('emits the two-term query as a chain', () => {
    const { onSearch } = renderPanel();
    typeInto('proximity', 0, 'قال');
    typeInto('proximity', 1, 'الله');
    fireEvent.change(screen.getByLabelText('Distance 1'), { target: { value: '7' } });
    search();
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
    fireEvent.click(screen.getByRole('button', { name: '+ Add Proximity Term' }));
    expect(rows('proximity')).toHaveLength(3);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '+ Add Proximity Term' })).toBeNull();
    typeInto('proximity', 0, 'قال');
    typeInto('proximity', 1, 'الله');
    typeInto('proximity', 2, 'رسول');
    fireEvent.change(screen.getByLabelText('Distance 2'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Ordered/ }));
    search();
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
    fireEvent.click(screen.getByLabelText('Remove proximity term 3'));
    expect(rows('proximity')).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Distance/)).toHaveLength(1);
  });

  it('shows nothing of the AND terms but the add button until one is added', () => {
    renderPanel();
    expect(screen.queryByTestId('page-terms')).toBeNull();
    expect(screen.queryByText('Also on the page')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add AND Term' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add AND Term' }));
    expect(screen.getByTestId('page-terms')).toBeInTheDocument();
    expect(screen.getByText('Also on the page')).toBeInTheDocument();
    expect(screen.queryByText(/^Page \d/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove AND term 1'));
    expect(screen.queryByTestId('page-terms')).toBeNull();
  });

  it('adds up to two AND terms, set apart, and leaves a blank one out', () => {
    const { onSearch } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '+ Add AND Term' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add AND Term' }));
    expect(screen.queryByRole('button', { name: '+ Add AND Term' })).toBeNull();
    expect(rows('page')).toHaveLength(2);
    expect(screen.getByTestId('page-terms')).toContainElement(rows('page')[0]);
    typeInto('proximity', 0, 'قال');
    typeInto('proximity', 1, 'الله');
    typeInto('page', 0, 'النبي');
    search();
    expect(onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ pageTerms: [{ query: 'النبي', mode: 'surface' }] })
    );
  });
});
