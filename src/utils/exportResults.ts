import type { SearchFilters, SearchResult, SearchResults } from '../types';
import type { SearchContext } from '../types/search';
import type { SearchAPI, NameSearchForm } from '../api';
import { PAGE_SIZE, EXPORT_MAX_RESULTS } from '../constants/search';

/** One page of the search the tab ran, at `offset` with at most `limit` rows. */
export type PageFetcher = (limit: number, offset: number) => Promise<SearchResults>;

export interface ExportProgress {
  /** Rows collected so far. */
  done: number;
  /** Rows the export will end at: min(total_hits, max), or `max` while the count is still a lower bound. */
  total: number;
}

export interface CollectOptions {
  /** Upper bound on exported rows (default EXPORT_MAX_RESULTS). */
  max?: number;
  /** Rows requested per page (default PAGE_SIZE, the engine's max_limit on both hosts). */
  pageSize?: number;
  onProgress?: (p: ExportProgress) => void;
}

/**
 * Collect up to `max` rows by paging through the same search the tab ran.
 *
 * Since 0.5.0 both hosts clamp `limit` to max_limit (250), so a single
 * request with limit=2000 silently returns 250 rows. This walks
 * offset = 0, pageSize, 2·pageSize … until:
 *  - `max` rows are collected, or
 *  - a page returns fewer rows than requested (nothing more to fetch), or
 *  - `total_hits` is exact (not `was_capped`) and has been reached.
 * A capped count (the walk stopped at 20,000, or is still running) is only a
 * lower bound, so it never ends the loop early; the page size does.
 */
export async function collectExportRows(fetchPage: PageFetcher, opts: CollectOptions = {}): Promise<SearchResult[]> {
  const max = opts.max ?? EXPORT_MAX_RESULTS;
  const pageSize = Math.max(1, opts.pageSize ?? PAGE_SIZE);
  const rows: SearchResult[] = [];
  let known: number | null = null; // exact total once a page reports one
  const total = () => (known === null ? max : Math.min(known, max));
  opts.onProgress?.({ done: 0, total: total() });

  while (rows.length < max) {
    const want = Math.min(pageSize, max - rows.length);
    const page = await fetchPage(want, rows.length);
    const got = page.results.slice(0, max - rows.length);
    rows.push(...got);
    if (!page.was_capped) known = page.total_hits;
    opts.onProgress?.({ done: rows.length, total: total() });
    // Fewer than requested: the engine ran out (or clamped below `want`
    // and returned everything it had). Either way there is nothing after.
    if (page.results.length < want) break;
    if (known !== null && rows.length >= known) break;
  }
  return rows;
}

/** The fetcher for whatever search the tab ran, with the same filters. */
export function pageFetcherFor(api: SearchAPI, ctx: SearchContext, filters: SearchFilters): PageFetcher | null {
  if (ctx.type === 'name' && ctx.namePatterns) {
    const forms: NameSearchForm[] = ctx.namePatterns.map((patterns) => ({ patterns, expand: true }));
    return (limit, offset) => api.nameSearch(forms, filters, limit, offset);
  }
  if (ctx.type === 'proximity' && ctx.proximityQuery) {
    const q = ctx.proximityQuery;
    return (limit, offset) => api.proximitySearch(q.term1, q.field1, q.term2, q.field2, q.distance, filters, limit, offset);
  }
  if (ctx.type === 'combined' && ctx.combinedQuery) {
    const q = ctx.combinedQuery;
    return (limit, offset) => api.combinedSearch(q, filters, limit, offset);
  }
  if (ctx.type === 'wildcard' && ctx.wildcardQuery) {
    const q = ctx.wildcardQuery;
    return (limit, offset) => api.wildcardSearch(q, filters, limit, offset);
  }
  return null;
}
