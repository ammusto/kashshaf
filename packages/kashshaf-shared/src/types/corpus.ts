/**
 * Corpus types shared by the Kashshaf and Kashshaf Lab frontends.
 *
 * These are the TypeScript mirrors of Rust types that both backends return:
 * `Token`/`TokenClitic` and `SearchResult` from `kashshaf-engine`,
 * `BookMetadata` from `metadata.db`, and `CorpusStatus`/`DownloadProgress`
 * from `kashshaf-common`. Changing one without the other breaks the bridge in
 * whichever app was not updated, so they live in one place
 * (dev-docs/KASHSHAF_LAB_SPEC.md §2.2).
 */

// ---------------------------------------------------------------- tokens ---

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

// ---------------------------------------------------------------- search ---

export interface SearchResult {
  id: number;
  part_index: number;
  page_id: number;
  author_id?: number;
  genre_id?: number;
  death_ah?: number;
  century_ah?: number;
  part_label: string;
  page_number: string;
  /** Full body text - only present from get_page, not search results */
  body?: string;
  score: number;
  /** Token indices that matched the search query (positions in the token array) */
  matched_token_indices: number[];
}

// ----------------------------------------------------------------- books ---

export interface BookMetadata {
  id: number;
  corpus?: string;
  title: string;
  author_id?: number;
  death_ah?: number;
  century_ah?: number;
  genre_id?: number;
  page_count?: number;
  token_count?: number;
  original_id?: string;
  paginated?: boolean;
  tags?: string;       // JSON array as string
  book_meta?: string;  // JSON array as string
  author_meta?: string; // JSON array as string (legacy)
  in_corpus?: boolean; // Whether book is in the corpus
  parts?: number;      // Number of parts/volumes in the book
  metadata_json?: string;  // Structured metadata blob (replaces book_meta for display)
  citation_json?: string;  // Structured citation data for MLA/Chicago formatting
}

// ---------------------------------------------------------------- corpus ---

export interface CorpusStatus {
  ready: boolean;
  local_version: string | null;
  remote_version: string | null;
  update_available: boolean;
  update_required: boolean;
  missing_files: string[];
  total_download_size: number;
  /** The remote manifest's `notes` (what changed in remote_version), if any. */
  remote_notes: string | null;
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
