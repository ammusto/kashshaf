import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The reuse panel against a mocked bridge (spec §9, "Frontend"): a selection
 * runs passage mode with the page's coordinates; the threshold and type
 * filters hide without re-running; the banality slider re-scores through
 * Rust; confirm writes a verdict; book mode goes through the estimate; a
 * non-local source cannot start book mode.
 */

const api = vi.hoisted(() => {
  const reuse = {
    passage: vi.fn(),
    rescore: vi.fn(),
    verdict: vi.fn(),
    runs: vi.fn(async () => []),
    matches: vi.fn(async () => []),
    estimate: vi.fn(),
    book: vi.fn(),
    pageLayer: vi.fn(async () => []),
    export: vi.fn(async () => 'C:/lab/exports/reuse-run-1.csv'),
    onProgress: vi.fn(async () => () => {}),
  };
  const lab = {
    listPageRefs: vi.fn(),
    getPage: vi.fn(),
    statsCancel: vi.fn(),
  };
  return { reuse, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/reuse', async () => {
  const real = await vi.importActual<typeof import('../../api/reuse')>('../../api/reuse');
  return { ...real, reuseApi: api.reuse };
});

import { ReusePanel } from './ReusePanel';
import type { MatchRow, PassageResult } from '../../api/reuse';

const book: BookMetadata = { id: 4382, title: 'إعلام الموقعين', in_corpus: true };

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
  t_start: 1,
  t_end: 16,
  pairs: Array.from({ length: 15 }, (_, i) => [i, i + 1] as [number, number]),
  components: { surface_agree: 0.9, lemma_agree: 1, root_agree: 1, coverage: 1, banal_share: banal, banality_factor: 1, aligned: 15 },
  score,
  kind,
  zone: null,
  anchor_hits: 3,
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
  api.lab.listPageRefs.mockResolvedValue([{ book_id: 4382, part_index: 0, page_id: 118 }]);
  api.lab.getPage.mockImplementation(async (id: number, _p: number, pageId: number) => (id === 4382 && pageId === 118 ? queryPage : id === 5563 ? targetPage : null));
  api.reuse.runs.mockResolvedValue([]);
  api.reuse.pageLayer.mockResolvedValue([]);
});

/** Select tokens [a, b) in the reader by mouse. */
function selectTokens(a: number, b: number) {
  const first = document.querySelector(`[data-token="${a}"]`) as HTMLElement;
  const last = document.querySelector(`[data-token="${b - 1}"]`) as HTMLElement;
  fireEvent.mouseDown(first);
  fireEvent.mouseEnter(last);
  fireEvent.mouseUp(last);
}

describe('ReusePanel', () => {
  it('asks for a book first', () => {
    render(<ReusePanel book={null} local />);
    expect(screen.getByText(/Choose a book/)).toBeInTheDocument();
  });

  it('runs passage mode on the selected range and lists matches grouped by target book', async () => {
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim'), match(2, 0.2, 'weak')]));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    const find = screen.getByRole('button', { name: 'Find reuse' });
    expect(find).toBeDisabled();
    selectTokens(0, 8);
    await waitFor(() => expect(find).toBeEnabled());
    fireEvent.click(find);
    await waitFor(() => expect(api.reuse.passage).toHaveBeenCalled());
    const args = api.reuse.passage.mock.calls[0][0];
    expect(args).toMatchObject({ book_id: 4382, part_index: 0, page_id: 118, tok_start: 0, tok_end: 8 });
    expect(args.params.threshold).toBe(0.35);
    await waitFor(() => expect(screen.getByTestId('match-1')).toBeInTheDocument());
    // The weak one sits below the default threshold: hidden without a re-run.
    expect(screen.queryByTestId('match-2')).not.toBeInTheDocument();
    expect(screen.getByText('منحة الباري')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 anchors · 4 candidate pages · 2 matches (1 at threshold)');
    // Lower the threshold: the weak match appears, still without a re-run.
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '0.1' } });
    await waitFor(() => expect(screen.getByTestId('match-2')).toBeInTheDocument());
    expect(api.reuse.passage).toHaveBeenCalledTimes(1);
    // Hide the type.
    fireEvent.click(screen.getByLabelText('Show weak'));
    await waitFor(() => expect(screen.queryByTestId('match-2')).not.toBeInTheDocument());
  });

  it('re-scores through Rust when the banality slider moves, and confirm writes a verdict', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    api.reuse.rescore.mockResolvedValue([{ ...match(1, 0.5, 'formulaic'), components: { ...match(1, 0.5, 'formulaic').components, banality_factor: 0.2 } }]);
    api.reuse.verdict.mockImplementation(async (id: number, v: string | null) => ({ ...match(1, 0.5, 'formulaic'), id, user_verdict: v }));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    selectTokens(0, 8);
    fireEvent.click(await screen.findByRole('button', { name: 'Find reuse' }));
    await waitFor(() => expect(screen.getByTestId('match-1')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Banality scale'), { target: { value: '0.2' } });
    await waitFor(() => expect(api.reuse.rescore).toHaveBeenCalledWith(1, expect.objectContaining({ banality_scale: 0.2 })));
    // Formulaic is default-hidden; it went formulaic, so it disappears until shown.
    await waitFor(() => expect(screen.queryByTestId('match-1')).not.toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Show formulaic'));
    await waitFor(() => expect(screen.getByTestId('match-1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Confirm match 1'));
    await waitFor(() => expect(api.reuse.verdict).toHaveBeenCalledWith(1, 'confirmed'));
    vi.useRealTimers();
  });

  it('shows the side-by-side aligned view when a match is expanded', async () => {
    api.reuse.passage.mockResolvedValue(passageResult([match(1, 0.74, 'verbatim')]));
    render(<ReusePanel book={book} local />);
    await waitFor(() => expect(document.querySelector('[data-token="0"]')).toBeTruthy());
    selectTokens(0, 8);
    fireEvent.click(await screen.findByRole('button', { name: 'Find reuse' }));
    const card = await screen.findByTestId('match-1');
    fireEvent.click(within(card).getByRole('button', { expanded: false }));
    const side = await screen.findByTestId('side-by-side');
    expect(side).toHaveTextContent('query');
    expect(side).toHaveTextContent('target');
    // Aligned tokens on both sides carry the same pair colour (eight colours
    // cycle: pair 7 is the only one with colour 7 among 15 pairs).
    expect(side.querySelectorAll('.lay-pair-7').length).toBe(2);
    expect(side.querySelectorAll('.lay-pair-0').length).toBe(4);
    // The target line emphasises tokens whose surface is the same.
    expect(card.querySelectorAll('.tok-aligned-same').length).toBeGreaterThan(5);
  });

  it('book mode goes through the estimate and is local-only', async () => {
    api.reuse.estimate.mockResolvedValue({ book_id: 4382, pages: 10, windows: 120, sampled: 20, sample_ms: 400, estimate_ms: 2400, sample_matches: 3 });
    api.reuse.book.mockResolvedValue({ run_id: 2, book_id: 4382, pages: 10, pages_done: 10, windows: 120, windows_done: 120, matches: 1, aggregates: [{ book_id: 5563, matches: 1, aligned_tokens: 15, best_score: 0.74, types: { verbatim: 1 }, title: 'منحة الباري', author_id: null, death_ah: 926 }], elapsed_ms: 2500, cancelled: false, params: { threshold: 0.35, banality_scale: 0.5 } });
    api.reuse.matches.mockResolvedValue([match(7, 0.74, 'verbatim')]);
    const { unmount } = render(<ReusePanel book={book} local />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyse whole book' }));
    const dialog = await screen.findByRole('dialog', { name: 'Estimate' });
    expect(dialog).toHaveTextContent('120 windows');
    expect(dialog).toHaveTextContent('2 s');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.reuse.book).toHaveBeenCalledWith(4382, expect.anything()));
    await waitFor(() => expect(screen.getByTestId('reuse-aggregates')).toBeInTheDocument());
    expect(screen.getByTestId('reuse-aggregates')).toHaveTextContent('منحة الباري');
    await waitFor(() => expect(screen.getByTestId('match-7')).toBeInTheDocument());
    unmount();
    render(<ReusePanel book={book} local={false} />);
    expect(await screen.findByRole('button', { name: 'Analyse whole book' })).toBeDisabled();
    expect(screen.getByText(/book mode: local only/)).toBeInTheDocument();
  });
});
