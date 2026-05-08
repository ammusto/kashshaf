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
} from '../types';
import type { NameSearchForm } from './tauri';

/**
 * Operating mode for the application
 */
export type OperatingMode = 'online' | 'offline' | 'pending';

/**
 * Search term with query and mode
 */
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

  getPageTokens(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<Token[]>;

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

  getNameMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    patterns: string[]
  ): Promise<number[]>;

  // Metadata operations
  getAllBooks(): Promise<BookMetadata[]>;
  getAuthors(): Promise<[number, string][]>;
  getGenres(): Promise<[number, string][]>;
}

// Re-export for convenience
export type { NameSearchForm };
