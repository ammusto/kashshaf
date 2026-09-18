import type { SearchResults } from './index';

// Search context stored per tab for load-more and export
export interface SearchContext {
  type: 'combined' | 'proximity' | 'name' | 'wildcard';
  combinedQuery?: CombinedSearchQuery;
  proximityQuery?: ProximitySearchQuery;
  namePatterns?: string[][];
  displayPatterns?: string[][];
  wildcardQuery?: string;
}

/** Highlights a search returned for one page, with that page's coordinates. */
export interface ClickedMatches {
  part_index: number;
  page_id: number;
  indices: number[];
}

/**
 * Where the reader is in this tab: the page in view, as the header and the
 * citation describe it. The page's text and tokens are not here — the reader
 * holds a window of pages of its own (`usePageStack`), and a tab that keeps
 * bodies would hold a copy of every page its user ever scrolled past.
 */
export interface PageData {
  bookId: number;
  /** `part_label:page_number` of the page in view. */
  meta: string;
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
  /** The clicked result's own highlights, and the page they belong to. The
   *  reader looks every other page up as it scrolls into view. */
  clickedMatches: ClickedMatches | null;
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
