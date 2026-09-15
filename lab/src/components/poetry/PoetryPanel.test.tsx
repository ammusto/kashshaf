import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The poetry panel against a mocked bridge (spec §4.6): the scan button
 * drives `poetry_scan`; rows show the meter (unknown where not scanned —
 * never a guess), the hemistichs and the page; the filter hides; a row
 * click opens the reader at the verse with both hemistichs layered; export
 * goes through the backend with the rows.
 */

const api = vi.hoisted(() => {
  const poetry = {
    scan: vi.fn(),
    export: vi.fn(async () => 'C:/lab/exports/book527-poetry.csv'),
    onProgress: vi.fn(async () => () => {}),
  };
  const lab = {
    listPageRefs: vi.fn(),
    listPages: vi.fn(async (): Promise<unknown[]> => []),
    runSize: vi.fn(async () => ({ book_id: 0, pages: 1, book_pages: 1, tokens: 10, book_tokens: 10 })),
    statsPause: vi.fn(async () => {}),
    getPage: vi.fn(),
    statsCancel: vi.fn(),
  };
  return { poetry, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));
vi.mock('../../api/phase4', async () => {
  const real = await vi.importActual<typeof import('../../api/phase4')>('../../api/phase4');
  return { ...real, poetryApi: api.poetry };
});

import { PoetryPanel } from './PoetryPanel';
import type { VerseRow } from '../../api/phase4';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };
const words = 'قال الشاعر قفا نبك من ذكرى حبيب ومنزل ۞ بسقط اللوى بين الدخول فحومل';
const page = {
  book_id: 527,
  part_index: 0,
  page_id: 12,
  part_label: 'ج١',
  page_number: '12',
  body: words,
  tokens: words.split(' ').map((w, i) => ({ idx: i, surface: w, lemma: w, root: null, pos: 'noun', features: [], clitics: [] })),
};

const verse = (over: Partial<VerseRow> = {}): VerseRow => ({
  part_index: 0,
  page_id: 12,
  line: 0,
  tok_start: 2,
  tok_end: 14,
  h1: [2, 8],
  h2: [9, 14],
  h1_text: 'قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ',
  h2_text: 'بِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ',
  marker: '۞',
  vowelled: 0.95,
  meters: ['الطويل'],
  pattern: '//o/o//o/o/o//o/o//o//o',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.lab.listPageRefs.mockResolvedValue([{ book_id: 527, part_index: 0, page_id: 12 }]);
  api.lab.getPage.mockResolvedValue(page);
});

describe('PoetryPanel', () => {
  it('asks for a text first', () => {
    render(<PoetryPanel book={null} />);
    expect(screen.getByText(/Open a text from the workspace/)).toBeInTheDocument();
  });

  it('scans, lists verses with meter / unknown, filters, layers the reader, and exports', async () => {
    const rows = [verse(), verse({ line: 3, tok_start: 20, tok_end: 30, h1: [20, 25], h2: [26, 30], h1_text: 'وهذا شطر بلا تشكيل', h2_text: 'وشطر ثان بلا تشكيل', marker: 'whitespace', vowelled: 0.1, meters: [], pattern: '' })];
    api.poetry.scan.mockResolvedValue({ book_id: 527, pages: 553, pages_done: 553, verses: rows, with_meter: 1, vowelled: 1, elapsed_ms: 80, cancelled: false, extractor_version: '0.1.0' });
    render(<PoetryPanel book={book} />);
    expect(screen.getByText('experimental')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Find verses' }));
    await waitFor(() => expect(api.poetry.scan).toHaveBeenCalledWith(527));
    const table = await screen.findByTestId('poetry-table');
    await waitFor(() => expect(table).toHaveTextContent('الطويل'));
    expect(table).toHaveTextContent('unknown');
    expect(table).toHaveTextContent('قِفَا نَبْكِ');
    expect(table).toHaveTextContent('whitespace');
    expect(screen.getByRole('status')).toHaveTextContent('2 verses · 1 vowelled · 1 with a meter');
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'metered' } });
    await waitFor(() => expect(screen.getByText('1/2 verses')).toBeInTheDocument());
    // The verse on the shown page is layered: first hemistich, then second.
    await waitFor(() => expect(document.querySelector('[data-token="3"]')?.className).toContain('lay-verse-h1'));
    expect(document.querySelector('[data-token="10"]')?.className).toContain('lay-verse-h2');
    expect(document.querySelector('[data-token="0"]')?.className).not.toMatch(/lay-verse/);
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(api.poetry.export).toHaveBeenCalledWith(527, rows));
  });
});
