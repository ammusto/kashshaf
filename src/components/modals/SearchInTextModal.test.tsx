import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchInTextModal } from './SearchInTextModal';

/**
 * The three-way choice Search in Text puts when a selection exists. Each
 * button calls its own handler and nothing else; Cancel, Escape and the
 * backdrop all close without a change.
 */
function renderModal() {
  const onAdd = vi.fn();
  const onClear = vi.fn();
  const onClose = vi.fn();
  render(<SearchInTextModal bookTitle="كتاب" onAdd={onAdd} onClear={onClear} onClose={onClose} />);
  return { onAdd, onClear, onClose };
}

describe('the Search in Text modal', () => {
  it('asks the question and names the text', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Add this text to your current selection, or clear your selection and search just this text?'
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('كتاب');
  });

  it('Add to Selection adds, and only adds', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Selection' }));
    expect(h.onAdd).toHaveBeenCalledTimes(1);
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('Clear Selection clears, and only clears', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Selection' }));
    expect(h.onClear).toHaveBeenCalledTimes(1);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it('Cancel, Escape and the backdrop close without a change', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('search-in-text-backdrop'));
    expect(h.onClose).toHaveBeenCalledTimes(3);
    expect(h.onAdd).not.toHaveBeenCalled();
    expect(h.onClear).not.toHaveBeenCalled();
    // A click inside the dialog is not the backdrop.
    fireEvent.click(screen.getByRole('dialog'));
    expect(h.onClose).toHaveBeenCalledTimes(3);
  });
});
