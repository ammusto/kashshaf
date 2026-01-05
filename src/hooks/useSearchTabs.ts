import { useState, useCallback } from 'react';
import type { SearchTab, SearchContext, AppSearchMode } from '../types/search';

let tabIdCounter = 0;
function generateTabId(): string {
  return `tab-${++tabIdCounter}`;
}

export interface CreateTabConfig {
  label: string;
  fullQuery: string;
  tabType: AppSearchMode;
  searchContext: SearchContext;
}

export interface UseSearchTabsResult {
  tabs: SearchTab[];
  activeTabId: string | null;
  activeTab: SearchTab | null;
  setActiveTabId: (id: string | null) => void;
  createTab: (config: CreateTabConfig) => string;
  updateTab: (tabId: string, updates: Partial<SearchTab>) => void;
  closeTab: (tabId: string) => void;
}

export function useSearchTabs(): UseSearchTabsResult {
  const [tabs, setTabs] = useState<SearchTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Get active tab (derived value)
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  // Helper to update a specific tab
  const updateTab = useCallback((tabId: string, updates: Partial<SearchTab>) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, ...updates } : tab
    ));
  }, []);

  // Helper to create a new tab and set it active
  const createTab = useCallback((config: CreateTabConfig): string => {
    const { label, fullQuery, tabType, searchContext } = config;
    const id = generateTabId();
    const newTab: SearchTab = {
      id,
      label,
      fullQuery,
      tabType,
      searchResults: null,
      loading: true,
      loadingMore: false,
      errorMessage: '',
      currentPage: null,
      pageTokens: [],
      matchedTokenIndices: [],
      currentBookId: null,
      currentPartIndex: 0,
      currentPageId: 1,
      searchContext,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    return id;
  }, []);

  // Close tab handler
  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);

      // If we closed the active tab, switch to another
      if (tabId === activeTabId) {
        const closedIndex = prev.findIndex(t => t.id === tabId);
        if (newTabs.length > 0) {
          // Try to select the tab to the left, or the first one
          const newActiveIndex = Math.max(0, closedIndex - 1);
          setActiveTabId(newTabs[newActiveIndex]?.id ?? null);
        } else {
          setActiveTabId(null);
        }
      }

      return newTabs;
    });
  }, [activeTabId]);

  return {
    tabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    createTab,
    updateTab,
    closeTab,
  };
}
