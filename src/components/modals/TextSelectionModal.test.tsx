import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import type { SearchAPI } from '../../api';
import { BooksProvider } from '../../contexts/BooksContext';
import { TextSelectionModal } from './TextSelectionModal';

/**
 * The selection modal applies a pick as it is made — the sidebar's count
 * follows — and has a bar at the foot: how many are selected, Cancel,
 * Confirm. Confirm keeps what was picked and closes. Cancel, the × and
 * Escape put back exactly the selection the modal opened with, and close.
 */

function makeApi(): SearchAPI {
  return {
    getAllBooks: vi.fn(async () => [
      { id: 1, title: 'كتاب واحد', author_id: 1, parts: 1, in_corpus: true },
      { id: 2, title: 'كتاب اثنان', author_id: 1, parts: 1, in_corpus: true },
      { id: 3, title: 'كتاب ثلاثة', author_id: 1, parts: 1, in_corpus: true },
    ]),
    getAuthors: vi.fn(async () => [[1, 'مؤلف']]),
    getGenres: vi.fn(async () => []),
  } as unknown as SearchAPI;
}

/** App's wiring: the selection is state above the modal, applied live. */
function Harness({ initial, onClose, onChange }: { initial: number[]; onClose: () => void; onChange: (s: Set<number>) => void }) {
  const [selected, setSelected] = useState(() => new Set(initial));
  return (
    <>
      <div data-testid="outside-count">{selected.size}</div>
      <TextSelectionModal
        onClose={onClose}
        selectedBookIds={selected}
        onSelectionChange={(s) => {
          onChange(s);
          setSelected(s);
        }}
      />
    </>
  );
}

function renderModal(initial: number[]) {
  const onClose = vi.fn();
  const onChange = vi.fn();
  const utils = render(
    <BooksProvider api={makeApi()}>
      <Harness initial={initial} onClose={onClose} onChange={onChange} />
    </BooksProvider>
  );
  return { ...utils, onClose, onChange };
}

const lastSelection = (onChange: ReturnType<typeof vi.fn>) =>
  [...(onChange.mock.calls[onChange.mock.calls.length - 1][0] as Set<number>)].sort();

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the selection modal', () => {
  it('shows the count in the bar and applies a pick at once', async () => {
    const { onChange } = renderModal([1]);
    expect(screen.getByTestId('selection-bar')).toHaveTextContent('1 text selected');
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Select Showing/));
    expect(lastSelection(onChange)).toEqual([1, 2, 3]);
    expect(screen.getByTestId('selection-bar')).toHaveTextContent('3 texts selected');
    expect(screen.getByTestId('outside-count')).toHaveTextContent('3');
  });

  it('Confirm keeps the picks and closes', async () => {
    const { onClose, onChange } = renderModal([1]);
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Select Showing/));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastSelection(onChange)).toEqual([1, 2, 3]);
  });

  it('Cancel restores exactly the selection the modal opened with, and closes', async () => {
    const { onClose, onChange } = renderModal([2, 3]);
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Clear All Selected'));
    expect(lastSelection(onChange)).toEqual([]);
    fireEvent.click(screen.getByText(/Select Showing/));
    expect(lastSelection(onChange)).toEqual([1, 2, 3]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastSelection(onChange)).toEqual([2, 3]);
    expect(screen.getByTestId('outside-count')).toHaveTextContent('2');
  });

  it('the × restores the opening selection', async () => {
    const { onClose, onChange } = renderModal([1]);
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Select Showing/));
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastSelection(onChange)).toEqual([1]);
  });

  it('Escape restores the opening selection', async () => {
    const { onClose, onChange } = renderModal([]);
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Select Showing/));
    expect(lastSelection(onChange)).toEqual([1, 2, 3]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastSelection(onChange)).toEqual([]);
  });

  it('the backdrop restores the opening selection', async () => {
    const { onClose, onChange } = renderModal([3]);
    await waitFor(() => expect(screen.getByText(/Select Showing \(3\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Clear All Selected'));
    fireEvent.click(screen.getByTestId('text-selection-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastSelection(onChange)).toEqual([3]);
  });
});
