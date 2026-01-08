// Search types
export type SearchMode = 'surface' | 'lemma' | 'root';

export type TokenField = 'surface' | 'lemma' | 'root';

export interface SearchFilters {
  author_id?: number;
  author?: string;
  genre?: string;
  corpus?: string;
  death_ah_min?: number;
  death_ah_max?: number;
  century_ah?: number;
  book_ids?: number[];
}

export interface SearchResult {
  id: number;
  part_index: number;
  page_id: number;
  author_id?: number;
  corpus: string;
  author: string;
  title: string;
  death_ah?: number;
  century_ah?: number;
  genre?: string;
  part_label: string;
  page_number: string;
  /** Full body text - only present from get_page, not search results */
  body?: string;
  score: number;
  /** Token indices that matched the search query (positions in the token array) */
  matched_token_indices: number[];
}

export interface SearchResults {
  query: string;
  mode: SearchMode;
  total_hits: number;
  results: SearchResult[];
  elapsed_ms: number;
}

// Combined page content with match positions (from single Tantivy query)
export interface PageWithMatches {
  title: string;
  author: string;
  part_label: string;
  page_number: string;
  body: string;
  matched_token_indices: number[];
}

// Token types
export interface TokenClitic {
  type: string;
  display: string;
}

export interface Token {
  idx: number;
  surface: string;
  noclitic_surface?: string; // Surface without wa/fa/bi/li/ka proclitics
  lemma: string;
  root?: string;
  pos: string;
  features: string[];
  clitics: TokenClitic[];
}

// Book metadata types (from corpus.db)
export interface BookMetadata {
  id: number;
  corpus?: string;
  title: string;
  author_id?: number;
  author?: string;
  death_ah?: number;
  century_ah?: number;
  genre?: string;
  page_count?: number;
  token_count?: number;
  // Additional metadata from JSON files
  original_id?: string;
  date?: string;
  paginated?: boolean;
  tags?: string;       // JSON array as string
  book_meta?: string;  // JSON array as string
  author_meta?: string; // JSON array as string
}

// Stats
export interface AppStats {
  indexed_pages: number;
  total_books: number;
  token_cache_size: number;
  token_cache_capacity: number;
}

// Search History Entry (auto-saved)
export interface SearchHistoryEntry {
  id: number;
  search_type: 'boolean' | 'proximity' | 'name' | 'wildcard' | 'concordance';
  query_data: string;  // JSON string
  display_label: string;
  book_filter_count: number;
  book_ids?: string;   // JSON array of book IDs as string
  created_at: string;  // ISO timestamp
  is_saved: boolean;   // Whether this search is also saved
}

// Saved Search Entry (user explicitly saved)
export interface SavedSearchEntry {
  id: number;
  history_id?: number;
  search_type: 'boolean' | 'proximity' | 'name' | 'wildcard' | 'concordance';
  query_data: string;  // JSON string
  display_label: string;
  book_filter_count: number;
  book_ids?: string;   // JSON array of book IDs as string
  created_at: string;  // ISO timestamp
}

// App Update Status
export interface AppUpdateStatus {
  current_version: string;
  latest_version: string;
  min_supported_version: string;
  update_required: boolean;
  update_available: boolean;
  release_notes?: string;
  download_url?: string;
}

// Corpus Download Types
export interface CorpusStatus {
  ready: boolean;
  local_version: string | null;
  remote_version: string | null;
  update_available: boolean;
  update_required: boolean;
  missing_files: string[];
  total_download_size: number;
  error: string | null;
}

export type DownloadState =
  | 'starting'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadProgress {
  current_file: string;
  file_bytes_downloaded: number;
  file_total_bytes: number;
  overall_bytes_downloaded: number;
  overall_total_bytes: number;
  files_completed: number;
  files_total: number;
  state: DownloadState;
}

