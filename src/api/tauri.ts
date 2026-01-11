import { invoke } from '@tauri-apps/api/core';
import type {
  SearchMode,
  SearchFilters,
  SearchResults,
  BookMetadata,
  SearchResult,
  Token,
  TokenField,
  AppStats,
  PageWithMatches,
  SearchHistoryEntry,
  SavedSearchEntry,
  AppUpdateStatus,
  CorpusStatus,
} from '../types';
import { stripPunctuation } from '../utils/sanitize';

export async function search(
  query: string,
  mode?: SearchMode,
  filters?: SearchFilters,
  limit?: number,
  offset?: number
): Promise<SearchResults> {
  const sanitizedQuery = stripPunctuation(query);
  return invoke('search', { query: sanitizedQuery, mode, filters, limit, offset });
}

export async function getPage(
  id: number,
  partIndex: number,
  pageId: number
): Promise<SearchResult | null> {
  return invoke('get_page', { id, partIndex, pageId });
}

/** Load all book metadata at once - for caching in frontend */
export async function getAllBooks(): Promise<BookMetadata[]> {
  return invoke('get_all_books');
}

export async function listBooks(
  genreId?: number,
  corpus?: string,
  centuryAh?: number,
  limit?: number,
  offset?: number
): Promise<BookMetadata[]> {
  return invoke('list_books', { genreId, corpus, centuryAh, limit, offset });
}

export async function getBook(id: number): Promise<BookMetadata | null> {
  return invoke('get_book', { id });
}

export interface ListBooksFilteredParams {
  deathAhMin?: number;
  deathAhMax?: number;
  genreIds?: number[];
  limit?: number;
  offset?: number;
}

export async function listBooksFiltered(params: ListBooksFilteredParams = {}): Promise<BookMetadata[]> {
  return invoke('list_books_filtered', { ...params });
}

/** Search authors by name. Returns [author_id, author_name, earliest_death_ah, book_count] */
export async function searchAuthors(query: string): Promise<[number, string, number, number][]> {
  return invoke('search_authors', { query });
}

/** Get all genres. Returns [genre_id, genre_name] */
export async function getGenres(): Promise<[number, string][]> {
  return invoke('get_genres');
}

/** Get all authors. Returns [author_id, author_name] */
export async function getAuthors(): Promise<[number, string][]> {
  return invoke('get_authors');
}

export async function getCenturies(): Promise<[number, number][]> {
  return invoke('get_centuries');
}

export async function getStats(): Promise<AppStats> {
  return invoke('get_stats');
}

export async function proximitySearch(
  term1: string,
  field1: TokenField,
  term2: string,
  field2: TokenField,
  distance: number,
  filters?: SearchFilters,
  limit?: number,
  offset?: number
): Promise<SearchResults> {
  const sanitizedTerm1 = stripPunctuation(term1);
  const sanitizedTerm2 = stripPunctuation(term2);
  return invoke('proximity_search', { term1: sanitizedTerm1, field1, term2: sanitizedTerm2, field2, distance, filters, limit, offset });
}

export async function getPageTokens(
  id: number,
  partIndex: number,
  pageId: number
): Promise<Token[]> {
  return invoke('get_page_tokens', { id, partIndex, pageId });
}

export async function getTokenAt(
  id: number,
  partIndex: number,
  pageId: number,
  idx: number
): Promise<Token | null> {
  return invoke('get_token_at', { id, partIndex, pageId, idx });
}

export async function getCacheStats(): Promise<[number, number]> {
  return invoke('get_cache_stats');
}

export async function clearTokenCache(): Promise<void> {
  return invoke('clear_token_cache');
}

export async function getMatchPositions(
  id: number,
  partIndex: number,
  pageId: number,
  query: string,
  mode: SearchMode
): Promise<number[]> {
  return invoke('get_match_positions', { id, partIndex, pageId, query, mode });
}

export interface SearchTermForPositions {
  query: string;
  mode: SearchMode;
}

export async function getMatchPositionsCombined(
  id: number,
  partIndex: number,
  pageId: number,
  terms: SearchTermForPositions[]
): Promise<number[]> {
  return invoke('get_match_positions_combined', { id, partIndex, pageId, terms });
}

export async function getPageWithMatches(
  id: number,
  partIndex: number,
  pageId: number,
  query: string,
  mode: SearchMode
): Promise<PageWithMatches | null> {
  return invoke('get_page_with_matches', { id, partIndex, pageId, query, mode });
}

export interface SearchInput {
  id: number;
  query: string;
  mode: SearchMode;
  cliticToggle: boolean;
}

export interface CombinedSearchQuery {
  andInputs: SearchInput[];
  orInputs: SearchInput[];
}

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

export async function combinedSearch(
  combined: CombinedSearchQuery,
  filters: SearchFilters,
  limit: number,
  offset: number
): Promise<SearchResults> {
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

  return invoke('combined_search', { andTerms, orTerms, filters, limit, offset });
}

/**
 * Name search - search for Arabic personal names using pattern matching
 */
export interface NameSearchForm {
  patterns: string[];  // All generated patterns for this name (after proclitic expansion)
}

export async function nameSearch(
  forms: NameSearchForm[],
  filters: SearchFilters,
  limit: number,
  offset: number
): Promise<SearchResults> {
  return invoke('name_search', { forms, filters, limit, offset });
}

/**
 * Get token positions that match any of the given patterns on a specific page
 * Used for highlighting name search results
 */
export async function getNameMatchPositions(
  id: number,
  partIndex: number,
  pageId: number,
  patterns: string[]
): Promise<number[]> {
  return invoke('get_name_match_positions', { id, partIndex, pageId, patterns });
}

/**
 * Wildcard search - search for Arabic text with * wildcards
 * Only works in Surface mode
 * Rules:
 * - One * per search input
 * - * cannot be at start of word
 * - Internal * requires 2+ chars before it
 */
export async function wildcardSearch(
  query: string,
  filters: SearchFilters,
  limit: number,
  offset: number
): Promise<SearchResults> {
  const sanitizedQuery = stripPunctuation(query);
  return invoke('wildcard_search', { query: sanitizedQuery, filters, limit, offset });
}

/**
 * Show the app menu popup at a specific position
 * @param x - X coordinate relative to window's top-left corner (physical pixels)
 * @param y - Y coordinate relative to window's top-left corner (physical pixels)
 */
export async function showAppMenu(x: number, y: number): Promise<string> {
  return invoke('show_app_menu', { x, y });
}

// ============ Search History ============

/**
 * Add a search to history (auto-saved, rotates at 100 entries)
 */
export async function addToHistory(
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  return invoke('add_to_history', { searchType, queryData, displayLabel, bookFilterCount, bookIds });
}

/**
 * Get search history, ordered by created_at DESC
 */
export async function getSearchHistory(limit?: number): Promise<SearchHistoryEntry[]> {
  return invoke('get_search_history', { limit });
}

/**
 * Clear all search history
 */
export async function clearHistory(): Promise<void> {
  return invoke('clear_history');
}

// ============ Saved Searches ============

/**
 * Save a search (user explicitly saved, prevents duplicates)
 */
export async function saveSearch(
  historyId: number | null,
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  return invoke('save_search', { historyId, searchType, queryData, displayLabel, bookFilterCount, bookIds });
}

/**
 * Remove a saved search by ID
 */
export async function unsaveSearch(id: number): Promise<void> {
  return invoke('unsave_search', { id });
}

/**
 * Remove a saved search by query_data
 */
export async function unsaveSearchByQuery(queryData: string): Promise<void> {
  return invoke('unsave_search_by_query', { queryData });
}

/**
 * Check if a search is saved
 */
export async function isSearchSaved(queryData: string): Promise<boolean> {
  return invoke('is_search_saved', { queryData });
}

/**
 * Get saved searches, ordered by created_at DESC
 */
export async function getSavedSearches(limit?: number): Promise<SavedSearchEntry[]> {
  return invoke('get_saved_searches', { limit });
}

// ============ App Settings ============

/**
 * Get an app setting by key
 */
export async function getAppSetting(key: string): Promise<string | null> {
  return invoke('get_app_setting', { key });
}

/**
 * Set an app setting
 */
export async function setAppSetting(key: string, value: string): Promise<void> {
  return invoke('set_app_setting', { key, value });
}

// ============ App Update ============

/**
 * Check for app updates
 */
export async function checkAppUpdate(): Promise<AppUpdateStatus> {
  return invoke('check_app_update');
}

// ============ Corpus Download API ============

/**
 * Check corpus status - whether data is ready, update available, etc.
 */
export async function checkCorpusStatus(): Promise<CorpusStatus> {
  return invoke('check_corpus_status');
}

/**
 * Start corpus download - emits "download-progress" events
 * @param skipVerify - If true, skip SHA256 hash verification (faster but less safe)
 */
export async function startCorpusDownload(skipVerify: boolean = false): Promise<void> {
  return invoke('start_corpus_download', { skipVerify });
}

/**
 * Cancel ongoing corpus download
 */
export async function cancelCorpusDownload(): Promise<void> {
  return invoke('cancel_corpus_download');
}

/**
 * Get the application data directory path
 */
export async function getDataDirectory(): Promise<string> {
  return invoke('get_data_directory');
}

/**
 * Archive old corpus before update
 */
export async function archiveOldCorpus(version: string): Promise<string> {
  return invoke('archive_old_corpus', { version });
}

/**
 * Reload AppState after download completes
 */
export async function reloadAppState(): Promise<boolean> {
  return invoke('reload_app_state');
}

// ============ User Settings API ============

/**
 * Get a user setting by key
 * Can be called before corpus is downloaded
 */
export async function getUserSetting(key: string): Promise<string | null> {
  return invoke('get_user_setting', { key });
}

/**
 * Set a user setting
 * Can be called before corpus is downloaded
 */
export async function setUserSetting(key: string, value: string): Promise<void> {
  return invoke('set_user_setting', { key, value });
}

/**
 * Check if corpus files exist (tantivy_index + corpus.db)
 */
export async function corpusExists(): Promise<boolean> {
  return invoke('corpus_exists');
}

/**
 * Delete local corpus data (corpus.db, tantivy_index, manifest.local.json)
 * Preserves settings.db (search history, saved searches, user preferences)
 * Returns the number of items deleted
 */
export async function deleteLocalData(): Promise<number> {
  return invoke('delete_local_data');
}

// ============ Announcements API ============

/**
 * Announcements manifest returned from Tauri command
 * Note: The 'type' field is renamed to 'announcement_type' in Rust for serde
 */
interface TauriAnnouncementsManifest {
  schema_version: number;
  announcements: TauriAnnouncement[];
}

interface TauriAnnouncement {
  id: string;
  title: string;
  body: string;
  body_format: string;
  announcement_type: string; // Renamed from 'type' in Rust
  priority: string;
  target: string;
  min_app_version: string | null;
  max_app_version: string | null;
  starts_at: string;
  expires_at: string | null;
  dismissible: boolean;
  show_once: boolean;
  action: { label: string; url: string } | null;
}

/**
 * Fetch announcements from CDN via Tauri (uses reqwest, no CORS)
 * Returns the manifest with announcements array
 */
export async function fetchAnnouncements(): Promise<TauriAnnouncementsManifest> {
  return invoke('fetch_announcements');
}

// ============ Collections API ============

import type { Collection } from '../types/collections';

/**
 * Create a new collection
 */
export async function createCollection(
  name: string,
  bookIds: number[],
  description?: string
): Promise<Collection> {
  return invoke('create_collection', { name, bookIds, description });
}

/**
 * Get all collections
 */
export async function getCollections(): Promise<Collection[]> {
  return invoke('get_collections');
}

/**
 * Update collection's book IDs
 */
export async function updateCollectionBooks(id: number, bookIds: number[]): Promise<void> {
  return invoke('update_collection_books', { id, bookIds });
}

/**
 * Update collection's description
 */
export async function updateCollectionDescription(id: number, description: string | null): Promise<void> {
  return invoke('update_collection_description', { id, description });
}

/**
 * Rename a collection
 */
export async function renameCollection(id: number, name: string): Promise<void> {
  return invoke('rename_collection', { id, name });
}

/**
 * Delete a collection
 */
export async function deleteCollection(id: number): Promise<void> {
  return invoke('delete_collection', { id });
}
