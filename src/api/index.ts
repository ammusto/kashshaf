/**
 * API Abstraction Layer
 *
 * This module provides a unified interface for accessing Kashshaf data
 * that works in both online and offline modes.
 */

import type {
  SearchMode,
  SearchFilters,
  SearchResults,
  BookMetadata,
  SearchResult,
  Token,
  EngineCapabilities,
  WalkStatus,
  PageEntry,
  TocNode,
} from '../types';
import type { NameSearchForm } from './tauri';

/**
 * Operating mode for the application
 */
export type OperatingMode = 'online' | 'offline' | 'pending';

/**
 * Search term with query and mode
 */
/** What `getPageBundle` should include besides the page. */
export interface PageBundleRequest {
  tokens: boolean;
  /** The running search's terms, for the highlights; none when no search runs. */
  terms?: SearchTerm[];
  /**
   * A name search's *displayed* patterns instead of terms (`اب* منصور`, no
   * proclitics): the server expands them with the search's own rule, so the
   * request stays short and the highlights are the search's.
   */
  namePatterns?: string[];
}

export interface PageBundle {
  page: SearchResult;
  tokens: Token[];
  /** Token indices to highlight, or null when nothing was asked for. */
  matches: number[] | null;
  /** A match runs in from the page before / out onto the page after (corpus 4.3.0). */
  continues_prev: boolean;
  continues_next: boolean;
}

export interface SearchTerm {
  query: string;
  mode: SearchMode;
}

/**
 * Combined search query with AND/OR logic
 */
export interface CombinedSearchInput {
  id: number;
  query: string;
  mode: SearchMode;
  cliticToggle: boolean;
}

export interface CombinedSearchQuery {
  andInputs: CombinedSearchInput[];
  orInputs: CombinedSearchInput[];
}

/**
 * Distribution of surface forms that match a lemma or root query.
 * Returned by SearchAPI.getVariants.
 */
export interface Variant {
  surface_tuple: string[];
  freq: number;
}

export interface VariantsResponse {
  variants: Variant[];
  total_hits: number;
  scanned_hits: number;
  was_sampled: boolean;
  elapsed_ms: number;
}

/**
 * Unified Search API interface
 * Both offline (Tauri) and online (HTTP) implementations use this interface
 */
export interface SearchAPI {
  // Search operations
  search(
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults>;

  combinedSearch(
    combined: CombinedSearchQuery,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults>;

  /** Distribution of surface forms matching a lemma/root query. Errors on surface mode. */
  getVariants(
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
  ): Promise<VariantsResponse>;

  proximitySearch(
    term1: string,
    field1: SearchMode,
    term2: string,
    field2: SearchMode,
    distance: number,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults>;

  nameSearch(
    forms: NameSearchForm[],
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults>;

  wildcardSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults>;

  // Page operations
  getPage(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<SearchResult | null>;

  getPageByLabel(
    id: number,
    partLabel: string,
    pageNumber: string
  ): Promise<SearchResult | null>;

  /**
   * Every page of one book in reading order, with its printed labels: the
   * spine the reader scrolls through. One call per book, not per page —
   * `page_id + 1` is not the next page in the 45 books whose page ids
   * restart per part.
   */
  listBookPages(id: number): Promise<PageEntry[]>;

  /**
   * The book's table of contents, or `null` when this source cannot serve
   * one: a corpus without `toc.db` (before 4.2.0), or a server without the
   * route (before 0.5.2). A book with no headings is `[]`.
   */
  getBookToc(id: number): Promise<TocNode[] | null>;

  getPageTokens(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<Token[]>;

  /**
   * A page, its tokens and its highlights in one call: what the reader
   * fetches for every page it shows. Online this is one request (`/page`
   * with `include=tokens` and the terms); on the desktop, three local
   * calls. `null` when there is no such page.
   */
  getPageBundle(
    id: number,
    partIndex: number,
    pageId: number,
    request: PageBundleRequest
  ): Promise<PageBundle | null>;

  /**
   * A page, its tokens and its highlights in one call: what the reader
   * fetches for every page it shows. Online this is one request (`/page`
   * with `include=tokens` and the terms); on the desktop, three local
   * calls. `null` when there is no such page.
   */
  getPageBundle(
    id: number,
    partIndex: number,
    pageId: number,
    request: PageBundleRequest
  ): Promise<PageBundle | null>;

  getMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    query: string,
    mode: SearchMode
  ): Promise<number[]>;

  getMatchPositionsCombined(
    id: number,
    partIndex: number,
    pageId: number,
    terms: SearchTerm[]
  ): Promise<number[]>;

  /**
   * `expand`: the patterns are the displayed ones and the server expands
   * them (the app's case); off, they are sent as they are.
   */
  getNameMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    patterns: string[],
    expand?: boolean
  ): Promise<number[]>;

  /** Wildcard grammar, exact-counts state and walk cap of the engine behind this API. */
  getCapabilities(): Promise<EngineCapabilities>;

  /** Progress of a walk-backed search; null once the walk has left the cache. */
  getWalkStatus(key: string): Promise<WalkStatus | null>;

  // Metadata operations
  getAllBooks(): Promise<BookMetadata[]>;
  getAuthors(): Promise<[number, string][]>;
  getGenres(): Promise<[number, string][]>;
}

// Re-export for convenience
export type { NameSearchForm };
