/**
 * Offline API Implementation
 *
 * Uses Tauri commands to access local corpus data.
 */

import type { SearchAPI, CombinedSearchQuery, SearchTerm, NameSearchForm } from './index';
import type {
  SearchMode,
  SearchFilters,
  SearchResults,
  BookMetadata,
  SearchResult,
  Token,
} from '../types';
import * as tauri from './tauri';

/**
 * Offline API implementation using Tauri commands
 */
export class OfflineAPI implements SearchAPI {
  async search(
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    return tauri.search(query, mode, filters, limit, offset);
  }

  async combinedSearch(
    combined: CombinedSearchQuery,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    // Convert to the format expected by tauri.combinedSearch
    return tauri.combinedSearch(combined, filters, limit, offset);
  }

  async proximitySearch(
    term1: string,
    field1: SearchMode,
    term2: string,
    field2: SearchMode,
    distance: number,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    // Convert SearchMode to TokenField for tauri API
    const tokenField1 = field1 as 'surface' | 'lemma' | 'root';
    const tokenField2 = field2 as 'surface' | 'lemma' | 'root';
    return tauri.proximitySearch(
      term1,
      tokenField1,
      term2,
      tokenField2,
      distance,
      filters,
      limit,
      offset
    );
  }

  async nameSearch(
    forms: NameSearchForm[],
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    return tauri.nameSearch(forms, filters, limit, offset);
  }

  async wildcardSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
    offset: number
  ): Promise<SearchResults> {
    return tauri.wildcardSearch(query, filters, limit, offset);
  }

  async getPage(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<SearchResult | null> {
    const result = await tauri.getPage(id, partIndex, pageId);
    return result;
  }

  async getPageTokens(
    id: number,
    partIndex: number,
    pageId: number
  ): Promise<Token[]> {
    return tauri.getPageTokens(id, partIndex, pageId);
  }

  async getMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    query: string,
    mode: SearchMode
  ): Promise<number[]> {
    return tauri.getMatchPositions(id, partIndex, pageId, query, mode);
  }

  async getMatchPositionsCombined(
    id: number,
    partIndex: number,
    pageId: number,
    terms: SearchTerm[]
  ): Promise<number[]> {
    return tauri.getMatchPositionsCombined(id, partIndex, pageId, terms);
  }

  async getNameMatchPositions(
    id: number,
    partIndex: number,
    pageId: number,
    patterns: string[]
  ): Promise<number[]> {
    return tauri.getNameMatchPositions(id, partIndex, pageId, patterns);
  }

  async getAllBooks(): Promise<BookMetadata[]> {
    return tauri.getAllBooks();
  }

  async getAuthors(): Promise<[number, string][]> {
    return tauri.getAuthors();
  }

  async getGenres(): Promise<[number, string][]> {
    return tauri.getGenres();
  }
}

// Singleton instance
let offlineAPIInstance: OfflineAPI | null = null;

export function getOfflineAPI(): OfflineAPI {
  if (!offlineAPIInstance) {
    offlineAPIInstance = new OfflineAPI();
  }
  return offlineAPIInstance;
}
