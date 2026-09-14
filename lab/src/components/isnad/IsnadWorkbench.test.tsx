import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The workbench against a mocked bridge (spec §9, "Frontend"): its states
 * render, and each action produces the expected `Op` — the DB write, one
 * step removed — with the inverse landing on the undo stack.
 */

const api = vi.hoisted(() => {
  const isnad = {
    run: vi.fn(),
    onRunProgress: vi.fn(async () => () => {}),
    list: vi.fn(),
    get: vi.fn(),
    classes: vi.fn(),
    apply: vi.fn(),
    transmitters: vi.fn(),
    persons: vi.fn(),
    suggestionsForPage: vi.fn(),
    retagCounts: vi.fn(),
    lexiconAdd: vi.fn(),
    exportIsnads: vi.fn(),
    exportAuthority: vi.fn(),
  };
  const lab = {
    getPage: vi.fn(),
    listPageRefs: vi.fn(async () => [{ book_id: 527, part_index: 0, page_id: 9 }]),
    statsCancel: vi.fn(),
    saveExport: vi.fn(async (name: string, _c: string) => `C:/lab/exports/${name}`),
  };
  return { isnad, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/isnad', async () => {
  const real = await vi.importActual<typeof import('../../api/isnad')>('../../api/isnad');
  // The tracked helpers close over the module's own `isnadApi`, so they
  // are re-bound here to the mock; the stack logic is the same.
  type Stack = { undo: unknown[]; redo: unknown[] };
  return {
    ...real,
    isnadApi: api.isnad,
    applyTracked: async (stack: Stack, op: unknown) => {
      const r = await api.isnad.apply(op);
      stack.undo.push(r.inverse);
      stack.redo.length = 0;
      return r;
    },
    undoTracked: async (stack: Stack) => {
      const inv = stack.undo.pop();
      if (!inv) return false;
      const r = await api.isnad.apply(inv);
      stack.redo.push(r.inverse);
      return true;
    },
    redoTracked: async (stack: Stack) => {
      const op = stack.redo.pop();
      if (!op) return false;
      const r = await api.isnad.apply(op);
      stack.undo.push(r.inverse);
      return true;
    },
  };
});

import { IsnadWorkbench } from './IsnadWorkbench';
import type { IsnadRow, TransmitterListRow, PersonRow } from '../../api/isnad';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true };

const page = {
  book_id: 527,
  part_index: 0,
  page_id: 9,
  part_label: 'ج١',
  page_number: '9',
  body: 'حدثنا ابو داود قال نا عبد السلام بن مطهر قال نا جعفر عن الجريري عن وهب بن منبه قال كانت في بني اسرائيل',
  tokens: 'حدثنا ابو داود قال نا عبد السلام بن مطهر قال نا جعفر عن الجريري عن وهب بن منبه قال كانت في بني اسرائيل'
    .split(' ')
    .map((surface, idx) => ({ idx, surface, lemma: surface, pos: 'noun', features: [], clitics: [] })),
};

function transmitter(id: number, position: number, s: number, e: number, raw: string, extra: Partial<TransmitterListRow> = {}): TransmitterListRow {
  return {
    id, isnad_id: 1, position, tok_start: s, tok_end: e, raw, kunya: null, ism: raw, nasab: null, nisba: null, laqab: null,
    place: null,
    verb_before: 'نا', person_id: null, form_norm: raw, suggested_person_id: null,
    part_index: 0, page_id: 9, isnad_status: 'candidate', form_count: 1, person_name: null, suggested_person_name: null, ...extra,
  };
}

const row: IsnadRow = {
  id: 1, book_id: 527, part_index: 0, page_id: 9, tok_start: 0, tok_end: 19, kind: 'isnad',
  end_part_index: null,
  end_page_id: null,
  matn_end_part_index: null,
  matn_end_page_id: null,
  matn_tok_start: 19, matn_tok_end: 23, links: 5, confidence: 0.6,
  confidence_json: JSON.stringify({ links: 1, noun_prop: 0, terminal: 1, clean: 1, total: 0.6 }),
  status: 'candidate', created_at: 't', updated_at: 't', overrides: {},
  transmitters: [
    transmitter(11, 0, 1, 3, 'ابو داود'),
    transmitter(12, 1, 5, 9, 'عبد السلام بن مطهر'),
    transmitter(13, 2, 11, 12, 'جعفر'),
    transmitter(14, 3, 13, 14, 'الجريري'),
    transmitter(15, 4, 15, 18, 'وهب بن منبه'),
  ],
};

const persons: PersonRow[] = [
  { id: 7, canonical_name: 'أبو داود السجستاني', death_ah: 275, notes: null, created_at: 't', updated_at: 't', linked: 1, forms: [{ id: 1, person_id: 7, form: 'ابو داود', form_norm: 'ابو داود', source: 'user' }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.isnad.list.mockResolvedValue([row]);
  api.isnad.get.mockResolvedValue(row);
  api.isnad.classes.mockResolvedValue(page.tokens.map((t, i) => [i, [0, 3, 4, 9, 10, 18].includes(i) ? 'verb' : 'name'] as [number, 'verb' | 'name']));
  api.isnad.transmitters.mockResolvedValue([
    ...row.transmitters,
    transmitter(21, 0, 1, 3, 'ابو داود', { isnad_id: 2, page_id: 10, person_id: 7, person_name: 'أبو داود السجستاني', form_count: 2 }),
    transmitter(22, 1, 5, 6, 'مالك', { isnad_id: 2, page_id: 10, suggested_person_id: 7, suggested_person_name: 'أبو داود السجستاني' }),
  ]);
  api.isnad.persons.mockResolvedValue(persons);
  api.isnad.apply.mockImplementation(async (op: { op: string }) => ({ log_id: 1, inverse: { op: 'set_status', isnad_id: 1, status: 'candidate' }, applied: op }));
  api.lab.getPage.mockResolvedValue(page);
});

describe('IsnadWorkbench', () => {
  it('renders a span that crosses a page break with the break marked and steps through it (fix 1)', async () => {
    // Page 9 (23 tokens) holds the chain's start; page 10 holds its end and the matn.
    const page10 = { ...page, page_id: 10, page_number: '10', body: 'عن وهب بن منبه قال اني اجد في كتاب الله', tokens: 'عن وهب بن منبه قال اني اجد في كتاب الله'.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })) };
    const twoPage: IsnadRow = {
      ...row,
      tok_start: 0,
      tok_end: 29,
      end_part_index: 0,
      end_page_id: 10,
      matn_tok_start: 29,
      matn_tok_end: 34,
      matn_end_part_index: 0,
      matn_end_page_id: 10,
      transmitters: [...row.transmitters, { ...row.transmitters[0], id: 99, position: 4, tok_start: 25, tok_end: 28, raw: 'وهب بن منبه', part_index: 0, page_id: 10 }],
    };
    api.lab.listPageRefs.mockResolvedValue([{ book_id: 527, part_index: 0, page_id: 9 }, { book_id: 527, part_index: 0, page_id: 10 }, { book_id: 527, part_index: 0, page_id: 11 }]);
    api.lab.getPage.mockImplementation(async (_b: number, _p: number, id: number) => (id === 9 ? page : id === 10 ? page10 : null));
    api.isnad.list.mockResolvedValue([twoPage]);
    api.isnad.classes.mockResolvedValue([[0, 'verb'], [24, 'connect'], [28, 'verb']]);
    api.isnad.transmitters.mockResolvedValue([]);
    api.isnad.persons.mockResolvedValue([]);
    render(<IsnadWorkbench book={book} />);
    const bar = await screen.findByTestId('span-pages');
    expect(bar).toHaveTextContent('runs over 2 pages');
    expect(bar).toHaveTextContent('continues on the next page');
    // The first page: the chain layer runs to the page end.
    await waitFor(() => expect(document.querySelector('[data-token="22"]')?.className).toContain('lay-'));
    fireEvent.click(screen.getByRole('button', { name: 'next page ›' }));
    await waitFor(() => expect(screen.getByTestId('span-pages')).toHaveTextContent('page 2 of 2'));
    expect(screen.getByTestId('span-pages')).toHaveTextContent('continued from the previous page');
    // On the second page the transmitter at stream 25–28 is page-local 2–5, and the matn follows at 6.
    await waitFor(() => expect(document.querySelector('[data-token="2"]')?.className).toMatch(/lay-t\d/));
    expect(document.querySelector('[data-token="6"]')?.className).toContain('lay-matn');
    // A matn-start click on the second page sends the stream offset.
    fireEvent.click(screen.getByRole('button', { name: /Matn starts at/ }));
    fireEvent.mouseDown(document.querySelector('[data-token="7"]') as HTMLElement);
    fireEvent.mouseUp(document.querySelector('[data-token="7"]') as HTMLElement);
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith(expect.objectContaining({ op: 'set_matn', start: 30 })));
  });

  it('opens the reader at a table row’s occurrence with the name highlighted, and a token click selects its row (fix 7)', async () => {
    api.isnad.list.mockResolvedValue([row]);
    api.isnad.get.mockResolvedValue(row);
    api.isnad.classes.mockResolvedValue([]);
    const tableRows = row.transmitters;
    api.isnad.transmitters.mockResolvedValue(tableRows);
    api.isnad.persons.mockResolvedValue([]);
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('transmitter-table');
    const cell = await screen.findByText(tableRows[1].raw, { selector: '[role="gridcell"], span, div' });
    fireEvent.click(cell.closest('[role="row"]') ?? cell);
    await waitFor(() => expect(document.querySelector(`[data-token="${tableRows[1].tok_start}"]`)?.className).toContain('tok-hit'));
    // A token inside the first transmitter selects that row on the right.
    fireEvent.mouseDown(document.querySelector('[data-token="1"]') as HTMLElement);
    fireEvent.mouseUp(document.querySelector('[data-token="1"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText(tableRows[0].raw, { selector: 'span.font-semibold' })).toBeInTheDocument());
  });

  it('asks for a book first', () => {
    render(<IsnadWorkbench book={null} />);
    expect(screen.getByText('Choose a book in Books first.')).toBeInTheDocument();
  });

  it('shows the current candidate as a structured chain with its confidence components', async () => {
    render(<IsnadWorkbench book={book} />);
    expect(await screen.findByTestId('candidate-count')).toHaveTextContent('1 / 1');
    const chain = screen.getByTestId('structured-chain');
    expect(chain).toHaveTextContent('ابو داود');
    expect(chain).toHaveTextContent('وهب بن منبه');
    expect(chain).toHaveTextContent('[نا]');
    expect(screen.getByTestId('confidence')).toHaveTextContent('confidence 0.60');
    expect(screen.getByTestId('confidence')).toHaveTextContent('terminal 1');
    // The list was asked with the default filter: candidates at ≥ 0.2.
    expect(api.isnad.list).toHaveBeenCalledWith(527, expect.objectContaining({ status: 'candidate', min_confidence: 0.2 }));
  });

  it('colours the page: transmitters, verbs and matn each get their layer', async () => {
    const { container } = render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    await waitFor(() => expect(container.querySelectorAll('[data-token]').length).toBeGreaterThan(0));
    const cls = (i: number) => container.querySelector(`[data-token="${i}"]`)!.className;
    expect(cls(1)).toContain('lay-t0');
    expect(cls(5)).toContain('lay-t1');
    expect(cls(0)).toContain('lay-verb');
    expect(cls(20)).toContain('lay-matn');
  });

  it('confirms with the c key and rejects with x, each as one op', async () => {
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'set_status', isnad_id: 1, status: 'confirmed' }));
    fireEvent.keyDown(window, { key: 'x' });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'set_status', isnad_id: 1, status: 'rejected' }));
  });

  it('undoes with Ctrl+Z by applying the inverse the backend returned', async () => {
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm (c)' }));
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenLastCalledWith({ op: 'set_status', isnad_id: 1, status: 'candidate' }));
  });

  it('sets the matn boundary by clicking a token in matn-start mode', async () => {
    const { container } = render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    await waitFor(() => expect(container.querySelector('[data-token="20"]')).not.toBeNull());
    fireEvent.keyDown(window, { key: 'b' });
    const tok = container.querySelector('[data-token="20"]')!;
    fireEvent.mouseDown(tok);
    fireEvent.mouseUp(tok);
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'set_matn', isnad_id: 1, start: 20, end: 23 }));
  });

  it('splits the selected transmitter at a clicked word, and merges it with its neighbour', async () => {
    const { container } = render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    await waitFor(() => expect(container.querySelector('[data-token="7"]')).not.toBeNull());
    // Select عبد السلام بن مطهر by clicking inside it, enter split mode, click بن.
    const inside = container.querySelector('[data-token="6"]')!;
    fireEvent.mouseDown(inside);
    fireEvent.mouseUp(inside);
    fireEvent.keyDown(window, { key: 's' });
    const at = container.querySelector('[data-token="7"]')!;
    fireEvent.mouseDown(at);
    fireEvent.mouseUp(at);
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'split_transmitter', transmitter_id: 12, at: 7 }));
    fireEvent.keyDown(window, { key: 'm' });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'merge_transmitters', left_id: 12, right_id: 13 }));
  });

  it('retags a token and offers the lexicon after three', async () => {
    api.isnad.retagCounts.mockResolvedValue([['كتب', 'verb', 3]]);
    const { container } = render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    await waitFor(() => expect(container.querySelector('[data-token="19"]')).not.toBeNull());
    const tok = container.querySelector('[data-token="19"]')!;
    fireEvent.mouseDown(tok);
    fireEvent.mouseUp(tok);
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'v' });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'retag', isnad_id: 1, tok: 19, class: 'verb' }));
    const offer = await screen.findByTestId('lexicon-offer');
    expect(offer).toHaveTextContent('كتب');
    fireEvent.click(offer);
    await waitFor(() => expect(api.isnad.lexiconAdd).toHaveBeenCalledWith('transmission', 'core', ['كتب']));
  });

  it('lists transmitters with counts, a linked person and a dashed suggestion; suggestions are not applied', async () => {
    render(<IsnadWorkbench book={book} />);
    expect(await screen.findByTestId('table-count')).toHaveTextContent('7 rows');
    const table = screen.getByTestId('transmitter-table');
    expect(table).toHaveTextContent('أبو داود السجستاني?');
    expect(api.isnad.apply).not.toHaveBeenCalled();
    // Group by form collapses the two ابو داود rows.
    fireEvent.keyDown(window, { key: 'g' });
    expect(screen.getByTestId('table-count')).toHaveTextContent('6 rows');
    // Search narrows by the normalized form.
    fireEvent.change(screen.getByLabelText('Search transmitters'), { target: { value: 'وهب' } });
    expect(screen.getByTestId('table-count')).toHaveTextContent('1 rows');
  });

  it('links the selected transmitter to the selected row’s person with l', async () => {
    const { container } = render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('table-count');
    await waitFor(() => expect(container.querySelector('[data-token="2"]')).not.toBeNull());
    const inside = container.querySelector('[data-token="2"]')!;
    fireEvent.mouseDown(inside);
    fireEvent.mouseUp(inside);
    // The linked ابو داود row on the right (page 10).
    fireEvent.click(screen.getAllByText('أبو داود السجستاني')[0]);
    fireEvent.keyDown(window, { key: 'l' });
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'link', transmitter_id: 11, person_id: 7 }));
  });

  it('reviews page suggestions before applying them as one batch', async () => {
    api.isnad.suggestionsForPage.mockResolvedValue([{ op: 'link', transmitter_id: 22, person_id: 7 }]);
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    fireEvent.keyDown(window, { key: 'a' });
    expect(await screen.findByTestId('suggestions-review')).toHaveTextContent('Accept 1 suggestion on this page?');
    expect(api.isnad.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.isnad.apply).toHaveBeenCalledWith({ op: 'batch', ops: [{ op: 'link', transmitter_id: 22, person_id: 7 }] }));
  });

  it('runs extraction with the chosen parameters and shows the summary', async () => {
    api.isnad.run.mockResolvedValue({ book_id: 527, pages: 553, candidates: 412, kept_confirmed: 3, elapsed_ms: 1800, lexicon_hash: 'h' });
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    fireEvent.change(screen.getByLabelText('Min links'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extract isnāds' }));
    await waitFor(() => expect(api.isnad.run).toHaveBeenCalledWith(527, expect.objectContaining({ min_links: 3, lookahead: 3 })));
    expect(await screen.findByTestId('run-summary')).toHaveTextContent('412 candidates on 553 pages in 1.8 s · 3 decided rows kept');
  });

  it('exports isnāds through the backend into exports/', async () => {
    api.isnad.exportIsnads.mockResolvedValue('\uFEFFisnad_id,book_id\r\n1,527\r\n');
    render(<IsnadWorkbench book={book} />);
    await screen.findByTestId('structured-chain');
    fireEvent.change(screen.getByLabelText('Export'), { target: { value: 'flat-csv' } });
    await waitFor(() => expect(api.isnad.exportIsnads).toHaveBeenCalledWith(527, 'csv', 'flat'));
    await waitFor(() => expect(api.lab.saveExport).toHaveBeenCalledWith('book527-isnads-flat.csv', expect.stringContaining('isnad_id')));
  });
});
