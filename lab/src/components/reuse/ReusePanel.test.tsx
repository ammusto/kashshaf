import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The reuse panel against a mocked bridge (spec §9, "Frontend"), as spec 1.5
 * §H restructured it: the left half is the Read panel, so a selection there
 * runs passage mode with the page's coordinates; the result is one row per
 * match with the book, the words and the page; clicking a row opens that page
 * with a way back; the parameters live behind the gear and the threshold and
 * type filters hide without re-running; the banality slider re-scores through
 * Rust; a section or whole-text run goes through the size warning and needs
 * the local corpus.
 */

const api = vi.hoisted(() => {
  const reuse = {
    passage: vi.fn(),
    rescore: vi.fn(),
    verdict: vi.fn(),
    runs: vi.fn(async (): Promise<unknown[]> => []),
    matches: vi.fn(async (): Promise<unknown[]> => []),
    estimate: vi.fn(),
    book: vi.fn(),
    pageLayer: vi.fn(async (): Promise<unknown[]> => []),
    export: vi.fn(async () => 'C:/lab/exports/reuse-run-1.csv'),
    onProgress: vi.fn(async () => () => {}),
  };
  const lab = {
    listPageRefs: vi.fn(),
    listPages: vi.fn(),
    getPage: vi.fn(),
    listBooks: vi.fn(async (): Promise<unknown[]> => [
      { id: 230, title: 'غريب الحديث', death_ah: 224 },
      { id: 1820, title: 'حلية الأولياء', death_ah: 430 },
    ]),
    runSize: vi.fn(async () => ({ book_id: 4382, pages: 10, book_pages: 10, tokens: 4_000, book_tokens: 4_000 })),
    statsCancel: vi.fn(),
    statsPause: vi.fn(async () => {}),
    getSetting: vi.fn(async (): Promise<string | null> => null),
    setSetting: vi.fn(async () => {}),
  };
  const workspace = {
    tree: vi.fn(async (): Promise<unknown[]> => []),
    rows: vi.fn(async (): Promise<unknown[]> => []),
    sectionRange: vi.fn(),
  };
  const notes = { list: vi.fn(async (): Promise<unknown[]> => []), save: vi.fn(), update: vi.fn(), delete: vi.fn() };
  return { reuse, lab, workspace, notes };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/reuse', async () => {
  const real = await vi.importActual<typeof import('../../api/reuse')>('../../api/reuse');
  return { ...real, reuseApi: api.reuse };
});
vi.mock('../../api/workspace', async () => {
  const real = await vi.importActual<typeof import('../../api/workspace')>('../../api/workspace');
  return { ...real, tocApi: api.workspace, notesApi: api.notes };
});

import { ReusePanel } from './ReusePanel';
import { resetReadMemory } from '../read/ReadPanel';
import type { MatchRow, PassageResult } from '../../api/reuse';

const book: BookMetadata = { id: 4382, title: 'إعلام الموقعين', in_corpus: true, parts: 1 };

function mkPage(bookId: number, pageId: number, words: string) {
  return {
    book_id: bookId,
    part_index: 0,
    page_id: pageId,
    part_label: 'ج١',
    page_number: String(pageId),
    body: words,
    tokens: words.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })),
  };
}

const queryPage = mkPage(4382, 118, 'ثم يؤتي بجهنم تعرض كانها السراب فيقال لليهود ما كنتم تعبدون فيقولون كنا نعبد عزير بن الله');
const targetPage = mkPage(5563, 6260, 'قال ثم يؤتي بجهنم تعرض كانها سراب فيقال لليهود ما كنتم تعبدون قالوا كنا نعبد عزير ابن الله');

const match = (id: number, score: number, kind: MatchRow['kind'], banal = 0.2): MatchRow => ({
  id,
  run_id: 1,
  book_id: 4382,
  part_index: 0,
  page_id: 118,
  tok_start: 0,
  tok_end: 15,
  snapshot: 'ثم يؤتي بجهنم',
  target: { book_id: 5563, part_index: 0, page_id: 6260 },
  target_title: 'منحة الباري',
  target_author: null,
  target_death_ah: 926,
  target_author_name: 'القسطلاني',
  target_parts: 1,
  t_start: 1,
  t_end: 16,
  pairs: Array.from({ length: 15 }, (_, i) => [i, i + 1] as [number, number]),
  components: { surface_agree: 0.9, lemma_agree: 1, root_agree: 1, coverage: 1, banal_share: banal, banality_factor: 1, aligned: 15 },
  score,
  kind,
  zone: null,
  anchor_hits: 3,
  target_end: null,
  query_end: null,
  user_verdict: null,
});

const passageResult = (matches: MatchRow[]): PassageResult => ({
  run_id: 1,
  params: { ...({} as PassageResult['params']), threshold: 0.35, banality_scale: 0.5 },
  anchors: [{ start: 1, terms: ['أتى', 'جهنم', 'عرض'], rank_sum: 9000 }],
  candidates: 4,
  tokens: 15,
  non_banal: 9,
  zones: [],
  matches,
  elapsed_ms: 120,
  cancelled: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetReadMemory();
  api.lab.listPageRefs.mockResolvedValue([{ book_id: 4382, part_index: 0, page_id: 118 }]);
  api.lab.listPages.mockImplementation(async (id: number) =>
    id === 5563
      ? [
          { book_id: 5563, part_index: 0, page_id: 6260, page_number: '6260', part_label: 'ج١' },
          { book_id: 5563, part_index: 0, page_id: 6261, page_number: '6261', part_label: 'ج١' },
        ]
      : [{ book_id: 4382, part_index: 0, page_id: 118, page_number: '118', part_label: 'ج١' }]
  );
  api.lab.getPage.mockImplementation(async (id: number, _p: number, pageId: number) =>
    id === 4382 && pageId === 118
      ? queryPage
      : id === 5563
        ? { ...targetPage, page_id: pageId, page_number: String(pageId) }
        : null
  );
  api.reuse.runs.mockResolvedValue([]);
  api.reuse.pageLayer.mockResolvedValue([]);
});

/** Select tokens [a, b) the way a person would: a real DOM selection. */
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

/** Select, then press Analyse selected, and wait for the rows (7 C1). */
async function findReuseOver(a: number, b: number) {
  await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
  selectTokens(a, b);
  await waitFor(() => expect(screen.getByTestId('analyse-selected')).toBeEnabled());
  fireEvent.click(screen.getByTestId('analyse-selected'));
  await waitFor(() => expect(api.reuse.passage).toHaveBeenCalled());
}

describe('ReusePanel', () => {
  it('asks for a text first', () => {
    render(<ReusePanel book={null} local />);
    expect(screen.getByText(/Open a text from the workspace/)).toBeInTheDocument();
  });

  it('runs passage mode on the selection in the Read panel and lists a row per match', async () => {
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim'), match(2, 0.2, 'weak')]));
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 8);

    const args = api.reuse.passage.mock.calls[0][0];
    expect(args).toMatchObject({ book_id: 4382, part_index: 0, page_id: 118, tok_start: 0, tok_end: 8 });
    expect(args.params.threshold).toBe(0.35);

    // One row, not two: the weak match is below the default threshold.
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(1));
    const row = screen.getByTestId('reuse-row');
    expect(row).toHaveTextContent('منحة الباري');
    // 7 C2: the death year leaves the cell and appears on hover, with the
    // title and the author.
    expect(row).not.toHaveTextContent('926');
    fireEvent.mouseEnter(within(row).getByText('منحة الباري'));
    await waitFor(() => expect(document.body).toHaveTextContent('القسطلاني'));
    expect(document.body).toHaveTextContent('died 926 AH');
    // Spec C1: a single-part book's page is its printed number, alone.
    expect(row).toHaveTextContent('6260');
    // The words, with a few on each side for context (spec H2).
    await waitFor(() => expect(row).toHaveTextContent('كانها'));

    // Lowering the threshold shows the weak one without running again.
    fireEvent.click(screen.getByTestId('reuse-gear'));
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '0.1' } });
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(2));
    expect(api.reuse.passage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('weak'));
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(1));
  });

  it('runs against one named text when the gear picks one', async () => {
    // Pairwise mode: the reader names the book instead of reading the whole
    // corpus and discarding it. The restriction has to travel with the run,
    // which is what the assertion on the passage call checks.
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());

    fireEvent.click(screen.getByTestId('reuse-gear'));
    fireEvent.change(screen.getByLabelText('Target text'), { target: { value: 'غريب' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.click(within(screen.getByRole('listbox')).getByText('غريب الحديث'));
    await waitFor(() => expect(screen.getByTestId('target-books-note')).toHaveTextContent('1 text'));

    // Naming a text is the mode: the note says the texts are read whole, and
    // the whole-text run, refused against the corpus, is offered now.
    expect(screen.getByTestId('target-books-note')).toHaveTextContent('read into memory');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByTestId('analyse-whole')).toBeEnabled();
    await findReuseOver(0, 3);
    await waitFor(() => expect(screen.getByTestId('run-mode')).toHaveTextContent('in named texts'));
    const args = api.reuse.passage.mock.calls[api.reuse.passage.mock.calls.length - 1][0] as { params?: { target_books?: number[]; retrieval?: string } };
    expect(args.params?.target_books).toEqual([230]);
  });

  it('keeps the lower-confidence rows of a named-text run behind a toggle', async () => {
    // Text-to-text calibrates to 0.70 on pair 1; the corpus view does not
    // hide anything. Rows under the line are a click away, not gone.
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.9, 'verbatim'), match(2, 0.7, 'inflected'), match(3, 0.55, 'paraphrase'), match(4, 0.4, 'paraphrase')]));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reuse-gear'));
    fireEvent.change(screen.getByLabelText('Target text'), { target: { value: 'غريب' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.click(within(screen.getByRole('listbox')).getByText('غريب الحديث'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await findReuseOver(0, 3);
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(2));
    // Three tiers: shown, probable (0.50-0.70), lower-confidence (under 0.50).
    const probable = screen.getByTestId('show-probable');
    expect(probable).toHaveTextContent('Show 1 probable match');
    expect(probable.getAttribute('title')).toMatch(/six in ten/);
    fireEvent.click(probable);
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(3));
    const toggle = screen.getByTestId('show-low');
    expect(toggle).toHaveTextContent('Show 1 lower-confidence match');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')).toHaveLength(4));
    expect(screen.getByTestId('show-low')).toHaveTextContent('Hide 1 lower-confidence match');
  });

  it('names the texts a famous passage appears in, and sorts them by the authors\' deaths', async () => {
    // Thirty-one texts, deaths in reverse order of score: the header says
    // how many, the sort puts the earliest author first.
    const many = Array.from({ length: 31 }, (_, i) => ({
      ...match(i + 1, 0.95 - i * 0.01, 'verbatim'),
      target: { book_id: 100 + i, part_index: 0, page_id: 1 },
      target_title: `كتاب ${i}`,
      target_death_ah: 900 - i,
    }));
    api.reuse.passage.mockResolvedValue(passageResult(many));
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 8);
    await waitFor(() => expect(screen.getByTestId('many-texts')).toHaveTextContent('This passage appears in 31 texts'));
    expect(screen.getAllByTestId('reuse-row')[0]).toHaveTextContent('كتاب 0');
    fireEvent.change(screen.getByLabelText('Sort matches'), { target: { value: 'death' } });
    await waitFor(() => expect(screen.getAllByTestId('reuse-row')[0]).toHaveTextContent('كتاب 30'));
  });

  it('reads a target span that runs over a page break as one passage', async () => {
    // A quotation split by the printer is still one quotation. The match
    // names both pages, the words come from both, and the break is marked
    // where it falls rather than cutting the passage in half.
    const first = mkPage(5563, 6260, 'قال ابو عبيد في');
    const second = mkPage(5563, 6261, 'الثاني من كلامه');
    // The span starts one word into 6260 and ends one word into 6261.
    const m = {
      ...match(1, 0.8, 'verbatim'),
      t_start: 1,
      t_end: 5,
      target_end: { book_id: 5563, part_index: 0, page_id: 6261 },
      pairs: [[0, 1], [1, 2], [2, 3], [3, 4]] as [number, number][],
    };
    api.reuse.passage.mockResolvedValue(passageResult([m]));
    api.lab.listPageRefs.mockImplementation(async (id: number) =>
      id === 5563
        ? [
            { book_id: 5563, part_index: 0, page_id: 6260 },
            { book_id: 5563, part_index: 0, page_id: 6261 },
          ]
        : [{ book_id: 4382, part_index: 0, page_id: 118 }]
    );
    api.lab.getPage.mockImplementation(async (id: number, _p: number, pageId: number) =>
      id === 4382 ? queryPage : pageId === 6261 ? second : first
    );
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 3);
    fireEvent.click(screen.getAllByTestId('reuse-row')[0]);

    await waitFor(() => expect(screen.getByTestId('target-span')).toHaveTextContent('6261'));
    const side = await screen.findByTestId('side-by-side');
    // Three words from the page it starts on and one from the next.
    expect(side).toHaveTextContent('ابو');
    await waitFor(() => expect(side).toHaveTextContent('الثاني'));
    expect(within(side).getByTestId('page-break')).toHaveTextContent('6261');
  });

  it('refuses a whole text against the whole corpus, and says why', async () => {
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    const whole = screen.getByTestId('analyse-whole');
    expect(whole).toBeDisabled();
    expect(whole.getAttribute('title')).toMatch(/hours to days/);
  });

  it('keeps the text pane shrinkable when a long passage is selected (A4)', async () => {
    // A flex item's default min-width is its content's width, so without
    // min-w-0 a multi-line selection made the reader grow over the results.
    // jsdom does no layout, so what is asserted is the rule that permits
    // shrinking; removing it is what caused the overlap.
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());

    const panel = screen.getByTestId('read-panel');
    expect(panel.className).toContain('min-w-0');
    expect(panel.className).toContain('overflow-hidden');

    // Select a long run, the case that broke it, and the pane still cannot
    // push its neighbour aside.
    selectTokens(0, 12);
    await waitFor(() => expect(screen.getByTestId('analyse-selected')).toBeEnabled());
    expect(screen.getByTestId('read-panel').className).toContain('min-w-0');
  });

  it('opens the matched page on a row click, and comes back to the results', async () => {
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    api.reuse.verdict.mockImplementation(async (id: number, v: string | null) => ({ ...match(1, 0.74, 'verbatim'), id, user_verdict: v }));
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 8);

    fireEvent.click(await screen.findByTestId('reuse-row'));
    const target = await screen.findByTestId('reuse-target');
    // The strip names the book and offers the way back; the page itself is
    // loaded in the reader on the left (7 C3).
    expect(target).toHaveTextContent('منحة الباري');
    expect(within(target).getByTestId('back-to-results')).toBeInTheDocument();
    await waitFor(() => expect(api.lab.getPage).toHaveBeenCalledWith(5563, 0, 6260));

    // The alignment is on from the start (10 H), and is still a toggle.
    const side = await screen.findByTestId('side-by-side');
    expect(side).toHaveTextContent('this text');
    expect(side).toHaveTextContent('the other');
    expect(side.querySelectorAll('.lay-pair-7').length).toBe(2);
    fireEvent.click(within(target).getByLabelText('Side by side'));
    await waitFor(() => expect(screen.queryByTestId('side-by-side')).not.toBeInTheDocument());

    fireEvent.click(within(target).getByLabelText('Confirm this match'));
    await waitFor(() => expect(api.reuse.verdict).toHaveBeenCalledWith(1, 'confirmed'));

    fireEvent.click(screen.getByTestId('back-to-results'));
    await waitFor(() => expect(screen.getByTestId('reuse-row')).toBeInTheDocument());
  });

  it('opens the other text in a second reader, green here and red there (8 D)', async () => {
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 8);

    // One reader until a row is opened.
    expect(screen.getAllByTestId('read-panel')).toHaveLength(1);
    fireEvent.click(await screen.findByTestId('reuse-row'));

    await waitFor(() => expect(screen.getAllByTestId('read-panel')).toHaveLength(2));
    const [left, right] = screen.getAllByTestId('read-panel');
    // Two panes, each with its own scroll.
    expect(screen.getAllByTestId('reader-pane')).toHaveLength(2);

    // The left one stayed on the query text and marks the query span green.
    expect(within(left).getByTestId('read-locator')).toHaveTextContent('118');
    const green = left.querySelectorAll('.tok-hit');
    expect(green.length).toBeGreaterThan(0);
    expect(green[0].getAttribute('data-token')).toBe('0');
    expect(left.querySelectorAll('.tok-match')).toHaveLength(0);

    // The right one loaded the other book, at the matched page, in red.
    await waitFor(() => expect(api.lab.listPages).toHaveBeenCalledWith(5563));
    await waitFor(() => expect(right.querySelectorAll('.tok-match').length).toBeGreaterThan(0));
    expect(right.querySelectorAll('.tok-match')[0].getAttribute('data-token')).toBe('1');
    expect(right.querySelectorAll('.tok-hit')).toHaveLength(0);
    // Its text is the other book's, not this one's.
    expect(right).toHaveTextContent('عزير ابن الله');

    // The header says whose book it is, by whom, and which page (§C1).
    const target = screen.getByTestId('reuse-target');
    expect(target).toHaveTextContent('منحة الباري');
    expect(target).toHaveTextContent('القسطلاني');
    expect(within(target).getByTestId('target-page')).toHaveTextContent('6260');

    // The alignment is already on, and is still a toggle (10 H).
    expect(await screen.findByTestId('side-by-side')).toBeInTheDocument();
    fireEvent.click(within(target).getByLabelText('Side by side'));
    await waitFor(() => expect(screen.queryByTestId('side-by-side')).not.toBeInTheDocument());

    // A keystroke belongs to the reader the pointer is over, not to both.
    // React synthesises mouseenter from mouseover, so that is what to fire.
    fireEvent.mouseOver(right);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(within(right).getByTestId('read-locator')).toHaveTextContent('6261'));
    expect(within(left).getByTestId('read-locator')).toHaveTextContent('118');

    // Back to the table, and the left reader has not moved.
    fireEvent.click(screen.getByTestId('back-to-results'));
    await waitFor(() => expect(screen.getByTestId('reuse-row')).toBeInTheDocument());
    expect(screen.getAllByTestId('read-panel')).toHaveLength(1);
    expect(within(screen.getByTestId('read-panel')).getByTestId('read-locator')).toHaveTextContent('118');
  });

  it('re-scores through Rust when the banality slider moves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    api.reuse.rescore.mockResolvedValue([match(1, 0.5, 'formulaic')]);
    render(<ReusePanel book={book} local />);
    await findReuseOver(0, 8);
    await waitFor(() => expect(screen.getByTestId('reuse-row')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('reuse-gear'));
    fireEvent.change(screen.getByLabelText('Banality scale'), { target: { value: '0.2' } });
    await waitFor(() => expect(api.reuse.rescore).toHaveBeenCalledWith(1, expect.objectContaining({ banality_scale: 0.2 })));
    // It came back formulaic, which is hidden by default.
    await waitFor(() => expect(screen.queryByTestId('reuse-row')).not.toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('formulaic'));
    await waitFor(() => expect(screen.getByTestId('reuse-row')).toBeInTheDocument());
    vi.useRealTimers();
  });

  it('warns before a heavy whole-text run, and book mode needs the local corpus', async () => {
    api.lab.runSize.mockResolvedValue({ book_id: 4382, pages: 4_000, book_pages: 4_000, tokens: 900_000, book_tokens: 900_000 });
    api.reuse.estimate.mockResolvedValue({ book_id: 4382, pages: 4_000, windows: 120, sampled: 20, sample_ms: 400, estimate_ms: 2400, sample_matches: 3 });
    api.reuse.book.mockResolvedValue({
      run_id: 2,
      book_id: 4382,
      pages: 4_000,
      pages_done: 4_000,
      windows: 120,
      windows_done: 120,
      matches: 1,
      aggregates: [{ book_id: 5563, matches: 1, aligned_tokens: 15, best_score: 0.74, types: { verbatim: 1 }, title: 'منحة الباري', author_id: null, death_ah: 926 }],
      elapsed_ms: 2500,
      cancelled: false,
      params: { threshold: 0.35, banality_scale: 0.5 },
    });
    api.reuse.matches.mockResolvedValue([match(7, 0.74, 'verbatim')]);

    const { unmount } = render(<ReusePanel book={book} local />);
    // A whole text runs only in named texts; the size warning is the same.
    fireEvent.click(screen.getByTestId('reuse-gear'));
    fireEvent.change(screen.getByLabelText('Target text'), { target: { value: 'غريب' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.click(within(screen.getByRole('listbox')).getByText('غريب الحديث'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Find in whole text' }));

    // Over the Settings thresholds, so it asks first (spec 1.5 F4).
    const modal = await screen.findByTestId('heavy-run-modal');
    expect(modal).toHaveTextContent('4,000 pages');
    expect(modal).toHaveTextContent('900,000 tokens');
    expect(api.reuse.book).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.reuse.book).toHaveBeenCalledWith(4382, expect.anything(), null));
    await waitFor(() => expect(screen.getByTestId('reuse-aggregates')).toBeInTheDocument());
    expect(screen.getByTestId('reuse-aggregates')).toHaveTextContent('منحة الباري');
    unmount();

    render(<ReusePanel book={book} local={false} />);
    expect(await screen.findByRole('button', { name: 'Find in whole text' })).toBeDisabled();
  });
});
