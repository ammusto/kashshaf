import { useCallback } from 'react';
import type { SearchResult, SearchMode } from '../types';
import type { SearchAPI, SearchTerm } from '../api';
import type { SearchContext } from '../types/search';
import { useSearchTabsContext } from '../contexts/SearchTabsContext';

export interface UseReaderNavigationOptions {
  api: SearchAPI;
}

export interface UseReaderNavigationReturn {
  /** Fallback stepping for a corpus with no page list; otherwise the reader steps itself. */
  handleNavigatePage: (direction: number) => Promise<void>;
  /** Jump to a specific part_label/page_number. Returns false if no such page exists. */
  handleNavigateToLabel: (partLabel: string, pageNumber: string) => Promise<boolean>;
  loadResultIntoTab: (tabId: string, result: SearchResult) => Promise<void>;
}

/**
 * Extract search terms from a search context for fetching match positions
 */
export function getSearchTermsFromContext(context: SearchContext): SearchTerm[] | null {
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

/**
 * Moving the reader from outside it: clicking a result, jumping to a printed
 * page number, stepping when the corpus has no page list.
 *
 * All three do the same small thing — set the tab's anchor, `(currentBookId,
 * currentPartIndex, currentPageId)`. The reader watches that and fetches the
 * pages around it itself, so nothing here loads a body or a token list.
 */
export function useReaderNavigation(options: UseReaderNavigationOptions): UseReaderNavigationReturn {
  const { api } = options;
  const { tabs, activeTab, updateTab } = useSearchTabsContext();

  // Point a tab's reader at a result.
  const loadResultIntoTab = useCallback(async (tabId: string, result: SearchResult) => {
    updateTab(tabId, {
      errorMessage: '',
      currentBookId: result.id,
      currentPartIndex: result.part_index,
      currentPageId: result.page_id,
      matchedTokenIndices: result.matched_token_indices ?? [],
      currentPage: {
        bookId: result.id,
        meta: `${result.part_label}:${result.page_number}`,
      },
    });

    // A result from a walk carries its own highlights; one from a path that
    // does not (name search, some wildcard windows) needs them looked up, so
    // the page the user asked for is marked the moment it renders rather
    // than after the reader's own per-page lookup catches up.
    if ((result.matched_token_indices?.length ?? 0) > 0) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab?.searchContext) return;
    try {
      let matched: number[] = [];
      if (tab.searchContext.type === 'name' && tab.searchContext.namePatterns) {
        matched = await api.getNameMatchPositions(
          result.id,
          result.part_index,
          result.page_id,
          tab.searchContext.namePatterns.flat()
        );
      } else {
        const terms = getSearchTermsFromContext(tab.searchContext);
        if (terms && terms.length > 0) {
          matched = await api.getMatchPositionsCombined(result.id, result.part_index, result.page_id, terms);
        }
      }
      if (matched.length > 0) updateTab(tabId, { matchedTokenIndices: matched });
    } catch (err) {
      console.warn('Failed to fetch match positions:', err);
    }
  }, [updateTab, api, tabs]);

  // Stepping without a page list: the next page id in the same part, which is
  // all an older corpus can offer. With a list the reader steps itself, in
  // reading order and across part boundaries.
  const handleNavigatePage = useCallback(async (direction: number) => {
    if (!activeTab || activeTab.currentBookId === null) return;
    const newPageId = activeTab.currentPageId + direction;
    if (newPageId < 1) return;
    const page = await api.getPage(activeTab.currentBookId, activeTab.currentPartIndex, newPageId);
    if (!page) return;
    updateTab(activeTab.id, {
      errorMessage: '',
      currentPageId: newPageId,
      matchedTokenIndices: [],
      currentPage: {
        bookId: page.id,
        meta: `${page.part_label}:${page.page_number}`,
      },
    });
  }, [activeTab, updateTab, api]);

  // Jump to a printed page number. The reader resolves this against the page
  // list when it has one; this is the fallback, and the path a jump into a
  // book the reader has not opened yet still takes.
  const handleNavigateToLabel = useCallback(async (partLabel: string, pageNumber: string): Promise<boolean> => {
    if (!activeTab || activeTab.currentBookId === null) return false;
    try {
      const page = await api.getPageByLabel(activeTab.currentBookId, partLabel, pageNumber);
      if (!page) return false;
      updateTab(activeTab.id, {
        errorMessage: '',
        currentPartIndex: page.part_index,
        currentPageId: page.page_id,
        matchedTokenIndices: [],
        currentPage: {
          bookId: page.id,
          meta: `${page.part_label}:${page.page_number}`,
        },
      });
      return true;
    } catch (err) {
      console.error('Failed to navigate to label:', err);
      return false;
    }
  }, [activeTab, updateTab, api]);

  return {
    handleNavigatePage,
    handleNavigateToLabel,
    loadResultIntoTab,
  };
}
