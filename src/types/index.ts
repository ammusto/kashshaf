// Author type
export interface Author {
  id: number;
  name: string;
  death_date: number;
  birth_date?: number;
}

// Text type
export interface Text {
  id: number;
  title: string;
  au_id: number;
  tags: string[];
  volumes: number;
}

// Document type (based on your JSON samples)
export interface TextDocument {
  text_id: number;
  uri: string;
  vol: string;
  collection: string;
  page_id: number;
  page_num: number;
  page_content: string;
  token_roots: string;
}

// Search result with highlighting
// Search result with highlighting
export interface SearchResult {
  id: string;
  text_id: number;
  vol: string;
  page_num: number;
  page_id: number;
  text_title?: string;
  author_name?: string;
  // Add death_date field
  death_date?: number | null;
  // Optional additional fields
  title_lat?: string | null;
  author_lat?: string | null;
  // Add uri field
  uri?: string;
  highlights: {
    pre: string;
    match: string;
    post: string;
  }[];
  score: number;
}
// Filter state
export interface FilterState {
  genres: string[];
  authors: number[];
  deathDateRange: {
    min: number;
    max: number;
  };
}

// Search parameters for URL
export interface SearchParams {
  query: string;
  page: number;
  rows: number;
  filters: FilterState;
}

// OpenSearch inner hit
interface OpenSearchInnerHit {
  highlight?: {
    page_content: string[];
  };
}

// OpenSearch hit
interface OpenSearchHit {
  _id: string;
  _source: TextDocument;
  highlight?: {
    page_content: string[];
  };
  inner_hits?: {
    page_matches?: {
      hits: {
        hits: OpenSearchInnerHit[];
      };
    };
  };
}

// OpenSearch response type
export interface OpenSearchResponse {
  took: number;
  timed_out: boolean;
  hits: {
    total: {
      value: number;
    };
    hits: OpenSearchHit[];
  };
}

// App state context
export interface AppState {
  searchQuery: string;
  results: SearchResult[];
  isLoading: boolean;
  totalResults: number;
  currentPage: number;
  rowsPerPage: number;
  filters: FilterState;
  textsMetadata: Map<number, Text>;
  authorsMetadata: Map<number, Author>;
}