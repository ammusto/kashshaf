import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The Qurʾān panel against a mocked bridge (spec §9, "Frontend"): the run
 * button drives `quran_run` and reloads the table; rows show sūra:āya, page,
 * text, agreement and cue; the filter hides; confirm writes a verdict; the
 * current page's quotations draw as a reader layer.
 */

const api = vi.hoisted(() => {
  const quran = {
    status: vi.fn(),
    run: vi.fn(),
    list: vi.fn(),
    page: vi.fn(),
    verdict: vi.fn(),
    export: vi.fn(async () => 'C:/lab/exports/quran-527.csv'),
    onProgress: vi.fn(async () => () => {}),
  };
  const lab = {
    listPageRefs: vi.fn(),
    getPage: vi.fn(),
    statsCancel: vi.fn(),
  };
  return { quran, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/reuse', async () => {
  const real = await vi.importActual<typeof import('../../api/reuse')>('../../api/reuse');
  return { ...real, quranApi: api.quran };
});

import { QuranPanel } from './QuranPanel';
import type { QuranMatchRow } from '../../api/reuse';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true };
const words = 'قال تعالى كل يوم هو في شان ثم قال الشيخ';
const page = {
  book_id: 527,
  part_index: 0,
  page_id: 169,
  part_label: 'ج١',
  page_number: '169',
  body: words,
  tokens: words.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })),
};

const row = (id: number, cue: string | null): QuranMatchRow => ({
  id,
  book_id: 527,
  part_index: 0,
  page_id: 169,
  tok_start: 2,
  tok_end: 7,
  snapshot: 'كل يوم هو في شان',
  sura: 55,
  sura_name: 'الرحمن',
  aya_start: 29,
  aya_end: 29,
  q_tok_start: 10,
  q_tok_end: 15,
  aya_text: 'كُلَّ يَوْمٍ هُوَ فِي شَأْنٍ',
  lemma_agree: 1,
  surface_agree: 1,
  aligned: 5,
  cue,
  user_verdict: null,
  detector_version: '0.1.0',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.quran.status.mockResolvedValue({ available: true, error: null, tokens: 78248, ayas: 6236, trigrams: 60000, fourgrams: 70000, fivegrams: 72000, ingest_version: '1', detector_version: '0.1.0' });
  api.lab.listPageRefs.mockResolvedValue([{ book_id: 527, part_index: 0, page_id: 169 }]);
  api.lab.getPage.mockResolvedValue(page);
});

describe('QuranPanel', () => {
  it('asks for a book first', () => {
    render(<QuranPanel book={null} />);
    expect(screen.getByText(/Choose a book/)).toBeInTheDocument();
  });

  it('runs detection, lists rows by sūra:āya with cue and agreement, filters, and confirms', async () => {
    api.quran.list.mockResolvedValueOnce([]).mockResolvedValue([row(1, 'قال تعالى'), row(2, null)]);
    api.quran.run.mockResolvedValue({ book_id: 527, pages: 553, pages_done: 553, hits: 2, kept_judged: 0, elapsed_ms: 900, cancelled: false, detector_version: '0.1.0' });
    api.quran.verdict.mockImplementation(async (id: number, v: string | null) => ({ ...row(id, 'قال تعالى'), user_verdict: v }));
    render(<QuranPanel book={book} />);
    expect(await screen.findByText(/Qurʾān 78,248 tokens/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Detect quotations' }));
    await waitFor(() => expect(api.quran.run).toHaveBeenCalledWith(527, expect.objectContaining({ min_tokens: 4, cued_min_tokens: 3 })));
    const table = await screen.findByTestId('quran-table');
    await waitFor(() => expect(table).toHaveTextContent('55:29'));
    expect(table).toHaveTextContent('الرحمن');
    expect(table).toHaveTextContent('كل يوم هو في شان');
    expect(table).toHaveTextContent('قال تعالى');
    expect(screen.getByRole('status')).toHaveTextContent('553/553 pages · 2 quotations found');
    // Filter to cued rows only.
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'cued' } });
    await waitFor(() => expect(screen.getByText('1/2 rows')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Confirm quotation 1'));
    await waitFor(() => expect(api.quran.verdict).toHaveBeenCalledWith(1, 'confirmed'));
    // The page's quotation draws as a layer in the reader.
    await waitFor(() => expect(document.querySelector('[data-token="3"]')?.className).toMatch(/lay-quran/));
    expect(document.querySelector('[data-token="0"]')?.className).not.toMatch(/lay-quran/);
  });

  it('says why detection is off when the Qurʾān did not load', async () => {
    api.quran.status.mockResolvedValue({ available: false, error: 'quran.db could not be unpacked', tokens: 0, ayas: 0, trigrams: 0, fourgrams: 0, fivegrams: 0, ingest_version: null, detector_version: '0.1.0' });
    api.quran.list.mockResolvedValue([]);
    render(<QuranPanel book={book} />);
    expect(await screen.findByText(/Qurʾān unavailable: quran.db could not be unpacked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detect quotations' })).toBeDisabled();
  });
});
