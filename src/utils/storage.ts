/**
 * Storage Abstraction Layer
 *
 * Provides unified storage API that works for both web and desktop:
 * - Web: Uses localStorage
 * - Desktop: Uses Tauri commands (SQLite via src/api/tauri.ts)
 */

import type { SearchHistoryEntry, SavedSearchEntry } from '../types';

// Check if we're in web mode
export const isWebTarget = import.meta.env.VITE_TARGET === 'web';

// ============ LocalStorage Keys ============
const STORAGE_KEYS = {
  SEARCH_HISTORY: 'kashshaf_search_history',
  SAVED_SEARCHES: 'kashshaf_saved_searches',
  APP_SETTINGS: 'kashshaf_app_settings',
  USER_SETTINGS: 'kashshaf_user_settings',
};

const MAX_HISTORY_ENTRIES = 100;

// ============ Web Storage Implementation ============

interface StoredSearchHistoryEntry extends Omit<SearchHistoryEntry, 'id'> {
  id: number;
}

interface StoredSavedSearchEntry extends Omit<SavedSearchEntry, 'id'> {
  id: number;
}

let historyIdCounter = Date.now();
let savedIdCounter = Date.now();

function getStoredHistory(): StoredSearchHistoryEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SEARCH_HISTORY);
    if (!stored) return [];
    const entries = JSON.parse(stored) as StoredSearchHistoryEntry[];
    // Update counter to be higher than any existing ID
    if (entries.length > 0) {
      historyIdCounter = Math.max(historyIdCounter, ...entries.map(e => e.id)) + 1;
    }
    return entries;
  } catch {
    return [];
  }
}

function setStoredHistory(entries: StoredSearchHistoryEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.SEARCH_HISTORY, JSON.stringify(entries));
}

function getStoredSavedSearches(): StoredSavedSearchEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SAVED_SEARCHES);
    if (!stored) return [];
    const entries = JSON.parse(stored) as StoredSavedSearchEntry[];
    // Update counter to be higher than any existing ID
    if (entries.length > 0) {
      savedIdCounter = Math.max(savedIdCounter, ...entries.map(e => e.id)) + 1;
    }
    return entries;
  } catch {
    return [];
  }
}

function setStoredSavedSearches(entries: StoredSavedSearchEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.SAVED_SEARCHES, JSON.stringify(entries));
}

function getStoredSettings(key: string): Record<string, string> {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return {};
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

function setStoredSettings(key: string, settings: Record<string, string>): void {
  localStorage.setItem(key, JSON.stringify(settings));
}

// ============ Web Storage Functions ============

export async function webAddToHistory(
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  const entries = getStoredHistory();
  const id = historyIdCounter++;

  // Check if saved
  const savedSearches = getStoredSavedSearches();
  const isSaved = savedSearches.some(s => s.query_data === queryData);

  const newEntry: StoredSearchHistoryEntry = {
    id,
    search_type: searchType as SearchHistoryEntry['search_type'],
    query_data: queryData,
    display_label: displayLabel,
    book_filter_count: bookFilterCount,
    book_ids: bookIds ?? undefined,
    created_at: new Date().toISOString(),
    is_saved: isSaved,
  };

  // Add to beginning and trim to max
  entries.unshift(newEntry);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.splice(MAX_HISTORY_ENTRIES);
  }

  setStoredHistory(entries);
  return id;
}

export async function webGetSearchHistory(limit?: number): Promise<SearchHistoryEntry[]> {
  const entries = getStoredHistory();
  const savedSearches = getStoredSavedSearches();

  // Update is_saved status
  const result = entries.map(e => ({
    ...e,
    is_saved: savedSearches.some(s => s.query_data === e.query_data),
  }));

  return limit ? result.slice(0, limit) : result;
}

export async function webClearHistory(): Promise<void> {
  setStoredHistory([]);
}

export async function webSaveSearch(
  historyId: number | null,
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  const searches = getStoredSavedSearches();

  // Check if already saved (prevent duplicates)
  const existing = searches.find(s => s.query_data === queryData);
  if (existing) {
    return existing.id;
  }

  const id = savedIdCounter++;
  const newEntry: StoredSavedSearchEntry = {
    id,
    history_id: historyId ?? undefined,
    search_type: searchType as SavedSearchEntry['search_type'],
    query_data: queryData,
    display_label: displayLabel,
    book_filter_count: bookFilterCount,
    book_ids: bookIds ?? undefined,
    created_at: new Date().toISOString(),
  };

  searches.unshift(newEntry);
  setStoredSavedSearches(searches);
  return id;
}

export async function webUnsaveSearch(id: number): Promise<void> {
  const searches = getStoredSavedSearches();
  const filtered = searches.filter(s => s.id !== id);
  setStoredSavedSearches(filtered);
}

export async function webUnsaveSearchByQuery(queryData: string): Promise<void> {
  const searches = getStoredSavedSearches();
  const filtered = searches.filter(s => s.query_data !== queryData);
  setStoredSavedSearches(filtered);
}

export async function webIsSearchSaved(queryData: string): Promise<boolean> {
  const searches = getStoredSavedSearches();
  return searches.some(s => s.query_data === queryData);
}

export async function webGetSavedSearches(limit?: number): Promise<SavedSearchEntry[]> {
  const searches = getStoredSavedSearches();
  return limit ? searches.slice(0, limit) : searches;
}

export async function webGetAppSetting(key: string): Promise<string | null> {
  const settings = getStoredSettings(STORAGE_KEYS.APP_SETTINGS);
  return settings[key] ?? null;
}

export async function webSetAppSetting(key: string, value: string): Promise<void> {
  const settings = getStoredSettings(STORAGE_KEYS.APP_SETTINGS);
  settings[key] = value;
  setStoredSettings(STORAGE_KEYS.APP_SETTINGS, settings);
}

export async function webGetUserSetting(key: string): Promise<string | null> {
  const settings = getStoredSettings(STORAGE_KEYS.USER_SETTINGS);
  return settings[key] ?? null;
}

export async function webSetUserSetting(key: string, value: string): Promise<void> {
  const settings = getStoredSettings(STORAGE_KEYS.USER_SETTINGS);
  settings[key] = value;
  setStoredSettings(STORAGE_KEYS.USER_SETTINGS, settings);
}

// ============ Unified Storage API ============

// Dynamically import desktop functions only when not in web mode
let desktopStorage: typeof import('../api/tauri') | null = null;

async function getDesktopStorage() {
  if (!desktopStorage && !isWebTarget) {
    desktopStorage = await import('../api/tauri');
  }
  return desktopStorage;
}

// Unified API that routes to the appropriate implementation

export async function addToHistory(
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  if (isWebTarget) {
    return webAddToHistory(searchType, queryData, displayLabel, bookFilterCount, bookIds);
  }
  const desktop = await getDesktopStorage();
  return desktop!.addToHistory(searchType, queryData, displayLabel, bookFilterCount, bookIds);
}

export async function getSearchHistory(limit?: number): Promise<SearchHistoryEntry[]> {
  if (isWebTarget) {
    return webGetSearchHistory(limit);
  }
  const desktop = await getDesktopStorage();
  return desktop!.getSearchHistory(limit);
}

export async function clearHistory(): Promise<void> {
  if (isWebTarget) {
    return webClearHistory();
  }
  const desktop = await getDesktopStorage();
  return desktop!.clearHistory();
}

export async function saveSearch(
  historyId: number | null,
  searchType: string,
  queryData: string,
  displayLabel: string,
  bookFilterCount: number,
  bookIds: string | null
): Promise<number> {
  if (isWebTarget) {
    return webSaveSearch(historyId, searchType, queryData, displayLabel, bookFilterCount, bookIds);
  }
  const desktop = await getDesktopStorage();
  return desktop!.saveSearch(historyId, searchType, queryData, displayLabel, bookFilterCount, bookIds);
}

export async function unsaveSearch(id: number): Promise<void> {
  if (isWebTarget) {
    return webUnsaveSearch(id);
  }
  const desktop = await getDesktopStorage();
  return desktop!.unsaveSearch(id);
}

export async function unsaveSearchByQuery(queryData: string): Promise<void> {
  if (isWebTarget) {
    return webUnsaveSearchByQuery(queryData);
  }
  const desktop = await getDesktopStorage();
  return desktop!.unsaveSearchByQuery(queryData);
}

export async function isSearchSaved(queryData: string): Promise<boolean> {
  if (isWebTarget) {
    return webIsSearchSaved(queryData);
  }
  const desktop = await getDesktopStorage();
  return desktop!.isSearchSaved(queryData);
}

export async function getSavedSearches(limit?: number): Promise<SavedSearchEntry[]> {
  if (isWebTarget) {
    return webGetSavedSearches(limit);
  }
  const desktop = await getDesktopStorage();
  return desktop!.getSavedSearches(limit);
}

export async function getAppSetting(key: string): Promise<string | null> {
  if (isWebTarget) {
    return webGetAppSetting(key);
  }
  const desktop = await getDesktopStorage();
  return desktop!.getAppSetting(key);
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  if (isWebTarget) {
    return webSetAppSetting(key, value);
  }
  const desktop = await getDesktopStorage();
  return desktop!.setAppSetting(key, value);
}

export async function getUserSetting(key: string): Promise<string | null> {
  if (isWebTarget) {
    return webGetUserSetting(key);
  }
  const desktop = await getDesktopStorage();
  return desktop!.getUserSetting(key);
}

export async function setUserSetting(key: string, value: string): Promise<void> {
  if (isWebTarget) {
    return webSetUserSetting(key, value);
  }
  const desktop = await getDesktopStorage();
  return desktop!.setUserSetting(key, value);
}
