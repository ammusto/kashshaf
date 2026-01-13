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
} from '../types';
import { stripPunctuation } from '../utils/sanitize';

const API_BASE_URL = 'https://api.kashshaf.com';

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

/**
 * Helper to make API requests with error handling
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json();
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
