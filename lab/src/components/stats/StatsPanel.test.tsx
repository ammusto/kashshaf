import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The Stats panel against a mocked bridge (spec §9, "Frontend"): each tab
 * renders its states, the scope it sends is the one the controls show, and a
 * concordance row clicks through with the hit's coordinates.
 */

// `vi.mock` factories are hoisted above every import and declaration, so the
// mocks they close over must be hoisted with them.
const api = vi.hoisted(() => ({
  statsLoadBook: vi.fn(),
  statsSections: vi.fn(),
  statsFrequencies: vi.fn(),
  statsConcordance: vi.fn(),
  statsKeyness: vi.fn(),
  statsDispersion: vi.fn(),
  statsNgrams: vi.fn(),
  statsCollocations: vi.fn(),
  statsCancel: vi.fn(),
  onStatsProgress: vi.fn(async () => () => {}),
  saveExport: vi.fn(async (name: string, _contents: string) => `C:/lab/exports/${name}`),
}));

vi.mock('../../api/lab', () => ({
  labApi: api,
  rustOk: (r: { Ok?: unknown }) => ('Ok' in r ? r.Ok : null),
  rustErr: (r: { Err?: string }) => ('Err' in r ? r.Err : null),
}));

import { StatsPanel, resetStatsMemory } from './StatsPanel';

const book: BookMetadata = { id: 42, title: 'صحيح البخاري', in_corpus: true };

const summary = { book_id: 42, pages: 3, tokens: 100, sections: 2, load_ms: 120, cached: false };
const sections = {
  sections: [
    { id: 1, parent: 0, depth: 0, title: 'كتاب الإيمان', page: 0, tok_start_on_page: 0, start: 0, end: 60, tokens: 60 },
    { id: 2, parent: 1, depth: 1, title: 'باب أول', page: 1, tok_start_on_page: 3, start: 20, end: 60, tokens: 40 },
  ],
  pages: [
    { index: 0, part_index: 0, page_id: 1, part_label: 'ج١', page_number: '1', tokens: 30 },
    { index: 1, part_index: 0, page_id: 2, part_label: 'ج١', page_number: '2', tokens: 40 },
    { index: 2, part_index: 0, page_id: 3, part_label: 'ج١', page_number: '3', tokens: 30 },
  ],
  longest: 1,
  shortest: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Per-book state is remembered across book switches (spec §7.1) in a
  // module-level map; tests share the module, so each starts clean.
  resetStatsMemory();
  api.statsLoadBook.mockResolvedValue(summary);
  api.statsSections.mockResolvedValue(sections);
  api.statsFrequencies.mockResolvedValue({
    list: {
      total: 100,
      distinct: 2,
      rows: [
        { key: 'قول', count: 30, per_million: 300000, corpus_count: null, corpus_rank: null, corpus_per_million: null },
        { key: 'رجل', count: 10, per_million: 100000, corpus_count: null, corpus_rank: null, corpus_per_million: null },
      ],
    },
    corpus_note: 'lemma_freq.bin is not in the corpus directory.',
  });
});

describe('StatsPanel', () => {
  it('asks for a book first', () => {
    render(<StatsPanel book={null} onShowHit={vi.fn()} />);
    expect(screen.getByText('Choose a book in Books first.')).toBeInTheDocument();
  });

  it('loads the book, shows the summary and the frequency list with its corpus note', async () => {
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    expect(await screen.findByTestId('stats-summary')).toHaveTextContent('100 tokens · 3 pages · 2 sections');
    expect(api.statsLoadBook).toHaveBeenCalledWith(42);
    // Frequencies is the default tab, lemma layer, stop words on.
    await waitFor(() => expect(api.statsFrequencies).toHaveBeenCalled());
    expect(api.statsFrequencies).toHaveBeenLastCalledWith({ book_id: 42, layer: 'lemma', stop: true, section: null });
    expect(await screen.findByTestId('freq-summary')).toHaveTextContent('2 distinct · 100 tokens');
    expect(screen.getByTestId('corpus-note')).toHaveTextContent('lemma_freq.bin is not in the corpus directory.');
    expect(screen.getByTestId('export-button')).toBeEnabled();
  });

  it('sends the layer, stop toggle and section the controls show', async () => {
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    await screen.findByTestId('freq-summary');
    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: 'root' } });
    await waitFor(() =>
      expect(api.statsFrequencies).toHaveBeenLastCalledWith({ book_id: 42, layer: 'root', stop: true, section: null })
    );
    fireEvent.click(screen.getByLabelText('Stop words off'));
    await waitFor(() =>
      expect(api.statsFrequencies).toHaveBeenLastCalledWith({ book_id: 42, layer: 'root', stop: false, section: null })
    );
    // Sections arrive from the bridge and scope every tab.
    await waitFor(() => expect(screen.getByLabelText('Section').querySelectorAll('option')).toHaveLength(3));
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: '2' } });
    await waitFor(() =>
      expect(api.statsFrequencies).toHaveBeenLastCalledWith({ book_id: 42, layer: 'root', stop: false, section: 2 })
    );
  });

  it('runs a concordance and clicks a hit through with its coordinates', async () => {
    api.statsConcordance.mockResolvedValue({
      total: 1,
      offset: 0,
      lines: [
        {
          page: 1,
          part_index: 0,
          page_id: 2,
          part_label: 'ج١',
          page_number: '2',
          tok_start: 5,
          tok_end: 6,
          global: 35,
          left: ['قال', 'الرجل'],
          node: ['الله'],
          right: ['في', 'الكتاب'],
        },
      ],
    });
    const onShowHit = vi.fn();
    render(<StatsPanel book={book} onShowHit={onShowHit} />);
    await screen.findByTestId('stats-summary');
    fireEvent.click(screen.getByRole('tab', { name: 'Concordance' }));
    fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'الله' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.statsConcordance).toHaveBeenCalled());
    expect(api.statsConcordance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { book_id: 42, layer: 'lemma', stop: true, section: null },
        query: 'الله',
        context: 8,
        sort: 'position',
        offset: 0,
      })
    );
    expect(await screen.findByTestId('conc-summary')).toHaveTextContent('1 hits');
    fireEvent.click(screen.getByText('الله'));
    expect(onShowHit).toHaveBeenCalledWith({ part_index: 0, page_id: 2, tok_start: 5, tok_end: 6 });
  });

  it('shows a keyness error in place rather than an empty table', async () => {
    api.statsKeyness.mockRejectedValue(
      'online, a reference set is fetched book by book under the server\'s bulk limits; this one has 40 books and the limit is 8.'
    );
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    await screen.findByTestId('stats-summary');
    fireEvent.click(screen.getByRole('tab', { name: 'Keyness' }));
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'genre' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the limit is 8');
    expect(api.statsKeyness).toHaveBeenLastCalledWith({
      scope: { book_id: 42, layer: 'lemma', stop: true, section: null },
      reference: { kind: 'genre' },
      min_freq: 3,
      min_bic: 2,
    });
  });

  it('plots dispersion with DP figures and a strip', async () => {
    api.statsDispersion.mockResolvedValue({
      dispersion: { key: 'قول', occurrences: 2, total: 100, dp: 0.25, dp_norm: 0.3333, per_page: [1, 1, 0], positions: [{ page: 0, idx: 3 }, { page: 1, idx: 7 }] },
      pages: sections.pages,
      by_section: [[sections.sections[0], 2], [sections.sections[1], 1]],
    });
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    await screen.findByTestId('stats-summary');
    fireEvent.click(screen.getByRole('tab', { name: 'Dispersion' }));
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'قول' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plot' }));
    expect(await screen.findByTestId('disp-summary')).toHaveTextContent('2 occurrences · DP 0.250');
    expect(screen.getByTestId('disp-summary')).toHaveTextContent('0.333');
    expect(screen.getByTestId('strip-plot').querySelectorAll('button')).toHaveLength(2);
  });

  it('lists sections with longest and shortest', async () => {
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    await screen.findByTestId('stats-summary');
    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    expect(await screen.findByTestId('sec-summary')).toHaveTextContent('2 sections · longest 60 tokens');
    expect(screen.getByTestId('sec-summary')).toHaveTextContent('shortest 40');
  });

  it('exports the current table through the bridge', async () => {
    render(<StatsPanel book={book} onShowHit={vi.fn()} />);
    await screen.findByTestId('freq-summary');
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(api.saveExport).toHaveBeenCalled());
    const [name, contents] = api.saveExport.mock.calls[0] as [string, string];
    expect(name).toBe('book42-frequencies-lemma.csv');
    expect(contents.startsWith('﻿')).toBe(true);
    expect(contents).toContain('قول,30,300000');
    expect(await screen.findByText(/Saved to C:\/lab\/exports/)).toBeInTheDocument();
  });
});
