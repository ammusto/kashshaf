import { useCallback } from 'react';
import type { SearchResult, SearchMode } from '../types';
import type { SearchAPI, SearchTerm } from '../api';
import type { SearchContext } from '../types/search';
import { useSearchTabsContext } from '../contexts/SearchTabsContext';

export interface UseReaderNavigationOptions {
  api: SearchAPI;
}

export interface UseReaderNavigationReturn {
  handleNavigatePage: (direction: number) => Promise<void>;
  loadResultIntoTab: (tabId: string, result: SearchResult) => Promise<void>;
}

/**
 * Extract search terms from a search context for fetching match positions
 */
function getSearchTermsFromContext(context: SearchContext): SearchTerm[] | null {
  if (context.type === 'combined' && context.combinedQuery) {
    const terms: SearchTerm[] = [];
    for (const inp of context.combinedQuery.andInputs) {
      if (inp.query.trim()) {
        terms.push({ query: inp.query, mode: inp.mode });
      }
    }
    for (const inp of context.combinedQuery.orInputs) {
      if (inp.query.trim()) {
        terms.push({ query: inp.query, mode: inp.mode });
      }
    }
    return terms.length > 0 ? terms : null;
  }

  if (context.type === 'proximity' && context.proximityQuery) {
    return [
      { query: context.proximityQuery.term1, mode: context.proximityQuery.field1 as SearchMode },
      { query: context.proximityQuery.term2, mode: context.proximityQuery.field2 as SearchMode },
    ];
  }

  if (context.type === 'wildcard' && context.wildcardQuery) {
    return [{ query: context.wildcardQuery, mode: 'surface' }];
  }

  // Name search uses patterns, handled separately
  return null;
}

export function useReaderNavigation(options: UseReaderNavigationOptions): UseReaderNavigationReturn {
  const { api } = options;
  const { tabs, activeTab, updateTab } = useSearchTabsContext();

  // Load a result into a specific tab (used for auto-loading first result and clicking results)
  const loadResultIntoTab = useCallback(async (tabId: string, result: SearchResult) => {
    updateTab(tabId, { errorMessage: '' });

    updateTab(tabId, {
      currentPage: {
        title: result.title,
        author: result.author,
        meta: `${result.part_label}:${result.page_number}`,
        body: result.body ?? '',
      },
      pageTokens: [],
      matchedTokenIndices: [],
      currentBookId: result.id,
      currentPartIndex: result.part_index,
      currentPageId: result.page_id,
    });

    try {
      const startTime = performance.now();

      // Fetch tokens
      const tokens = await api.getPageTokens(result.id, result.part_index, result.page_id);

      // Use matched_token_indices from result if available
      let matchedIndices = result.matched_token_indices || [];

      // If no match indices were returned, try to fetch them using the search context
      if (matchedIndices.length === 0) {
        const tab = tabs.find(t => t.id === tabId);
        if (tab?.searchContext) {
          try {
            // Handle name search separately (uses patterns)
            if (tab.searchContext.type === 'name' && tab.searchContext.namePatterns) {
              const allPatterns = tab.searchContext.namePatterns.flat();
              matchedIndices = await api.getNameMatchPositions(
                result.id,
                result.part_index,
                result.page_id,
                allPatterns
              );
            } else {
              // Extract search terms from context
              const searchTerms = getSearchTermsFromContext(tab.searchContext);
              if (searchTerms && searchTerms.length > 0) {
                matchedIndices = await api.getMatchPositionsCombined(
                  result.id,
                  result.part_index,
                  result.page_id,
                  searchTerms
                );
              }
            }
          } catch (matchErr) {
            console.warn('Failed to fetch match positions:', matchErr);
            // Continue without highlighting
          }
        }
      }

      const loadTimeMs = Math.round(performance.now() - startTime);

      updateTab(tabId, {
        pageTokens: tokens,
        matchedTokenIndices: matchedIndices,
        currentPage: {
          title: result.title,
          author: result.author,
          meta: ` ${result.part_label}:${result.page_number}`,
          body: result.body ?? '',
          loadTimeMs,
        },
      });
    } catch (err) {
      updateTab(tabId, { errorMessage: `Failed to load page: ${err}` });
      console.error('Failed to load page:', err);
    }
  }, [updateTab, api, tabs]);

  // Page navigation handler - navigate to previous/next page
  const handleNavigatePage = useCallback(async (direction: number) => {
    if (!activeTab || activeTab.currentBookId === null) return;

    const newPageId = activeTab.currentPageId + direction;
    if (newPageId < 1) return;

    updateTab(activeTab.id, { errorMessage: '' });

    try {
      const startTime = performance.now();
      const [page, tokens] = await Promise.all([
        api.getPage(activeTab.currentBookId, activeTab.currentPartIndex, newPageId),
        api.getPageTokens(activeTab.currentBookId, activeTab.currentPartIndex, newPageId)
      ]);

      const loadTimeMs = Math.round(performance.now() - startTime);

      if (page) {
        updateTab(activeTab.id, {
          currentPage: {
            title: page.title,
            author: page.author,
            meta: `${page.part_label}:${page.page_number}`,
            body: page.body ?? '',
            loadTimeMs,
          },
          pageTokens: tokens,
          currentPageId: newPageId,
          matchedTokenIndices: [],
        });
      }
    } catch (err) {
      updateTab(activeTab.id, { errorMessage: `Failed to load page: ${err}` });
      console.error('Failed to load page:', err);
    }
  }, [activeTab, updateTab, api]);

  return {
    handleNavigatePage,
    loadResultIntoTab,
  };
}
