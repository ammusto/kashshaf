import type { SearchResults, Token } from './index';

// Search context stored per tab for load-more and export
export interface SearchContext {
  type: 'combined' | 'proximity' | 'name' | 'wildcard';
  combinedQuery?: CombinedSearchQuery;
  proximityQuery?: ProximitySearchQuery;
  namePatterns?: string[][];
  displayPatterns?: string[][];
  wildcardQuery?: string;
}

// Current page data for reader panel
export interface PageData {
  bookId: number;
  meta: string;
  body: string;
  loadTimeMs?: number;
}

// Complete state for a single search tab
export interface SearchTab {
  id: string;
  label: string;
  fullQuery: string;
  tabType: 'terms' | 'names';

  // Results state
  searchResults: SearchResults | null;
  loading: boolean;
  loadingMore: boolean;
  errorMessage: string;

  // Reader state
  currentPage: PageData | null;
  pageTokens: Token[];
  matchedTokenIndices: number[];
  currentBookId: number | null;
  currentPartIndex: number;
  currentPageId: number;

  // Search context for load-more/export
  searchContext: SearchContext;
}

// App-level search mode
export type AppSearchMode = 'terms' | 'names';

// Re-export types used by SearchContext
export interface CombinedSearchQuery {
  andInputs: SearchInput[];
  orInputs: SearchInput[];
}

export type SearchInputMode = 'surface' | 'lemma' | 'root';

export interface SearchInput {
  id: number;
  query: string;
  mode: SearchInputMode;
  cliticToggle: boolean;
}

export interface ProximitySearchQuery {
  term1: string;
  field1: 'surface' | 'lemma' | 'root';
  term2: string;
  field2: 'surface' | 'lemma' | 'root';
  distance: number;
}
