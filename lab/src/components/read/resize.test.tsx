import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Profiler } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The Read panel must settle after the window changes shape under it — the
 * rail folds, the window is resized — with a token selection on the page.
 * Kashshaf's reader once looped here (a state update from a layout effect
 * on every render); Lab's reader is one page and has no such effect, and
 * this keeps it that way: after the change and a quiet period, no more
 * commits.
 */

const api = vi.hoisted(() => ({
  lab: { listPages: vi.fn(), getPage: vi.fn() },
  toc: { tree: vi.fn(async (): Promise<unknown[]> => []), rows: vi.fn(async (): Promise<unknown[]> => []), sectionRange: vi.fn() },
  search: vi.fn(async () => ({ hits: [], total: 0, elapsed_ms: 1, capped: false })),
  notes: { list: vi.fn(async (): Promise<unknown[]> => []), save: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/search', async () => {
  const real = await vi.importActual<typeof import('../../api/search')>('../../api/search');
  return { ...real, searchApi: { book: api.search } };
});
vi.mock('../../api/workspace', async () => {
  const real = await vi.importActual<typeof import('../../api/workspace')>('../../api/workspace');
  return { ...real, tocApi: api.toc, notesApi: api.notes };
});

import { ReadPanel, resetReadMemory } from './ReadPanel';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };
const entries = [
  { book_id: 527, part_index: 0, page_id: 1, page_number: '7', part_label: '1' },
  { book_id: 527, part_index: 0, page_id: 2, page_number: '8', part_label: '1' },
];
const words = 'قال حدثنا ابو بكر عن عمر';
const page = {
  book_id: 527,
  part_index: 0,
  page_id: 1,
  part_label: '1',
  page_number: '7',
  body: words,
  tokens: words.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })),
};

/** A real DOM selection over tokens [a, b). */
function selectTokens(a: number, b: number) {
  const first = document.querySelector(`[data-token="${a}"]`)!;
  const last = document.querySelector(`[data-token="${b - 1}"]`)!;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetReadMemory();
  api.lab.listPages.mockResolvedValue(entries);
  api.lab.getPage.mockResolvedValue(page);
});

const COMMIT_CAP = 2000;

describe('the Read panel under a resize', () => {
  it.each(['window resized', 'rail folded'])('%s with a selection on the page: settles, then no more commits', async (kind) => {
    let commits = 0;
    render(
      <Profiler
        id="read"
        onRender={() => {
          commits++;
          if (commits > COMMIT_CAP) throw new Error(`the panel committed ${commits} times: a render loop`);
        }}
      >
        <ReadPanel book={book} />
      </Profiler>
    );
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('7'));
    await waitFor(() => expect(document.querySelector('[data-token="1"]')).toBeTruthy());
    selectTokens(1, 3);

    await act(async () => {
      if (kind === 'window resized') {
        window.dispatchEvent(new Event('resize'));
      } else {
        fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
      }
      await new Promise((r) => setTimeout(r, 50));
    });
    // Settled: a quiet period with no commits at all.
    await new Promise((r) => setTimeout(r, 100));
    const at = commits;
    await new Promise((r) => setTimeout(r, 200));
    expect(commits).toBe(at);
    // And the page is still the page.
    expect(screen.getByTestId('read-locator')).toHaveTextContent('7');
  });
});
