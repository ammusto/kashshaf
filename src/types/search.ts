import type { SearchResults, Token, SearchMode } from './index';

// Search context stored per tab for load-more and export
export interface SearchContext {
  type: 'combined' | 'proximity' | 'name' | 'concordance' | 'wildcard';
  combinedQuery?: CombinedSearchQuery;
  proximityQuery?: ProximitySearchQuery;
  namePatterns?: string[][];
  displayPatterns?: string[][];
  concordanceQuery?: string;
  concordanceMode?: SearchMode;
  concordanceIgnoreClitics?: boolean;
  wildcardQuery?: string;
}

// Current page data for reader panel
export interface PageData {
  title: string;
  author: string;
  meta: string;
  body: string;
  loadTimeMs?: number;
}

// Complete state for a single search tab
export interface SearchTab {
  id: string;
  label: string;
  fullQuery: string;
  tabType: 'terms' | 'names' | 'concordance';

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
export type AppSearchMode = 'terms' | 'names' | 'concordance';

// Re-export types used by SearchContext
export interface CombinedSearchQuery {
  andInputs: SearchInput[];
  orInputs: SearchInput[];
}

export interface SearchInput {
  id: number;
  query: string;
  mode: SearchMode;
  cliticToggle: boolean;
}

export interface ProximitySearchQuery {
  term1: string;
  field1: 'surface' | 'lemma' | 'root';
  term2: string;
  field2: 'surface' | 'lemma' | 'root';
  distance: number;
}
