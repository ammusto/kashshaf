import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResult } from '../../types';
import { VirtualizedResultsList } from './VirtualizedResultsList';

/**
 * Reaching the foot of the results loads the next page, and the button is
 * there for when that does not happen.
 */

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  elements = new Set<Element>();
  constructor(public cb: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  takeRecords() {
    return [];
  }
  /** The foot of the list has come into view. */
  static reachBottom() {
    const io = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
    if (!io || io.elements.size === 0) throw new Error('nothing is watching for the foot of the list');
    act(() => {
      io.cb(
        [...io.elements].map(
          (target) => ({ target, isIntersecting: true, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry
        ),
        io as unknown as IntersectionObserver
      );
    });
  }
  static get watching() {
    const io = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
    return io ? io.elements.size : 0;
  }
}

function rows(n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1,
    part_index: 0,
    page_id: i + 1,
    part_label: '1',
    page_number: String(i + 1),
    body: `صفحة ${i + 1}`,
    score: 1,
    matched_token_indices: [],
  })) as unknown as SearchResult[];
}

function renderList(props: Partial<React.ComponentProps<typeof VirtualizedResultsList>> = {}) {
  const onLoadMore = vi.fn();
  render(
    <VirtualizedResultsList
      results={rows(250)}
      onResultClick={vi.fn()}
      onLoadMore={onLoadMore}
      loadingMore={false}
      totalHits={2300}
      maxResults={5000}
      {...props}
    />
  );
  return { onLoadMore };
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('loading more results', () => {
  it('loads the next page when the foot of the list comes into view', () => {
    const { onLoadMore } = renderList();
    MockIntersectionObserver.reachBottom();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps a button for when that does not happen', async () => {
    const { onLoadMore } = renderList();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does neither while a page is already loading', () => {
    const { onLoadMore } = renderList({ loadingMore: true });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading more...')).toBeInTheDocument();
    expect(MockIntersectionObserver.watching).toBe(0);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('stops at the end of the results', () => {
    renderList({ results: rows(120), totalHits: 120 });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('All 120 results loaded')).toBeInTheDocument();
    expect(MockIntersectionObserver.watching).toBe(0);
  });

  it('stops at the row cap, and says the count was a lower bound', () => {
    renderList({ results: rows(5000), totalHits: 20000, wasCapped: true, maxResults: 5000 });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 5,000 of 20,000\+ \(max reached\)/)).toBeInTheDocument();
  });

  it('keeps offering more while the count is only a lower bound', () => {
    // A capped walk reports fewer hits than it has rows: there is still more.
    renderList({ results: rows(250), totalHits: 250, wasCapped: true });
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('stops once a load-more comes back empty', () => {
    renderList({ results: rows(250), totalHits: 2300, loadedAll: true });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(MockIntersectionObserver.watching).toBe(0);
  });
});
