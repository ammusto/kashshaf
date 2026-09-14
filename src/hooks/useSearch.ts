import { useCallback } from 'react';
import type { SearchFilters, SearchResults, SearchResult } from '../types';
import type { SearchContext, AppSearchMode, CombinedSearchQuery, ProximitySearchQuery } from '../types/search';
import type { NameFormData } from '../utils/namePatterns';
import type { SearchAPI, NameSearchForm as NameSearchFormAPI } from '../api';
import { PAGE_SIZE, MAX_RESULTS, EXPORT_MAX_RESULTS } from '../constants/search';
import { collectExportRows, pageFetcherFor, type ExportProgress } from '../utils/exportResults';
import { addToHistory } from '../utils/storage';
import { useSearchTabsContext } from '../contexts/SearchTabsContext';
import { generateSearchPatterns, generateDisplayPatterns } from '../utils/namePatterns';

export interface UseSearchOptions {
  selectedBookIds: Set<number>;
  loadResultIntoTab: (tabId: string, result: SearchResult) => Promise<void>;
  /** The API instance to use for search operations */
  api: SearchAPI;
}

export interface UseSearchReturn {
  handleSearch: (combined: CombinedSearchQuery) => Promise<void>;
  handleProximitySearch: (query: ProximitySearchQuery) => Promise<void>;
  handleNameSearch: (nameFormData: NameFormData[]) => Promise<{ displayPatterns: string[][] }>;
  handleLoadMore: () => Promise<void>;
  /** Up to EXPORT_MAX_RESULTS rows of the active tab's search, paged; `onProgress` reports rows collected so far. */
  handleExportResults: (onProgress?: (p: ExportProgress) => void) => Promise<SearchResult[]>;
  handleResultClick: (result: SearchResult) => Promise<void>;
}

// Generate query label for tabs
function generateQueryLabel(query: CombinedSearchQuery): string {
  const andTerm = query.andInputs?.[0]?.query;
  const orTerm = query.orInputs?.[0]?.query;
  return andTerm || orTerm || 'Search';
}

function generateFullQuery(query: CombinedSearchQuery): string {
  const parts: string[] = [];
  if (query.andInputs?.length) {
    parts.push('AND: ' + query.andInputs.map(q => q.query).join(', '));
  }
  if (query.orInputs?.length) {
    parts.push('OR: ' + query.orInputs.map(q => q.query).join(', '));
  }
  return parts.join(' | ') || 'Search';
}

function generateBooleanDisplayLabel(query: CombinedSearchQuery): string {
  const andTerms = query.andInputs?.filter(i => i.query.trim()).map(i => i.query) || [];
  const orTerms = query.orInputs?.filter(i => i.query.trim()).map(i => i.query) || [];

  if (andTerms.length >= 2) {
    return `${andTerms[0]} AND ${andTerms[1]}`;
  } else if (andTerms.length === 1 && orTerms.length >= 1) {
    return `${andTerms[0]} AND ${orTerms[0]}`;
  } else if (andTerms.length === 1) {
    return andTerms[0];
  } else if (orTerms.length >= 2) {
    return `${orTerms[0]} OR ${orTerms[1]}`;
  } else if (orTerms.length === 1) {
    return orTerms[0];
  }
  return 'Search';
}

function generateProximityDisplayLabel(query: ProximitySearchQuery): string {
  return `${query.term1} ~${query.distance} ${query.term2}`;
}

function generateNameDisplayLabel(forms: NameFormData[]): string {
  const firstForm = forms[0];
  if (!firstForm) return 'Name Search';

  const parts: string[] = [];

  const firstKunya = firstForm.kunyas.find(k => k.trim());
  if (firstKunya) {
    parts.push(firstKunya.trim());
  }

  if (firstForm.nasab.trim()) {
    parts.push(firstForm.nasab.trim());
  }

  const firstNisba = firstForm.nisbas.find(n => n.trim());
  if (firstNisba) {
    parts.push(firstNisba.trim());
  }

  const fullLabel = parts.join(' ') || 'Name Search';

  if (fullLabel.length > 40) {
    return fullLabel.slice(0, 37) + '...';
  }

  return fullLabel;
}

export function useSearch(options: UseSearchOptions): UseSearchReturn {
  const { selectedBookIds, loadResultIntoTab, api } = options;
  const { activeTab, createTab: createTabFromContext, updateTab, updateTabWith } = useSearchTabsContext();

  // A walk-backed response that came back before its walk finished carries
  // `complete: false`. Poll the walk once after 500 ms and once more after a
  // further 2 s if it is still running, and update the header counts in
  // place; the rows are never re-rendered from a poll.
  const scheduleStatusPolls = useCallback((tabId: string, results: SearchResults) => {
    const key = results.walk_key;
    if (!key || results.complete !== false) return;
    const poll = async (): Promise<boolean> => {
      try {
        const status = await api.getWalkStatus(key);
        if (!status) return true;
        updateTabWith(tabId, tab => {
          const current = tab.searchResults;
          if (!current || current.walk_key !== key) return {};
          return {
            searchResults: {
              ...current,
              total_hits: Math.max(current.total_hits, status.verified_hits),
              was_capped: status.was_capped,
              complete: status.complete,
            },
          };
        });
        return status.complete;
      } catch (err) {
        console.warn('walk status poll failed:', err);
        return true;
      }
    };
    setTimeout(async () => {
      const done = await poll();
      if (!done) setTimeout(() => { poll(); }, 2000);
    }, 500);
  }, [api, updateTabWith]);

  // Wrapper to match the old createTab signature
  const createTab = useCallback((label: string, fullQuery: string, tabType: AppSearchMode, searchContext: SearchContext): string => {
    return createTabFromContext({ label, fullQuery, tabType, searchContext });
  }, [createTabFromContext]);

  // Helper to get filters from selectedBookIds
  const getFilters = useCallback((): SearchFilters => {
    return selectedBookIds.size > 0
      ? { book_ids: Array.from(selectedBookIds) }
      : {};
  }, [selectedBookIds]);

  // Add search to history (fire and forget)
  const addSearchToHistory = useCallback((
    searchType: 'boolean' | 'proximity' | 'name' | 'wildcard',
    queryData: object,
    displayLabel: string
  ) => {
    const bookIds = selectedBookIds.size > 0 ? Array.from(selectedBookIds) : null;
    const bookIdsJson = bookIds ? JSON.stringify(bookIds) : null;

    addToHistory(
      searchType,
      JSON.stringify(queryData),
      displayLabel,
      selectedBookIds.size,
      bookIdsJson
    ).catch(err => {
      console.error('Failed to add search to history:', err);
    });
  }, [selectedBookIds]);

  // Boolean/Combined search handler
  const handleSearch = useCallback(async (combined: CombinedSearchQuery) => {
    const label = generateQueryLabel(combined);
    const fullQuery = generateFullQuery(combined);

    // Check if any query contains a wildcard
    const allInputs = [...(combined.andInputs || []), ...(combined.orInputs || [])];
    const wildcardInput = allInputs.find(inp => inp.query.includes('*'));

    // If there's a wildcard query, use wildcard search
    if (wildcardInput && wildcardInput.mode === 'surface') {
      const searchContext: SearchContext = {
        type: 'wildcard',
        wildcardQuery: wildcardInput.query,
      };

      const tabId = createTab(label, fullQuery, 'terms', searchContext);

      try {
        const filters = getFilters();
        const results = await api.wildcardSearch(wildcardInput.query, filters, PAGE_SIZE, 0);
        updateTab(tabId, { searchResults: results, loading: false });
        scheduleStatusPolls(tabId, results);

        if (results.results.length > 0) {
          loadResultIntoTab(tabId, results.results[0]);
        }

        addSearchToHistory('boolean', { type: 'boolean', andInputs: combined.andInputs, orInputs: combined.orInputs }, wildcardInput.query);
      } catch (err) {
        updateTab(tabId, { errorMessage: `Search failed: ${err}`, loading: false });
        console.error('Wildcard search failed:', err);
      }
      return;
    }

    // Regular combined search
    const searchContext: SearchContext = {
      type: 'combined',
      combinedQuery: combined,
    };

    const tabId = createTab(label, fullQuery, 'terms', searchContext);

    try {
      const filters = getFilters();
      const results = await api.combinedSearch(combined, filters, PAGE_SIZE, 0);
      updateTab(tabId, { searchResults: results, loading: false });
      scheduleStatusPolls(tabId, results);

      if (results.results.length > 0) {
        loadResultIntoTab(tabId, results.results[0]);
      }

      const displayLabel = generateBooleanDisplayLabel(combined);
      addSearchToHistory('boolean', { type: 'boolean', andInputs: combined.andInputs, orInputs: combined.orInputs }, displayLabel);
    } catch (err) {
      updateTab(tabId, { errorMessage: `Search failed: ${err}`, loading: false });
      console.error('Search failed:', err);
    }
  }, [createTab, updateTab, getFilters, addSearchToHistory, loadResultIntoTab, api, scheduleStatusPolls]);

  // Proximity search handler
  const handleProximitySearch = useCallback(async (query: ProximitySearchQuery) => {
    const label = `${query.term1} ~ ${query.term2}`;
    const fullQuery = `${query.term1} NEAR/${query.distance} ${query.term2}`;
    const searchContext: SearchContext = {
      type: 'proximity',
      proximityQuery: query,
    };

    const tabId = createTab(label, fullQuery, 'terms', searchContext);

    try {
      const filters = getFilters();
      const results = await api.proximitySearch(
        query.term1,
        query.field1,
        query.term2,
        query.field2,
        query.distance,
        filters,
        PAGE_SIZE,
        0
      );

      updateTab(tabId, { searchResults: results, loading: false });
      scheduleStatusPolls(tabId, results);

      if (results.results.length > 0) {
        loadResultIntoTab(tabId, results.results[0]);
      }

      const displayLabel = generateProximityDisplayLabel(query);
      addSearchToHistory('proximity', {
        type: 'proximity',
        term1: query.term1,
        field1: query.field1,
        term2: query.term2,
        field2: query.field2,
        distance: query.distance
      }, displayLabel);
    } catch (err) {
      updateTab(tabId, { errorMessage: `Proximity search failed: ${err}`, loading: false });
      console.error('Proximity search failed:', err);
    }
  }, [createTab, updateTab, getFilters, addSearchToHistory, loadResultIntoTab, api, scheduleStatusPolls]);

  // Name search handler - returns displayPatterns so caller can update state
  const handleNameSearch = useCallback(async (nameFormData: NameFormData[]): Promise<{ displayPatterns: string[][] }> => {
    const searchPatterns = nameFormData.map(form => generateSearchPatterns(form));
    const displayPatterns = nameFormData.map(form => generateDisplayPatterns(form));

    const label = generateNameDisplayLabel(nameFormData);
    const fullQuery = displayPatterns.map(patterns => patterns.join(' | ')).join(' ; ');

    const searchContext: SearchContext = {
      type: 'name',
      namePatterns: searchPatterns,
      displayPatterns: displayPatterns,
    };

    const tabId = createTab(label, fullQuery, 'names', searchContext);

    try {
      const forms: NameSearchFormAPI[] = searchPatterns.map(patterns => ({ patterns }));
      const filters = getFilters();
      const results = await api.nameSearch(forms, filters, PAGE_SIZE, 0);
      updateTab(tabId, { searchResults: results, loading: false });
      scheduleStatusPolls(tabId, results);

      if (results.results.length > 0) {
        loadResultIntoTab(tabId, results.results[0]);
      }

      const displayLabel = generateNameDisplayLabel(nameFormData);
      addSearchToHistory('name', {
        type: 'name',
        forms: nameFormData
      }, displayLabel);
    } catch (err) {
      updateTab(tabId, { errorMessage: `Name search failed: ${err}`, loading: false });
      console.error('Name search failed:', err);
    }

    return { displayPatterns };
  }, [createTab, updateTab, getFilters, addSearchToHistory, loadResultIntoTab, api, scheduleStatusPolls]);

  // Load more results handler (works for all search types)
  const handleLoadMore = useCallback(async () => {
    if (!activeTab || activeTab.loadingMore || !activeTab.searchResults) return;

    const { searchContext, searchResults } = activeTab;
    const currentCount = searchResults.results.length;
    // A capped count is a lower bound: keep paging until a page comes back empty.
    if (currentCount >= MAX_RESULTS || searchResults.loadedAll) return;
    if (currentCount >= searchResults.total_hits && !searchResults.was_capped) return;

    updateTab(activeTab.id, { loadingMore: true });

    try {
      const filters = getFilters();
      let moreResults: SearchResults;

      if (searchContext.type === 'name' && searchContext.namePatterns) {
        const forms: NameSearchFormAPI[] = searchContext.namePatterns.map(patterns => ({ patterns }));
        moreResults = await api.nameSearch(forms, filters, PAGE_SIZE, currentCount);
      } else if (searchContext.type === 'proximity' && searchContext.proximityQuery) {
        const query = searchContext.proximityQuery;
        moreResults = await api.proximitySearch(
          query.term1, query.field1, query.term2, query.field2, query.distance,
          filters, PAGE_SIZE, currentCount
        );
      } else if (searchContext.type === 'combined' && searchContext.combinedQuery) {
        moreResults = await api.combinedSearch(
          searchContext.combinedQuery, filters, PAGE_SIZE, currentCount
        );
      } else if (searchContext.type === 'wildcard' && searchContext.wildcardQuery) {
        moreResults = await api.wildcardSearch(
          searchContext.wildcardQuery,
          filters,
          PAGE_SIZE,
          currentCount
        );
      } else {
        updateTab(activeTab.id, { loadingMore: false });
        return;
      }

      // Later pages come from the engine's cached walk, whose count settles as
      // the walk completes: take the newest total and capped flag.
      updateTab(activeTab.id, {
        searchResults: {
          ...searchResults,
          results: [...searchResults.results, ...moreResults.results],
          total_hits: Math.max(searchResults.total_hits, moreResults.total_hits),
          was_capped: moreResults.was_capped,
          walk_key: moreResults.walk_key ?? searchResults.walk_key,
          complete: moreResults.complete,
          loadedAll: moreResults.results.length === 0,
        },
        loadingMore: false,
      });
      scheduleStatusPolls(activeTab.id, moreResults);
    } catch (err) {
      updateTab(activeTab.id, {
        errorMessage: `Failed to load more results: ${err}`,
        loadingMore: false,
      });
      console.error('Failed to load more:', err);
    }
  }, [activeTab, getFilters, updateTab, api, scheduleStatusPolls]);

  // Export handler: re-runs the tab's search page by page (the engine clamps
  // `limit` to 250 on both hosts, so one request with limit=2000 would
  // silently return 250 rows) up to EXPORT_MAX_RESULTS, reporting progress.
  const handleExportResults = useCallback(async (onProgress?: (p: ExportProgress) => void): Promise<SearchResult[]> => {
    if (!activeTab) return [];
    const fetchPage = pageFetcherFor(api, activeTab.searchContext, getFilters());
    if (!fetchPage) return [];
    return collectExportRows(fetchPage, { max: EXPORT_MAX_RESULTS, pageSize: PAGE_SIZE, onProgress });
  }, [activeTab, getFilters, api]);

  // Result click handler
  const handleResultClick = useCallback(async (result: SearchResult) => {
    if (!activeTab) return;
    await loadResultIntoTab(activeTab.id, result);
  }, [activeTab, loadResultIntoTab]);

  return {
    handleSearch,
    handleProximitySearch,
    handleNameSearch,
    handleLoadMore,
    handleExportResults,
    handleResultClick,
  };
}
