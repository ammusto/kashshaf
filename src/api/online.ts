/**
 * Online API Implementation
 *
 * Uses HTTP fetch to access the Kashshaf API server.
 * Base URL: https://api.kashshaf.com
 */

import type { SearchAPI, CombinedSearchQuery, SearchTerm, NameSearchForm } from './index';
import type {
  SearchMode,
  SearchFilters,
  SearchResults,
  BookMetadata,
  SearchResult,
  Token,
  EngineCapabilities,
  WildcardGrammar,
  WalkStatus,
  PageEntry,
  TocNode,
} from '../types';
import { stripPunctuation } from '@kashshaf/shared';
import { getApiBaseUrl } from '../utils/platform';
import { noteRateLimited, retryAfterMs, waitIfThrottled } from './rateLimit';
import type { PageBundle, PageBundleRequest } from './index';

// VITE_API_URL at build time points a web build at another server, as the
// rate-limit test does with a local API.
const API_BASE_URL = getApiBaseUrl();

// Proclitics for clitic expansion in surface mode
const PROCLITICS = ['و', 'ف', 'ب', 'ل', 'ك'];

function expandWithClitics(query: string): string[] {
  const sanitized = stripPunctuation(query);
  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [sanitized];

  if (words.length === 1) {
    const word = words[0];
    return [word, ...PROCLITICS.map(p => p + word)];
  }

  const [first, ...rest] = words;
  const restJoined = rest.join(' ');
  const base = words.join(' ');
  return [base, ...PROCLITICS.map(p => `${p}${first} ${restJoined}`)];
}

/** How many times a rate-limited request is sent again before giving up. */
const RATE_LIMIT_RETRIES = 3;

/**
 * One API request.
 *
 * A GET carries no Content-Type: with one, the browser sends a preflight
 * OPTIONS first, which doubles the requests a scroll makes and counts
 * against the same rate limit. A 429 is waited out for as long as
 * `Retry-After` says (every other request holds back too, see rateLimit.ts)
 * and sent again, up to three times; only then is it an error.
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const hasBody = options.body !== undefined && options.body !== null;
  const init: RequestInit = {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  };
  for (let attempt = 0; ; attempt++) {
    await waitIfThrottled();
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      noteRateLimited(retryAfterMs(response.headers.get('Retry-After')));
      continue;
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    return response.json();
  }
}

/**
 * Build query string from filters
 */
function buildBookIdsParam(filters: SearchFilters): string {
  if (filters.book_ids && filters.book_ids.length > 0) {
    return filters.book_ids.join(',');
  }
  return '';
}

/**
 * Online API implementation using HTTP fetch
 */
export class OnlineAPI implements SearchAPI {
  async search(
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    const sanitizedQuery = stripPunctuation(query);
    const params = new URLSearchParams({
      q: sanitizedQuery,
      mode,
      limit: String(limit),
      offset: String(offset),
    });

    const bookIds = buildBookIdsParam(filters);
    if (bookIds) {
      params.set('book_ids', bookIds);
    }

    return fetchAPI<SearchResults>(`/search?${params}`);
  }

  async combinedSearch(
    combined: CombinedSearchQuery,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    // Process inputs similar to the offline implementation
    const andTerms: Array<{ query: string; mode: string }> = [];
    const orTerms: Array<{ query: string; mode: string }> = [];

    for (const inp of combined.andInputs) {
      if (inp.mode === 'surface' && inp.cliticToggle) {
        // expandWithClitics already sanitizes
        for (const variant of expandWithClitics(inp.query)) {
          orTerms.push({ query: variant, mode: 'surface' });
        }
      } else {
        andTerms.push({ query: stripPunctuation(inp.query), mode: inp.mode });
      }
    }

    for (const inp of combined.orInputs) {
      if (inp.mode === 'surface' && inp.cliticToggle) {
        // expandWithClitics already sanitizes
        for (const variant of expandWithClitics(inp.query)) {
          orTerms.push({ query: variant, mode: 'surface' });
        }
      } else {
        orTerms.push({ query: stripPunctuation(inp.query), mode: inp.mode });
      }
    }

    return fetchAPI<SearchResults>('/search/combined', {
      method: 'POST',
      body: JSON.stringify({
        and_terms: andTerms,
        or_terms: orTerms,
        filters: {
          book_ids: filters.book_ids || [],
        },
        limit,
        offset,
      }),
    });
  }

  async getVariants(
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
  ): Promise<import('./index').VariantsResponse> {
    return fetchAPI('/search/variants', {
      method: 'POST',
      body: JSON.stringify({
        query: stripPunctuation(query),
        mode,
        filters: {
          book_ids: filters.book_ids || [],
        },
      }),
    });
  }

  async proximitySearch(
    term1: string,
    field1: SearchMode,
    term2: string,
    field2: SearchMode,
    distance: number,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    const sanitizedTerm1 = stripPunctuation(term1);
    const sanitizedTerm2 = stripPunctuation(term2);
    return fetchAPI<SearchResults>('/search/proximity', {
      method: 'POST',
      body: JSON.stringify({
        term1: { query: sanitizedTerm1, mode: field1 },
        term2: { query: sanitizedTerm2, mode: field2 },
        distance,
        filters: {
          book_ids: filters.book_ids || [],
        },
        limit,
        offset,
      }),
    });
  }

  async nameSearch(
    forms: NameSearchForm[],
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    return fetchAPI<SearchResults>('/search/name', {
      method: 'POST',
      body: JSON.stringify({
        forms,
        filters: {
          book_ids: filters.book_ids || [],
        },
        limit,
        offset,
      }),
    });
  }

  async wildcardSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    const sanitizedQuery = stripPunctuation(query);
    const params = new URLSearchParams({
      q: sanitizedQuery,
      limit: String(limit),
      offset: String(offset),
    });

    const bookIds = buildBookIdsParam(filters);
    if (bookIds) {
      params.set('book_ids', bookIds);
    }

    return fetchAPI<SearchResults>(`/search/wildcard?${params}`);
  }

  async getWalkStatus(key: string): Promise<WalkStatus | null> {
    try {
      return await fetchAPI<WalkStatus>(`/search/status?key=${encodeURIComponent(key)}`);
    } catch {
      return null;
    }
  }

  async getCapabilities(): Promise<EngineCapabilities> {
    const health = await fetchAPI<{
      wildcard_grammar?: WildcardGrammar;
      exact_counts?: boolean;
      max_verified_hits?: number;
    }>('/health');
    return {
      wildcard_grammar: health.wildcard_grammar ?? 'legacy',
      exact_counts: false,
      max_verified_hits: health.max_verified_hits ?? 20000,
    };
  }

  async getPage(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<SearchResult | null> {
    const params = new URLSearchParams({
      id: String(id),
      part_index: String(partIndex),
      page_id: String(pageId),
    });

    try {
      return await fetchAPI<SearchResult>(`/page?${params}`);
    } catch {
      return null;
    }
  }

  async listBookPages(id: number): Promise<PageEntry[]> {
    return fetchAPI<PageEntry[]>(`/book/${id}/pages`);
  }

  /**
   * One request per page: `/page` with `include=tokens` and the search's
   * terms (`q`/`mode` pairs, or `name` patterns). A server from before
   * 0.6.0 ignores those and answers with the bare page, which is told
   * apart by its shape; then the tokens and highlights are fetched the old
   * way, so the web client still reads against the previous API.
   */
  async getPageBundle(
    id: number,
    partIndex: number,
    pageId: number,
    request: PageBundleRequest
  ): Promise<PageBundle | null> {
    const params = new URLSearchParams({
      id: String(id),
      part_index: String(partIndex),
      page_id: String(pageId),
    });
    if (request.tokens) params.set('include', 'tokens');
    for (const t of request.terms ?? []) {
      params.append('q', t.query);
      params.append('mode', t.mode);
    }
    for (const n of request.namePatterns ?? []) params.append('name', n);

    let raw: unknown;
    try {
      raw = await fetchAPI<unknown>(`/page?${params}`);
    } catch {
      return null;
    }
    if (raw === null || raw === undefined) return null;
    const asBundle = raw as Partial<PageBundle>;
    if (asBundle.page) {
      return {
        page: asBundle.page,
        tokens: asBundle.tokens ?? [],
        matches: asBundle.matches ?? null,
        continues_prev: asBundle.continues_prev ?? false,
        continues_next: asBundle.continues_next ?? false,
      };
    }
    // A bare page: the server predates the bundle.
    const page = raw as SearchResult;
    const [tokens, matches] = await Promise.all([
      request.tokens ? this.getPageTokens(id, partIndex, pageId) : Promise.resolve([] as Token[]),
      request.namePatterns && request.namePatterns.length > 0
        ? this.getNameMatchPositions(id, partIndex, pageId, request.namePatterns)
        : request.terms && request.terms.length > 0
          ? this.getMatchPositionsCombined(id, partIndex, pageId, request.terms)
          : Promise.resolve(null),
    ]);
    return { page, tokens, matches, continues_prev: false, continues_next: false };
  }

  /**
   * A 404 is "this server cannot serve a table of contents" — the route is
   * absent before API 0.5.2, and a server whose corpus has no toc.db
   * answers 404 too — which the pane reports as such rather than as an
   * error. Anything else is an error.
   */
  async getBookToc(id: number): Promise<TocNode[] | null> {
    const res = await fetch(`${API_BASE_URL}/book/${id}/toc`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Table of contents: HTTP ${res.status}`);
    return (await res.json()) as TocNode[];
  }

  async getPageByLabel(
    id: number,
    partLabel: string,
    pageNumber: string
  ): Promise<SearchResult | null> {
    const params = new URLSearchParams({
      id: String(id),
      part_label: partLabel,
      page_number: pageNumber,
    });

    try {
      return await fetchAPI<SearchResult>(`/page/by-label?${params}`);
    } catch {
      return null;
    }
  }

  async getPageTokens(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<Token[]> {
    const params = new URLSearchParams({
      id: String(id),
      part_index: String(partIndex),
      page_id: String(pageId),
    });

    return fetchAPI<Token[]>(`/page/tokens?${params}`);
  }

  async getMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    query: string,
    mode: SearchMode
  ): Promise<number[]> {
    const params = new URLSearchParams({
      id: String(id),
      part_index: String(partIndex),
      page_id: String(pageId),
      q: query,
      mode,
    });

    return fetchAPI<number[]>(`/page/matches?${params}`);
  }

  async getMatchPositionsCombined(
    id: number,
    partIndex: number,
    pageId: number,
    terms: SearchTerm[]
  ): Promise<number[]> {
    // For online mode, we need to make multiple calls and combine results
    // since the API doesn't have a combined endpoint for match positions
    const allPositions = new Set<number>();

    for (const term of terms) {
      const positions = await this.getMatchPositions(
        id,
        partIndex,
        pageId,
        term.query,
        term.mode
      );
      positions.forEach(p => allPositions.add(p));
    }

    return Array.from(allPositions).sort((a, b) => a - b);
  }

  async getNameMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    patterns: string[]
  ): Promise<number[]> {
    // For online mode, search for each pattern and combine positions
    const allPositions = new Set<number>();

    for (const pattern of patterns) {
      const positions = await this.getMatchPositions(
        id,
        partIndex,
        pageId,
        pattern,
        'surface'
      );
      positions.forEach(p => allPositions.add(p));
    }

    return Array.from(allPositions).sort((a, b) => a - b);
  }

  async getAllBooks(): Promise<BookMetadata[]> {
    return fetchAPI<BookMetadata[]>('/books');
  }

  async getAuthors(): Promise<[number, string][]> {
    return fetchAPI<[number, string][]>('/authors');
  }

  async getGenres(): Promise<[number, string][]> {
    return fetchAPI<[number, string][]>('/genres');
  }
}

// Singleton instance
let onlineAPIInstance: OnlineAPI | null = null;

export function getOnlineAPI(): OnlineAPI {
  if (!onlineAPIInstance) {
    onlineAPIInstance = new OnlineAPI();
  }
  return onlineAPIInstance;
}
