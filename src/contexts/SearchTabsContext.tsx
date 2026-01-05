import { createContext, useContext, type ReactNode } from 'react';
import { useSearchTabs, type UseSearchTabsResult } from '../hooks/useSearchTabs';

// The context value is the same as the hook result
type SearchTabsContextValue = UseSearchTabsResult;

const SearchTabsContext = createContext<SearchTabsContextValue | null>(null);

export function SearchTabsProvider({ children }: { children: ReactNode }) {
  const searchTabs = useSearchTabs();

  return (
    <SearchTabsContext.Provider value={searchTabs}>
      {children}
    </SearchTabsContext.Provider>
  );
}

export function useSearchTabsContext(): SearchTabsContextValue {
  const context = useContext(SearchTabsContext);
  if (!context) {
    throw new Error('useSearchTabsContext must be used within a SearchTabsProvider');
  }
  return context;
}

// Re-export types for convenience
export type { UseSearchTabsResult as SearchTabsContextValue };
