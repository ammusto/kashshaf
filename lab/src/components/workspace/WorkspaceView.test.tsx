import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The startup view (spec 1.5 §A1): the workspace on the left, the corpus on
 * the right. What is tested is what a reader does with it — find a text by
 * typing its title however they spell it, add it, open it, and be asked
 * before its folder is deleted.
 */

const api = vi.hoisted(() => ({
  workspace: {
    list: vi.fn(async (): Promise<unknown[]> => []),
    add: vi.fn(),
    remove: vi.fn(async () => {}),
    open: vi.fn(),
    export: vi.fn(),
    saveState: vi.fn(),
    openFolder: vi.fn(),
  },
}));

vi.mock('../../api/workspace', async () => {
  const real = await vi.importActual<typeof import('../../api/workspace')>('../../api/workspace');
  return { ...real, workspaceApi: api.workspace };
});

import { WorkspaceView } from './WorkspaceView';
import type { WorkspaceEntry } from '../../api/workspace';

const books: BookMetadata[] = [
  { id: 527, title: 'الزهد', author_id: 1, death_ah: 241, genre_id: 4, page_count: 553, parts: 1, corpus: 'shamela', in_corpus: true },
  { id: 4382, title: 'إعلام الموقعين', author_id: 2, death_ah: 751, genre_id: 5, page_count: 2100, parts: 4, corpus: 'shamela', in_corpus: true },
  { id: 900, title: 'تاريخ بغداد', author_id: 3, death_ah: 463, genre_id: 6, page_count: 7000, parts: 24, corpus: 'openiti', in_corpus: true },
];

const authors = new Map([
  [1, 'أحمد بن حنبل'],
  [2, 'ابن قيم الجوزية'],
  [3, 'الخطيب البغدادي'],
]);
const genres = new Map([
  [4, 'الزهد والرقائق'],
  [5, 'أصول الفقه'],
  [6, 'التاريخ'],
]);

const now = new Date();
const older = new Date(now.getTime() - 3 * 60 * 60 * 1000);

const entries: WorkspaceEntry[] = [
  { book_id: 527, title: 'الزهد', author: 'أحمد بن حنبل', death_ah: 241, accessed: older.toISOString(), added: older.toISOString(), confirmed_isnads: 12, notes: 2 },
  { book_id: 900, title: 'تاريخ بغداد', author: 'الخطيب البغدادي', death_ah: 463, accessed: now.toISOString(), added: older.toISOString(), confirmed_isnads: 0, notes: 0 },
];

function view(over: Partial<React.ComponentProps<typeof WorkspaceView>> = {}) {
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  render(
    <WorkspaceView
      entries={entries}
      currentId={null}
      books={books}
      authors={authors}
      genres={genres}
      booksLoading={false}
      booksError={null}
      onOpen={onOpen}
      onChanged={onChanged}
      {...over}
    />
  );
  return { onOpen, onChanged };
}

beforeEach(() => vi.clearAllMocks());

describe('WorkspaceView', () => {
  it('lists the workspace by when it was last opened, and sorts by name on demand', () => {
    view();
    const list = screen.getByTestId('workspace-list');
    const titles = () => within(list).getAllByRole('option').map((o) => o.textContent ?? '');
    // Most recently opened first.
    expect(titles()[0]).toContain('تاريخ بغداد');
    expect(titles()[0]).toContain('just now');
    expect(titles()[1]).toContain('3 h ago');

    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(titles()[0]).toContain('الزهد');
  });

  it('opens a workspace text on a click', () => {
    const { onOpen } = view();
    fireEvent.click(within(screen.getByTestId('workspace-list')).getAllByRole('option')[0]);
    expect(onOpen).toHaveBeenCalledWith(900);
  });

  it('finds a text by title or author however the hamza is written', async () => {
    view();
    const search = screen.getByLabelText('Search titles and authors');
    // The corpus writes إعلام with a hamza; typing the bare alif still finds it.
    fireEvent.change(search, { target: { value: 'اعلام' } });
    await waitFor(() => expect(screen.getByTestId('browser-count')).toHaveTextContent('1 of 3 texts'));

    // And by the author's name.
    fireEvent.change(search, { target: { value: 'الخطيب' } });
    await waitFor(() => expect(screen.getByTestId('browser-count')).toHaveTextContent('1 of 3 texts'));
  });

  it('filters by death year and by corpus', async () => {
    view();
    fireEvent.change(screen.getByLabelText('Death year, from'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Death year, to'), { target: { value: '500' } });
    await waitFor(() => expect(screen.getByTestId('browser-count')).toHaveTextContent('1 of 3 texts'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByTestId('browser-count')).toHaveTextContent('3 of 3 texts'));

    fireEvent.click(screen.getByRole('button', { name: 'openiti' }));
    await waitFor(() => expect(screen.getByTestId('browser-count')).toHaveTextContent('1 of 3 texts'));
  });

  it('adds a text to the workspace from its metadata view, with its author', async () => {
    api.workspace.add.mockResolvedValue(entries[0]);
    const { onChanged } = view();
    fireEvent.click(screen.getByText('إعلام الموقعين'));
    const detail = await screen.findByTestId('book-detail');
    expect(detail).toHaveTextContent('ابن قيم الجوزية');
    expect(detail).toHaveTextContent('أصول الفقه');

    fireEvent.click(screen.getByTestId('add-to-workspace'));
    await waitFor(() => expect(api.workspace.add).toHaveBeenCalledWith(4382, 'ابن قيم الجوزية'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('asks before deleting a text folder, and says what survives', async () => {
    view();
    fireEvent.click(screen.getByLabelText('Remove تاريخ بغداد from the workspace'));
    const dialog = await screen.findByTestId('confirm-remove');
    expect(dialog).toHaveTextContent('deletes the folder');
    expect(dialog).toHaveTextContent('stays in the database');
    expect(api.workspace.remove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete the folder' }));
    await waitFor(() => expect(api.workspace.remove).toHaveBeenCalledWith(900));
  });
});
