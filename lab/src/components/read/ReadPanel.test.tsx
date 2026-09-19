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
  search: vi.fn(async (): Promise<{ hits: unknown[]; total: number; elapsed_ms: number; capped: boolean }> => ({ hits: [], total: 0, elapsed_ms: 1, capped: false })),
  notes: {
    list: vi.fn(async (): Promise<unknown[]> => []),
    save: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
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
function mkNote(
  id: number,
  partIndex: number,
  pageId: number,
  a: number,
  b: number,
  text: string,
  color = 'yellow',
  snapshot = ''
) {
  return {
    id,
    book_id: 527,
    part_index: partIndex,
    page_id: pageId,
    tok_start: a,
    tok_end: b,
    text,
    color,
    snapshot,
    created_at: '',
    updated_at: '',
    corpus_version: '4.1.0',
  };
}

const rows = [
  { id: 1, parent: 0, title: 'كتاب الزهد', part_index: 0, page_id: 1, page_number: '7' },
  { id: 2, parent: 1, title: 'باب التواضع', part_index: 1, page_id: 1, page_number: '3' },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetReadMemory();
  api.lab.listPages.mockResolvedValue(entries);
  api.lab.getPage.mockImplementation(async (_id: number, p: number, g: number) => pages.get(`${p}:${g}`) ?? null);
  api.toc.tree.mockResolvedValue(tree);
  api.toc.rows.mockResolvedValue(rows);
  api.notes.list.mockResolvedValue([]);
});

/** Select tokens [a, b) the way a person would: a real DOM selection. */
function selectTokensNatively(a: number, b: number) {
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

  it('opens subtrees on the triangle, jumps on the title, and toggles with Ctrl+T (8 B)', async () => {
    render(<ReadPanel book={book} />);
    const toc = await screen.findByTestId('toc-pane');
    // Only the top level to begin with.
    expect(within(toc).getByText('كتاب الزهد')).toBeInTheDocument();
    expect(within(toc).queryByText('باب التواضع')).not.toBeInTheDocument();

    // The triangle opens the subtree and does not turn a page.
    const triangle = within(toc).getByTestId('toc-toggle-1');
    expect(triangle).toHaveAttribute('aria-expanded', 'false');
    const pagesBefore = api.lab.getPage.mock.calls.length;
    fireEvent.click(triangle);

    const child = await within(toc).findByText('باب التواضع');
    expect(api.lab.getPage.mock.calls.length).toBe(pagesBefore);
    expect(triangle).toHaveAttribute('aria-expanded', 'true');
    // 10 E: the child hangs off a tree, and it is the last of its section.
    // The glyphs are mirrored because the pane reads right to left.
    expect(within(toc).getByTestId('guide-2')).toHaveTextContent('┘');
    expect(within(toc).queryByTestId('guide-1')).not.toBeInTheDocument();

    // A leaf gets no triangle, and the entry is labelled by §C1.
    expect(within(toc).queryByTestId('toc-toggle-2')).not.toBeInTheDocument();
    expect(toc).toHaveTextContent('2:3');

    // The title does turn the page.
    fireEvent.click(child);
    await waitFor(() => expect(api.lab.getPage).toHaveBeenCalledWith(527, 1, 1));
    // The entry the reader is now inside is the one marked.
    await waitFor(() => expect(within(screen.getByTestId('toc-pane')).getByText('باب التواضع').closest('button')).toHaveAttribute('aria-current', 'true'));

    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('toc-pane')).not.toBeInTheDocument());

    // Re-opened from scratch, the path down to the section being read opens
    // itself, or the highlight would mark a hidden entry.
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    const again = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(again).getByText('باب التواضع')).toBeInTheDocument());
  });

  it('selects like ordinary text, and annotates what was selected (7 B)', async () => {
    api.notes.save.mockResolvedValue(mkNote(3, 0, 1, 0, 2, 'a note'));
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());

    // No drag-to-analyse overlay and no floating toolbar.
    expect(screen.queryByTestId('selection-actions')).toBeNull();
    expect(document.querySelector('[data-token="0"]')!.className).not.toContain('tok ');

    // Annotate is in the toolbar, and disabled until something is selected.
    const annotate = screen.getByTestId('annotate');
    expect(annotate).toBeDisabled();

    selectTokensNatively(0, 2);
    await waitFor(() => expect(screen.getByTestId('annotate')).toBeEnabled());

    fireEvent.click(screen.getByTestId('annotate'));
    const editor = await screen.findByTestId('note-editor');
    // 9 B4: a multi-part text names its volume, and the words are tokens.
    expect(within(editor).getByTestId('note-location')).toHaveTextContent('Volume: 1, Page: 7 · tokens 0–1');
    fireEvent.change(within(editor).getByLabelText('Note'), { target: { value: 'a note' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.notes.save).toHaveBeenCalledWith({
        book_id: 527,
        part_index: 0,
        page_id: 1,
        tok_start: 0,
        tok_end: 2,
        text: 'a note',
        color: 'yellow',
      })
    );
  });

  it('omits the volume in a single-part text (9 B4)', async () => {
    api.lab.listPages.mockResolvedValue(entries.filter((e) => e.part_index === 0));
    render(<ReadPanel book={{ ...book, parts: 1 }} />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    selectTokensNatively(0, 2);
    await waitFor(() => expect(screen.getByTestId('annotate')).toBeEnabled());
    fireEvent.click(screen.getByTestId('annotate'));

    const loc = within(await screen.findByTestId('note-editor')).getByTestId('note-location');
    expect(loc).toHaveTextContent('Page: 7 · tokens 0–1');
    expect(loc).not.toHaveTextContent('Volume');
  });

  it('marks up the note and picks a highlight colour (9 B3)', async () => {
    api.notes.save.mockResolvedValue(mkNote(4, 0, 1, 0, 2, '**a note**', 'blue'));
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    selectTokensNatively(0, 2);
    await waitFor(() => expect(screen.getByTestId('annotate')).toBeEnabled());
    fireEvent.click(screen.getByTestId('annotate'));

    const editor = await screen.findByTestId('note-editor');
    const box = within(editor).getByLabelText('Note') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'a note' } });
    box.setSelectionRange(0, 6);
    fireEvent.click(within(editor).getByLabelText('Bold'));
    await waitFor(() => expect((within(editor).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('**a note**'));
    // The note is shown once, in the box being typed into (10 C).
    expect(within(editor).queryByTestId('note-preview')).not.toBeInTheDocument();

    fireEvent.click(within(editor).getByTestId('note-color-blue'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.notes.save).toHaveBeenCalledWith(expect.objectContaining({ text: '**a note**', color: 'blue' }))
    );
  });

  it('draws an annotation behind its words, and opens it on a click (9 B2)', async () => {
    api.notes.list.mockResolvedValue([mkNote(7, 0, 1, 1, 3, 'on these words', 'green')]);
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(document.querySelector('[data-token="1"]')).toBeTruthy());

    const marked = document.querySelectorAll('.tok-note-green');
    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0].getAttribute('data-mark')).toBe('7');
    expect(marked[0].getAttribute('title')).toBe('on these words');
    // A token outside the range is not marked.
    expect(document.querySelector('[data-token="0"]')!.className).not.toContain('tok-note');

    fireEvent.click(marked[0]);
    const editor = await screen.findByTestId('note-editor');
    expect((within(editor).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('on these words');
  });

  it('lists the annotations under the contents, closed to begin with (9 B1)', async () => {
    api.notes.list.mockResolvedValue([
      mkNote(7, 0, 1, 1, 3, 'first note', 'green', 'حدثنا ابو'),
      mkNote(8, 1, 1, 0, 2, 'second note\nand more', 'red', 'باب ما'),
    ]);
    render(<ReadPanel book={book} />);
    const toc = await screen.findByTestId('toc-pane');

    const section = within(toc).getByTestId('annotations-section');
    expect(section).toHaveTextContent('Annotations');
    expect(section).toHaveTextContent('2');
    expect(within(toc).queryByTestId('annotations-list')).not.toBeInTheDocument();

    fireEvent.click(within(section).getByTestId('annotations-toggle'));
    const list = await within(toc).findByTestId('annotations-list');
    // The page by the C1 rule and the note's first line, and (10 C) not
    // the Arabic it sits on, which is in the text.
    expect(list).toHaveTextContent('1:7');
    expect(list).toHaveTextContent('2:3');
    expect(list).toHaveTextContent('first note');
    expect(list).toHaveTextContent('second note');
    expect(list).not.toHaveTextContent('and more');
    expect(list).not.toHaveTextContent('حدثنا ابو');
    // And the strip that used to list them over the text is gone.
    expect(screen.queryByTestId('page-notes')).not.toBeInTheDocument();

    // And it navigates.
    fireEvent.click(within(list).getByTestId('annotation-8'));
    await waitFor(() => expect(api.lab.getPage).toHaveBeenCalledWith(527, 1, 1));
  });

  it('cites the text at the page being read, in both styles (9 C)', async () => {
    const cited: BookMetadata = {
      ...book,
      paginated: true,
      citation_json: JSON.stringify({
        title: 'Al-tawahhum',
        authors: ['al-Muḥāsibī, al-Ḥārith'],
        editors: [],
        translators: [],
        arrangers: [],
        place: 'Aleppo',
        publisher: 'Maktabat al-Turāth al-Islāmī',
        date: null,
        edition: null,
        volumes: null,
        warnings: [],
      }),
    };
    render(<ReadPanel book={cited} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));

    fireEvent.click(screen.getByTestId('cite'));
    const modal = await screen.findByTestId('cite-modal');
    const text = within(modal).getByTestId('citation-text');
    expect(text).toHaveTextContent('Al-tawahhum');
    // The page being read, by the C1 rule: volume 1, printed page 7.
    expect(text).toHaveTextContent('Vol. 1');
    expect(text).toHaveTextContent('7');

    // The other style is the shared formatter's, not a second implementation.
    fireEvent.click(within(modal).getByRole('button', { name: 'MLA' }));
    expect(within(modal).getByTestId('citation-text')).toHaveTextContent('Al-tawahhum');

    // And it copies, plain.
    const writeText = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(modal).getByTestId('copy-citation'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).not.toContain('<');
  });

  it('says so when a text has no citation data (9 C)', async () => {
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
    fireEvent.click(screen.getByTestId('cite'));
    expect(await screen.findByTestId('cite-modal')).toHaveTextContent('No citation data');
  });

  it('scrolls a hit into view when the caller sends us to one (10 G)', async () => {
    // jsdom has no scrollIntoView, so the reader's guard skips it; here it
    // exists and records which element it was asked to show.
    const seen: string[] = [];
    const spy = vi.fn(function (this: Element) {
      seen.push(this.getAttribute('data-token') ?? '');
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: spy, writable: true, configurable: true });

    render(<ReadPanel book={book} initialAt={{ part_index: 1, page_id: 1 }} highlight={[2, 4]} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('2:3'));
    await waitFor(() => expect(seen).toContain('2'));
    expect(spy).toHaveBeenCalledWith({ block: 'center' });
  });

  it('hands the open page to Reuse (7 B)', async () => {
    const onFindReuse = vi.fn();
    render(<ReadPanel book={book} onFindReuse={onFindReuse} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
    fireEvent.click(screen.getByTestId('find-reuse-page'));
    expect(onFindReuse).toHaveBeenCalledWith({ part_index: 0, page_id: 1 });
  });

  it('shows the search form beside the text and lists results below it (7 B)', async () => {
    api.search.mockResolvedValue({
      hits: [{ part_index: 0, page_id: 2, part_label: '', page_number: '8', body: 'ثم قال رحمه الله', score: 1, matched: [1] }],
      total: 1,
      elapsed_ms: 4,
      capped: false,
    });
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
    expect(screen.getByTestId('search-rail')).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('Term')[0], { target: { value: 'قال' } });
    fireEvent.click(screen.getByTestId('run-search'));
    await waitFor(() => expect(api.search).toHaveBeenCalled());

    const hit = await screen.findByTestId('search-hit');
    expect(hit).toHaveTextContent('8');
    // Clicking it moves the text above to that page.
    fireEvent.click(hit);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:8'));
  });

  it('folds the search rail on every search; the button and the shortcut open it again', async () => {
    render(<ReadPanel book={book} />);
    await waitFor(() => expect(screen.getByTestId('read-locator')).toHaveTextContent('1:7'));
    expect(screen.getByTestId('search-rail')).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('Term')[0], { target: { value: 'قال' } });
    fireEvent.click(screen.getByTestId('run-search'));
    await waitFor(() => expect(api.search).toHaveBeenCalled());
    // The results and the text take the width.
    expect(screen.queryByTestId('search-rail')).not.toBeInTheDocument();

    // Back from the same toggle, with the terms still in it.
    fireEvent.click(screen.getByTestId('open-search-rail'));
    expect(screen.getByTestId('search-rail')).toBeInTheDocument();
    expect((screen.getAllByLabelText('Term')[0] as HTMLInputElement).value).toBe('قال');
    // Every search folds it, not only the first.
    fireEvent.click(screen.getByTestId('run-search'));
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('search-rail')).not.toBeInTheDocument();

    // The shortcut opens and closes it.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByTestId('search-rail')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.queryByTestId('search-rail')).not.toBeInTheDocument();
  });

  it('says why the contents are missing rather than showing an empty pane', async () => {
    api.toc.tree.mockRejectedValue(new Error('The table of contents is not available in this mode: toc.db ships with corpus 4.2.0'));
    api.toc.rows.mockRejectedValue(new Error('no toc'));
    render(<ReadPanel book={book} />);
    const toc = await screen.findByTestId('toc-pane');
    await waitFor(() => expect(within(toc).getByRole('alert')).toHaveTextContent('4.2.0'));
  });
});
