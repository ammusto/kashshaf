export interface Author {
  id: number;
  name: string;
  death_date: number;
  birth_date?: number;
  au_id?: number;
  au_ar?: string;
  au_sh_ar?: string;
  au_lat?: string;
  au_sh_lat?: string;
  au_death?: number;
}
// Text type
export interface Text {
  id: number;
  title: string;
  title_lat?: string;
  au_id: number;
  tags: string[];
  volumes: number;
}

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
export interface SearchResult {
  id: string;
  text_id: number;
  vol: string;
  page_num: number;
  page_id: number;
  text_title?: string;
  author_name?: string;
  death_date?: number | null;
  title_lat?: string | null;
  author_lat?: string | null;
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
  exact?: boolean;
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
  _score: number;
  highlight?: {
    'page_content.proclitic'?: string[];
    'page_content'?: string[];
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
  isExactSearch: boolean;
  textsMetadata: Map<number, Text>;
  authorsMetadata: Map<number, Author>;
}