import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultRow } from './ResultRow';
import { Pages } from '../../api/pages';
import type { Hit } from '../../api/search';

/**
 * An engine of 0.8.0 sends a result row's body already cut to the snippet
 * around its first hit, with `snippet_start_token` saying which page token
 * the snippet starts at; the page's highlight indices are placed in it by
 * that offset. An older engine sends the page and no offset, and the row
 * cuts it itself as before.
 */

const pages = new Pages([{ book_id: 7, part_index: 0, page_id: 10, part_label: '1', page_number: '10' }], 1);

const base: Hit = {
  part_index: 0,
  page_id: 10,
  part_label: '1',
  page_number: '10',
  body: '',
  score: 1,
  matched: [],
};

function highlighted(): string[] {
  return [...document.querySelectorAll('span.bg-red-100')].map((el) => el.textContent ?? '');
}

describe('a result row with a snippet from the engine', () => {
  it('places the page highlight indices by the snippet start', () => {
    // The snippet is page tokens 35..: the hit at page token 37 is its third word.
    render(<ResultRow hit={{ ...base, body: 'كلمة اولى معرفة الله كلمة', matched: [37, 38], snippet_start_token: 35 }} pages={pages} section={null} onClick={() => {}} />);
    expect(highlighted()).toEqual(['معرفة', 'الله']);
    expect(screen.getByText(/^… /)).toBeInTheDocument();
  });

  it('shows no ellipsis when the snippet is the head of the page', () => {
    render(<ResultRow hit={{ ...base, body: 'معرفة الله كلمة', matched: [0, 1], snippet_start_token: 0 }} pages={pages} section={null} onClick={() => {}} />);
    expect(highlighted()).toEqual(['معرفة', 'الله']);
    expect(screen.queryByText(/^… /)).toBeNull();
  });

  it('still cuts a whole page from an older engine', () => {
    const words = Array.from({ length: 80 }, (_, i) => `كلمة${'ا'.repeat(i % 3)}`);
    words[40] = 'معرفة';
    render(<ResultRow hit={{ ...base, body: words.join(' '), matched: [40] }} pages={pages} section={null} onClick={() => {}} />);
    expect(highlighted()).toEqual(['معرفة']);
    expect(screen.getByText(/^… /)).toBeInTheDocument();
  });
});
