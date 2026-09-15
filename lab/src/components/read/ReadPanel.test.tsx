import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The Read panel (spec 1.5 §C): the page label rule, the part:page inputs and
 * the arrow keys, the table of contents, and what a selection offers.
 *
 * The page numbers here are the ones the book prints, which are not its page
 * ids — that is the point of §C1, and every assertion below is against the
 * printed number.
 */

const api = vi.hoisted(() => ({
  lab: {
    listPages: vi.fn(),
    getPage: vi.fn(),
  },
  toc: {
    tree: vi.fn(async (): Promise<unknown[]> => []),
    rows: vi.fn(async (): Promise<unknown[]> => []),
    sectionRange: vi.fn(),
  },
  notes: {
    list: vi.fn(async (): Promise<unknown[]> => []),
    save: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/workspace', async () => {
  const real = await vi.importActual<typeof import('../../api/workspace')>('../../api/workspace');
  return { ...real, tocApi: api.toc, notesApi: api.notes };
});

import { ReadPanel } from './ReadPanel';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 2 };

/** Two parts, each restarting its printed numbering at 1. */
const entries = [
  { book_id: 527, part_index: 0, page_id: 1, page_number: '7', part_label: 'ج١' },
  { book_id: 527, part_index: 0, page_id: 2, page_number: '8', part_label: 'ج١' },
  { book_id: 527, part_index: 1, page_id: 1, page_number: '3', part_label: 'ج٢' },
];

function mkPage(partIndex: number, pageId: number, pageNumber: string, words: string) {
  return {
    book_id: 527,
    part_index: partIndex,
    page_id: pageId,
    part_label: partIndex === 0 ? 'ج١' : 'ج٢',
    page_number: pageNumber,
    body: words,
    tokens: words.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })),
  };
}

const pages = new Map([
  ['0:1', mkPage(0, 1, '7', 'قال حدثنا ابو بكر')],
  ['0:2', mkPage(0, 2, '8', 'ثم قال رحمه الله')],
  ['1:1', mkPage(1, 1, '3', 'باب ما جاء في الزهد')],
]);

const tree = [
  {
    id: 1,
    parent: 0,
    title: 'كتاب الزهد',
    part_index: 0,
    page_id: 1,
    page_number: '7',
    depth: 0,
    children: [{ id: 2, parent: 1, title: 'باب التواضع', part_index: 1, page_id: 1, page_number: '3', depth: 1, children: [] }],
  },
];
const rows = [
  { id: 1, parent: 0, title: 'كتاب الزهد', part_index: 0, page_id: 1, page_number: '7' },
  { id: 2, parent: 1, title: 'باب التواضع', part_index: 1, page_id: 1, page_number: '3' },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.lab.listPages.mockResolvedValue(entries);
  api.lab.getPage.mockImplementation(async (_id: number, p: number, g: number) => pages.get(`${p}:${g}`) ?? null);
  api.toc.tree.mockResolvedValue(tree);
  api.toc.rows.mockResolvedValue(rows);
  api.notes.list.mockResolvedValue([]);
});

describe('ReadPanel', () => {
  it('labels a multi-part page as part:printed-page, counting parts from one', async () => {
    render(<ReadPanel book={book} />);
    // The corpus's part_index is 0; the reader sees part 1, and the printed
    // number 7, not the page id 1.
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
    expect(screen.getByTestId('read-locator').textContent).not.toMatch(/of/);
  });

  it('goes to a printed page number typed into the inputs', async () => {
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));

    fireEvent.change(screen.getByLabelText('Part'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Page'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(api.lab.getPage).toHaveBeenCalledWith(527, 1, 1));
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('2:3'));
  });

  it('pages with the arrow keys, right going back in a right-to-left text', async () => {
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:8'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
  });

  it('nests the contents, jumps to an entry, and toggles with Ctrl+T', async () => {
    render(<ReadPanel book={book} />);
    const toc = await screen.findByTestId('toc-pane');
    // The child entry is indented under its parent, and labelled by §C1.
    const child = within(toc).getByText('باب التواضع');
    expect(child).toBeInTheDocument();
    expect(toc).toHaveTextContent('2:3');

    fireEvent.click(child);
    await waitFor(() => expect(api.lab.getPage).toHaveBeenCalledWith(527, 1, 1));
    // The entry the reader is now inside is the one marked.
    await waitFor(() => expect(within(screen.getByTestId('toc-pane')).getByText('باب التواضع').closest('button')).toHaveAttribute('aria-current', 'true'));

    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument());
  });

  it('offers Annotate and Find reuse on a selection, and saves a note', async () => {
    const onFindReuse = vi.fn();
    api.notes.save.mockResolvedValue({ id: 3, book_id: 527, part_index: 0, page_id: 1, tok_start: 0, tok_end: 2, text: 'a note', snapshot: '', created_at: '', updated_at: '', corpus_version: '4.1.0' });
    render(<ReadPanel book={book} onFindReuse={onFindReuse} />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());

    fireEvent.mouseDown(document.querySelector('[data-token="0"]')!);
    fireEvent.mouseEnter(document.querySelector('[data-token="1"]')!);
    fireEvent.mouseUp(document.querySelector('[data-token="1"]')!);
    const actions = await screen.findByTestId('selection-actions');
    expect(actions).toHaveTextContent('قال حدثنا');

    fireEvent.click(screen.getByTestId('find-reuse'));
    expect(onFindReuse).toHaveBeenCalledWith(expect.objectContaining({ at: { part_index: 0, page_id: 1 }, range: [0, 2] }));

    fireEvent.click(screen.getByTestId('annotate'));
    const editor = await screen.findByTestId('note-editor');
    // The note names its page the way every other label does.
    expect(editor).toHaveTextContent('1:7');
    fireEvent.change(within(editor).getByLabelText('Note'), { target: { value: 'a note' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.notes.save).toHaveBeenCalledWith({ book_id: 527, part_index: 0, page_id: 1, tok_start: 0, tok_end: 2, text: 'a note' })
    );
  });

  it('says why the contents are missing rather than showing an empty pane', async () => {
    api.toc.tree.mockRejectedValue(new Error('The table of contents is not available in this mode: toc.db ships with corpus 4.2.0'));
    api.toc.rows.mockRejectedValue(new Error('no toc'));
    render(<ReadPanel book={book} />);
    const toc = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(toc).getByRole('alert')).toHaveTextContent('4.2.0'));
  });
});
