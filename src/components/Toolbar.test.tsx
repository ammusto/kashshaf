import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toolbar } from './Toolbar';

/**
 * Text selection lives in the top bar: after Help, a Select Texts button,
 * a label saying which texts the searches run over, and, once there is a
 * selection, the save-as-collection button.
 */

function renderToolbar(selectedTextsCount: number) {
  const onSelectTexts = vi.fn();
  const onSaveCollection = vi.fn();
  render(
    <Toolbar
      onBrowseTexts={() => {}}
      onSearchHistory={() => {}}
      onSavedSearches={() => {}}
      onCollections={() => {}}
      onHelp={() => {}}
      onSelectTexts={onSelectTexts}
      selectedTextsCount={selectedTextsCount}
      onSaveCollection={selectedTextsCount > 0 ? onSaveCollection : undefined}
      isWebTarget
    />
  );
  return { onSelectTexts, onSaveCollection };
}

describe('the top bar', () => {
  it('says the searches run over all texts when nothing is selected, and has no save button', () => {
    const { onSelectTexts } = renderToolbar(0);
    expect(screen.getByTestId('text-selection-status')).toHaveTextContent('Searching All Texts');
    expect(screen.queryByLabelText('Save as Collection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select Texts' }));
    expect(onSelectTexts).toHaveBeenCalledTimes(1);
  });

  it('says how many texts once there is a selection, and offers to save it', () => {
    const { onSaveCollection } = renderToolbar(1234);
    expect(screen.getByTestId('text-selection-status')).toHaveTextContent('Searching 1,234 Texts');
    fireEvent.click(screen.getByLabelText('Save as Collection'));
    expect(onSaveCollection).toHaveBeenCalledTimes(1);
  });

  it('puts the selection after Help', () => {
    renderToolbar(0);
    const help = screen.getByRole('button', { name: 'Help' });
    const select = screen.getByRole('button', { name: 'Select Texts' });
    expect(help.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
