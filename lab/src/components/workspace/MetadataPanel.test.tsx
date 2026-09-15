import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

import { MetadataPanel } from './MetadataPanel';

/**
 * The Metadata panel (9 D): the workspace browser's own detail view, on the
 * open text, with nothing on it to press.
 */

const book: BookMetadata = {
  id: 527,
  title: 'الزهد',
  author_id: 1,
  genre_id: 4,
  death_ah: 241,
  page_count: 553,
  parts: 1,
  token_count: 120_000,
  corpus: 'shamela',
  original_id: 'sh-527',
  in_corpus: true,
  tags: JSON.stringify(['الزهد', 'الرقائق']),
};

describe('MetadataPanel', () => {
  it('shows the whole record, and offers no way to change it', () => {
    render(<MetadataPanel book={book} authorName="أحمد بن حنبل" genreName="الزهد والرقائق" />);
    const detail = within(screen.getByTestId('metadata-panel')).getByTestId('book-detail');

    expect(detail).toHaveTextContent('الزهد');
    expect(detail).toHaveTextContent('أحمد بن حنبل');
    expect(detail).toHaveTextContent('الزهد والرقائق');
    expect(detail).toHaveTextContent('241');
    expect(detail).toHaveTextContent('120,000');
    expect(detail).toHaveTextContent('sh-527');
    expect(detail).toHaveTextContent('الرقائق');

    // Read-only: no workspace actions, no way back to a browser that is not
    // on screen.
    expect(screen.queryByTestId('add-to-workspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Back to texts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Text' })).not.toBeInTheDocument();
  });

  it('fills the panel, like every other one', () => {
    render(<MetadataPanel book={book} />);
    const root = screen.getByTestId('metadata-panel');
    expect(root.className).toContain('flex-1');
    expect(root.className).toContain('min-w-0');
    expect(root.className).toContain('min-h-0');
  });
});
