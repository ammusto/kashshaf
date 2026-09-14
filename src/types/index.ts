/**
 * Kashshaf frontend types.
 *
 * The types both frontends need — Token, SearchResult, BookMetadata,
 * CorpusStatus and the download progress they share — live in
 * `@kashshaf/shared` (Lab spec §2.2) and are re-exported here so existing
 * imports from `../types` keep working.
 */
import type { SearchResult } from '@kashshaf/shared';

export type {
  Token,
  TokenClitic,
  SearchResult,
  BookMetadata,
  CorpusStatus,
  DownloadState,
  DownloadProgress,
} from '@kashshaf/shared';

// Search types
export type SearchMode = 'surface' | 'lemma' | 'root';

export type TokenField = 'surface' | 'lemma' | 'root';

export interface SearchFilters {
  author_id?: number;
  genre_id?: number;
  death_ah_min?: number;
  death_ah_max?: number;
  century_ah?: number;
  book_ids?: number[];
}

export interface SearchResults {
  query: string;
  mode: SearchMode;
  total_hits: number;
  results: SearchResult[];
  elapsed_ms: number;
  /**
   * True when total_hits is a lower bound: the verified walk stopped at the
   * hit cap (20,000) or its time budget, or is still running. Shown as `+`
   * after the count.
   */
  was_capped?: boolean;
  /** Frontend-only: a load-more returned no rows, so nothing more can be fetched. */
  loadedAll?: boolean;
  /** Walk-backed results: key for getWalkStatus while `complete` is false. */
  walk_key?: string;
  /** Walk-backed results: the walk had finished when this page was served. */
  complete?: boolean;
}

/** Progress of a walk-backed search (Tauri get_walk_status, API /search/status). */
export interface WalkStatus {
  verified_hits: number;
  was_capped: boolean;
  complete: boolean;
  incomplete: boolean;
}

/** Which wildcard grammar the engine validates with (see utils/wildcardValidation.ts). */
export type WildcardGrammar = 'glob' | 'legacy';

/** What the engine reports about itself (Tauri `get_capabilities`, API `/health`). */
export interface EngineCapabilities {
  wildcard_grammar: WildcardGrammar;
  /** Walks run to completion with exact counts (desktop setting; always false online). */
  exact_counts: boolean;
  /** Verified hits after which a capped walk stops. */
  max_verified_hits: number;
}

// Combined page content with match positions (from single Tantivy query)
export interface PageWithMatches {
  id: number;
  part_label: string;
  page_number: string;
  body: string;
  matched_token_indices: number[];
}

// Author lookup table
export interface Author {
  id: number;
  name: string;
}

// Genre lookup table
export interface Genre {
  id: number;
  name: string;
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
  search_type: 'boolean' | 'proximity' | 'name' | 'wildcard';
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
  search_type: 'boolean' | 'proximity' | 'name' | 'wildcard';
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

/** Where the corpus lives: `get_data_directory_info` (Tauri). */
export interface DataDirInfo {
  path: string;
  /** portable = <exe>/data; user = %APPDATA%\Kashshaf etc.; dev = debug build search */
  source: 'portable' | 'user' | 'dev';
  writable: boolean;
  free_bytes: number;
  total_bytes: number;
  required_bytes: number | null;
  margin_bytes: number;
  /** free_bytes >= required_bytes + margin_bytes, when required_bytes was given */
  enough_space: boolean | null;
}

// Re-export announcement types
export type {
  TargetPlatform,
  AnnouncementType,
  AnnouncementPriority,
  AnnouncementBodyFormat,
  AnnouncementAction,
  Announcement,
  AnnouncementsManifest,
  DismissedAnnouncement,
  AnnouncementsCache,
} from './announcements';

