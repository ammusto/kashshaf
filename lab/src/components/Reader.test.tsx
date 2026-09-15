import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Token } from '@kashshaf/shared';
import { Reader, toRuns } from './Reader';
import type { Page, PageRef } from '../api/lab';
import { Pages } from '../api/pages';

/**
 * The reader's overlay is what every later phase addresses spans through
 * (ground rule 4), so what is tested here is that the span a click or a drag
 * produces is the token index the backend would store — not merely that
 * something rendered.
 */

function token(idx: number, surface: string, lemma = surface): Token {
  return { idx, surface, lemma, root: undefined, pos: 'noun', features: [], clitics: [] };
}

/** Three words, so the display tokenizer finds exactly three tokens. */
const BODY = 'قال رسول الله';

function page(overrides: Partial<Page> = {}): Page {
  return {
    book_id: 7,
    part_index: 0,
    page_id: 3,
    part_label: 'الجزء الأول',
    page_number: '12',
    body: BODY,
    // Distinct lemmas, so an assertion about the popup cannot be satisfied
    // by the same word in the page body behind it.
    tokens: [token(0, 'قال', 'قول'), token(1, 'رسول', 'رسل'), token(2, 'الله', 'اله')],
    ...overrides,
  };
}

const refs: PageRef[] = [
  { book_id: 7, part_index: 0, page_id: 3 },
  { book_id: 7, part_index: 0, page_id: 4 },
];

describe('toRuns', () => {
  it('groups characters into one run per token and one per gap', () => {
    const runs = toRuns('ab c', [0, 0, null, 1]);
    expect(runs).toEqual([
      { text: 'ab', token: 0 },
      { text: ' ', token: null },
      { text: 'c', token: 1 },
    ]);
  });
});

describe('Reader', () => {
  it('clears the selection on a background click and on Escape (fix 8)', () => {
    const onClear = vi.fn();
    const onSelect = vi.fn();
    render(<Reader page={page()} pages={refs} index={0} onNavigate={() => {}} onSelectRange={onSelect} onClearSelection={onClear} loading={false} error={null} />);
    const first = document.querySelector('[data-token="0"]') as HTMLElement;
    fireEvent.mouseDown(first);
    fireEvent.mouseUp(first);
    expect(first.className).toContain('tok-selected');
    // A click on the pane background, not on a token.
    fireEvent.click(screen.getByTestId('reader-pane'));
    expect(first.className).not.toContain('tok-selected');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.mouseDown(first);
    fireEvent.mouseUp(first);
    expect(first.className).toContain('tok-selected');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first.className).not.toContain('tok-selected');
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  const noop = () => {};

  it('renders one overlay span per token, indexed as the backend stores them', () => {
    const { container } = render(
      <Reader page={page()} pages={refs} index={0} onNavigate={noop} loading={false} error={null} />
    );
    const spans = container.querySelectorAll('[data-token]');
    expect([...spans].map((s) => s.getAttribute('data-token'))).toEqual(['0', '1', '2']);
    expect([...spans].map((s) => s.textContent)).toEqual(['قال', 'رسول', 'الله']);
  });

  it('labels the page as spec 1.5 C1 requires, and counts its tokens', () => {
    // One part: the printed number alone, no part prefix and no "of 405".
    const single = new Pages([
      { book_id: 7, part_index: 0, page_id: 3, page_number: '12', part_label: '' },
      { book_id: 7, part_index: 0, page_id: 4, page_number: '13', part_label: '' },
    ]);
    const { unmount } = render(
      <Reader page={page()} pages={refs} index={0} onNavigate={noop} labels={single} loading={false} error={null} />
    );
    expect(screen.getByTestId('page-locator')).toHaveTextContent('12');
    expect(screen.getByTestId('page-locator').textContent).not.toMatch(/of|:/);
    expect(screen.getByTestId('token-count')).toHaveTextContent('3 tokens');
    unmount();

    // Two parts: part counted from one, never the zero-based index.
    const multi = new Pages([
      { book_id: 7, part_index: 0, page_id: 3, page_number: '12', part_label: '' },
      { book_id: 7, part_index: 1, page_id: 1, page_number: '1', part_label: '' },
    ]);
    render(<Reader page={page()} pages={refs} index={0} onNavigate={noop} labels={multi} loading={false} error={null} />);
    expect(screen.getByTestId('page-locator')).toHaveTextContent('1:12');
  });

  it('opens the token popup for the token that was clicked', () => {
    const { container } = render(
      <Reader page={page()} pages={refs} index={0} onNavigate={noop} loading={false} error={null} />
    );
    const second = container.querySelector('[data-token="1"]')!;
    fireEvent.mouseDown(second);
    fireEvent.mouseUp(second);
    expect(screen.getByText('Token Information')).toBeInTheDocument();
    // The clicked token's own lemma, not its neighbours'.
    expect(screen.getByText('رسل')).toBeInTheDocument();
    expect(screen.queryByText('قول')).toBeNull();
  });

  it('reports a dragged range as a half-open token span', () => {
    const onSelectRange = vi.fn();
    const { container } = render(
      <Reader
        page={page()}
        pages={refs}
        index={0}
        onNavigate={noop}
        onSelectRange={onSelectRange}
        loading={false}
        error={null}
      />
    );
    fireEvent.mouseDown(container.querySelector('[data-token="0"]')!);
    fireEvent.mouseEnter(container.querySelector('[data-token="2"]')!);
    fireEvent.mouseUp(container.querySelector('[data-token="2"]')!);
    // [start, end) over tokens 0..2 — the coordinate form every stored span uses.
    expect(onSelectRange).toHaveBeenLastCalledWith([0, 3]);
    expect(screen.getByTestId('token-count')).toHaveTextContent('selected 0–2');
  });

  it('drags backwards to the same span', () => {
    const onSelectRange = vi.fn();
    const { container } = render(
      <Reader
        page={page()}
        pages={refs}
        index={0}
        onNavigate={noop}
        onSelectRange={onSelectRange}
        loading={false}
        error={null}
      />
    );
    fireEvent.mouseDown(container.querySelector('[data-token="2"]')!);
    fireEvent.mouseEnter(container.querySelector('[data-token="0"]')!);
    expect(onSelectRange).toHaveBeenLastCalledWith([0, 3]);
  });

  it('disables the overlay and says why when the page does not align', () => {
    // The body has three words; the corpus claims four tokens. Highlighting
    // confidently here would point at the wrong words (spec §3.3).
    const bad = page({
      tokens: [token(0, 'قال'), token(1, 'رسول'), token(2, 'الله'), token(3, 'زائد')],
    });
    const { container } = render(
      <Reader page={bad} pages={refs} index={0} onNavigate={noop} loading={false} error={null} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Token overlay disabled on this page');
    expect(screen.getByRole('alert')).toHaveTextContent('shows 3 words');
    expect(screen.getByRole('alert')).toHaveTextContent('reports 4 tokens');
    expect(container.querySelectorAll('[data-token]')).toHaveLength(0);
  });

  it('navigates within the page list and stops at both ends', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <Reader page={page()} pages={refs} index={0} onNavigate={onNavigate} loading={false} error={null} />
    );
    expect(screen.getByRole('button', { name: /Prev/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onNavigate).toHaveBeenCalledWith(1);

    rerender(
      <Reader page={page()} pages={refs} index={1} onNavigate={onNavigate} loading={false} error={null} />
    );
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Prev/ })).toBeEnabled();
  });

  it('shows a page error instead of a blank pane', () => {
    render(
      <Reader
        page={null}
        pages={[]}
        index={0}
        onNavigate={noop}
        loading={false}
        error="Listing a book's pages is not available in this mode: …"
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('not available in this mode');
  });
});
