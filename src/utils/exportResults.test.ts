import { describe, it, expect, vi } from 'vitest';
import type { SearchResult, SearchResults, SearchFilters } from '../types';
import type { SearchAPI } from '../api';
import { collectExportRows, pageFetcherFor } from './exportResults';

function row(i: number): SearchResult {
  return { id: 1, part_index: 0, page_id: i, title: 't', author: 'a', part_label: '1', page_number: String(i), score: 0, matched_token_indices: [] } as unknown as SearchResult;
}

/** A server holding `totalRows` hits that clamps every request to `maxLimit`. */
function server(totalRows: number, maxLimit: number, opts: { capped?: boolean; reportedTotal?: number } = {}) {
  const calls: Array<[number, number]> = [];
  const fetchPage = vi.fn(async (limit: number, offset: number): Promise<SearchResults> => {
    calls.push([limit, offset]);
    const n = Math.min(limit, maxLimit);
    const results = Array.from({ length: Math.max(0, Math.min(n, totalRows - offset)) }, (_, k) => row(offset + k));
    return { query: 'q', mode: 'surface', total_hits: opts.reportedTotal ?? totalRows, results, elapsed_ms: 1, was_capped: opts.capped };
  });
  return { fetchPage, calls };
}

describe('collectExportRows', () => {
  it('collects three pages of 250 into 750 rows when the engine clamps to 250', async () => {
    const s = server(750, 250);
    const rows = await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250 });
    expect(rows).toHaveLength(750);
    expect(rows.map((r) => r.page_id)).toEqual(Array.from({ length: 750 }, (_, i) => i));
    // 3 full pages, then the exact total (750) stops the loop: no fourth call.
    expect(s.calls).toEqual([[250, 0], [250, 250], [250, 500]]);
  });

  it('stops at exactly 2,000 rows when max_limit is 250 and total_hits is 2,300', async () => {
    const s = server(2300, 250);
    const progress: number[] = [];
    const rows = await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250, onProgress: (p) => progress.push(p.done) });
    expect(rows).toHaveLength(2000);
    expect(rows[1999].page_id).toBe(1999);
    expect(s.calls).toHaveLength(8);
    expect(s.calls[7]).toEqual([250, 1750]);
    expect(progress).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
  });

  it('a single oversized request would have been truncated: the old behaviour', async () => {
    const s = server(2300, 250);
    const one = await s.fetchPage(2000, 0);
    expect(one.results).toHaveLength(250);
  });

  it('a capped count is only a lower bound: keeps paging until a short page', async () => {
    // Walk stopped at 20,000 verified hits; the engine really has 2,300 rows to serve.
    const s = server(2300, 250, { capped: true, reportedTotal: 20000 });
    const rows = await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250 });
    expect(rows).toHaveLength(2000);
  });

  it('a capped count below max does not end the export early', async () => {
    // total_hits=300 reported while the walk was still running; 900 rows actually exist.
    const s = server(900, 250, { capped: true, reportedTotal: 300 });
    const rows = await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250 });
    expect(rows).toHaveLength(900);
  });

  it('exact total below max: stops at total_hits and reports it as the progress total', async () => {
    const s = server(120, 250);
    const totals: number[] = [];
    const rows = await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250, onProgress: (p) => totals.push(p.total) });
    expect(rows).toHaveLength(120);
    expect(s.calls).toEqual([[250, 0]]);
    expect(totals).toEqual([2000, 120]);
  });

  it('empty result set', async () => {
    const s = server(0, 250);
    expect(await collectExportRows(s.fetchPage, { max: 2000, pageSize: 250 })).toEqual([]);
  });
});

describe('pageFetcherFor', () => {
  const filters = { book_ids: [3] } as unknown as SearchFilters;
  const api = {
    nameSearch: vi.fn(async () => ({}) as SearchResults),
    proximitySearch: vi.fn(async () => ({}) as SearchResults),
    combinedSearch: vi.fn(async () => ({}) as SearchResults),
    wildcardSearch: vi.fn(async () => ({}) as SearchResults),
  } as unknown as SearchAPI;

  it('routes each tab kind to the method the tab used, with the same filters', async () => {
    await pageFetcherFor(api, { type: 'wildcard', wildcardQuery: 'ابن ال*' }, filters)!(250, 500);
    expect(api.wildcardSearch).toHaveBeenCalledWith('ابن ال*', filters, 250, 500);

    await pageFetcherFor(api, { type: 'name', namePatterns: [['ابو حامد']] }, filters)!(250, 0);
    expect(api.nameSearch).toHaveBeenCalledWith([{ patterns: ['ابو حامد'], expand: true }], filters, 250, 0);

    const proximityQuery = { term1: 'الله', field1: 'surface', term2: 'قال', field2: 'lemma', distance: 10 } as never;
    await pageFetcherFor(api, { type: 'proximity', proximityQuery }, filters)!(250, 250);
    expect(api.proximitySearch).toHaveBeenCalledWith('الله', 'surface', 'قال', 'lemma', 10, filters, 250, 250);

    const combinedQuery = { andInputs: [], orInputs: [] } as never;
    await pageFetcherFor(api, { type: 'combined', combinedQuery }, filters)!(250, 750);
    expect(api.combinedSearch).toHaveBeenCalledWith(combinedQuery, filters, 250, 750);
  });

  it('returns null for a context without its query', () => {
    expect(pageFetcherFor(api, { type: 'wildcard' }, filters)).toBeNull();
  });
});
