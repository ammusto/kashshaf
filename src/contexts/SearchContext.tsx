import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMetadata } from './MetadataContext';
import { searchTexts } from '../services/opensearch';
import { parseUrlParams, buildUrlParams } from '../utils/urlParams';
import { normalizeArabicText } from '../utils/arabicNormalization';
import { SearchResult, FilterState } from '../types';

// Default values
const DEFAULT_ROWS_PER_PAGE = parseInt(process.env.REACT_APP_DEFAULT_ROWS_PER_PAGE || '50', 10);
const DEFAULT_FILTERS: FilterState = {
  genres: [],
  authors: [],
  deathDateRange: { min: 0, max: 2000 }
};

interface SearchContextType {
  // Search state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  results: SearchResult[];
  isLoading: boolean;
  totalResults: number;
  
  // Pagination
  currentPage: number;
  setCurrentPage: (page: number) => void;
  rowsPerPage: number;
  setRowsPerPage: (rows: number) => void;
  
  // Filters
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  
  // Actions
  executeSearch: (newQuery?: string, page?: number) => void;
  resetFilters: () => void;
  applyFilters: () => void;
  handleSearch: (query: string) => void;
  handlePageChange: (page: number) => void;
  handleRowsPerPageChange: (newRowsPerPage: number) => void;
  
  // Filter utils
  getFilteredTextIds: () => number[];
}

const SearchContext = createContext<SearchContextType | null>(null);

export const useSearch = () => {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error('useSearch must be used within a SearchProvider');
  }
  return context;
};

interface SearchProviderProps {
  children: ReactNode;
}

export const SearchProvider: React.FC<SearchProviderProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { textsMetadata, authorsMetadata, isLoading: metadataLoading } = useMetadata();
  
  // States
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [rowsPerPage, setRowsPerPage] = useState<number>(DEFAULT_ROWS_PER_PAGE);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [loadedPages, setLoadedPages] = useState<number[]>([]);
  
  // Refs for tracking
  const isSearchExecutingRef = useRef<boolean>(false);
  const lastProcessedUrlRef = useRef<string>('');
  const isInitialRenderRef = useRef<boolean>(true);

  // Get filtered text IDs based on filters - memoized to prevent recalculation
  const getFilteredTextIds = useCallback((): number[] => {
    console.log('Calculating filtered text IDs with filters:', JSON.stringify(filters));
    
    // Start with all texts
    let filteredTexts = Array.from(textsMetadata.values());
    console.log(`Starting with ${filteredTexts.length} texts`);
    
    // Filter by genres
    if (filters.genres.length > 0) {
      const genresSet = new Set(filters.genres);
      filteredTexts = filteredTexts.filter(text => 
        text.tags && text.tags.some(genre => genresSet.has(genre))
      );
      console.log(`After genre filtering: ${filteredTexts.length} texts remain`);
    }
    
    // Filter by authors
    if (filters.authors.length > 0) {
      const authorsSet = new Set(filters.authors);
      filteredTexts = filteredTexts.filter(text => authorsSet.has(text.au_id));
      console.log(`After author filtering: ${filteredTexts.length} texts remain`);
    }
    
    // Filter by death date range
    if (filters.deathDateRange.min > 0 || filters.deathDateRange.max < 2000) {
      // Get author IDs within death date range
      const authorIdsInRange = new Set<number>();
      
      // Iterate once over authors
      authorsMetadata.forEach(author => {
        if (author.death_date && 
            author.death_date >= filters.deathDateRange.min && 
            author.death_date <= filters.deathDateRange.max) {
          authorIdsInRange.add(author.id);
        }
      });
      
      console.log(`Found ${authorIdsInRange.size} authors in death date range`);
      
      // Filter texts by those author IDs
      filteredTexts = filteredTexts.filter(text => authorIdsInRange.has(text.au_id));
      console.log(`After death date filtering: ${filteredTexts.length} texts remain`);
    }
    
    // Return text IDs
    const textIds = filteredTexts.map(text => text.id);
    console.log(`Returning ${textIds.length} filtered text IDs`);
    return textIds;
  }, [filters, textsMetadata, authorsMetadata]);

  // Actual search execution - separate from URL handling
  const executeSearch = useCallback(async (
    query: string,
    page: number,
    size: number,
    currentFilters: FilterState
  ) => {
    // Set flag to indicate search is executing
    isSearchExecutingRef.current = true;
    setIsLoading(true);
    
    try {
      console.log(`Executing search for "${query}" on page ${page} with filters:`, currentFilters);
      
      // Get filtered text IDs based on CURRENT filters
      const hasActiveFilters = 
        currentFilters.genres.length > 0 || 
        currentFilters.authors.length > 0 || 
        currentFilters.deathDateRange.min > 0 || 
        currentFilters.deathDateRange.max < 2000;
      
      // Important: Using a temporary object with the current filters to get IDs
      let textIds: number[] = [];
      
      if (hasActiveFilters) {
        console.log('Has active filters, getting filtered text IDs');
        
        // Create a temporary filter state to avoid mutation
        const tempFilters = {
          genres: [...currentFilters.genres],
          authors: [...currentFilters.authors],
          deathDateRange: {
            min: currentFilters.deathDateRange.min,
            max: currentFilters.deathDateRange.max
          }
        };
        
        // Start with all texts
        let tempFilteredTexts = Array.from(textsMetadata.values());
        
        // Filter by genres
        if (tempFilters.genres.length > 0) {
          const genresSet = new Set(tempFilters.genres);
          tempFilteredTexts = tempFilteredTexts.filter(text => 
            text.tags && text.tags.some(genre => genresSet.has(genre))
          );
          console.log(`After genre filtering: ${tempFilteredTexts.length} texts`);
        }
        
        // Filter by authors
        if (tempFilters.authors.length > 0) {
          const authorsSet = new Set(tempFilters.authors);
          tempFilteredTexts = tempFilteredTexts.filter(text => authorsSet.has(text.au_id));
          console.log(`After author filtering: ${tempFilteredTexts.length} texts`);
        }
        
        // Filter by death date range
        if (tempFilters.deathDateRange.min > 0 || tempFilters.deathDateRange.max < 2000) {
          // Get author IDs within death date range
          const authorIdsInRange = new Set<number>();
          
          // Iterate once over authors
          authorsMetadata.forEach(author => {
            if (author.death_date && 
                author.death_date >= tempFilters.deathDateRange.min && 
                author.death_date <= tempFilters.deathDateRange.max) {
              authorIdsInRange.add(author.id);
            }
          });
          
          // Filter texts by those author IDs
          tempFilteredTexts = tempFilteredTexts.filter(text => authorIdsInRange.has(text.au_id));
          console.log(`After death date filtering: ${tempFilteredTexts.length} texts`);
        }
        
        // Get text IDs from filtered texts
        textIds = tempFilteredTexts.map(text => text.id);
        console.log(`Filtered to ${textIds.length} text IDs for search`);
      } else {
        console.log('No active filters, searching all texts');
      }
      
      // Execute search with text IDs
      const response = await searchTexts(
        normalizeArabicText(query),
        page,
        size,
        textIds,
        [page] // Just load the current page
      );
      
      console.log(`Search returned ${response.hits.length} results from ${response.total} total`);
      
      // Process search results
      const enrichedResults = response.hits.map(result => {
        // Find text metadata
        const text = textsMetadata.get(result.text_id);
        
        if (!text) {
          return {
            ...result,
            text_title: `Text ID: ${result.text_id}`,
            author_name: 'Unknown Author'
          };
        }
        
        // Find author metadata
        const author = authorsMetadata.get(text.au_id);
        
        if (!author) {
          return {
            ...result,
            text_title: text.title || `Text ID: ${result.text_id}`,
            author_name: `Author ID: ${text.au_id}`
          };
        }
        
        // Get proper author name
        let authorName = author.name;
        if ((author as any).au_sh_ar) {
          authorName = (author as any).au_sh_ar;
        }
        
        return {
          ...result,
          text_title: text.title || '',
          author_name: authorName || '',
          death_date: author.death_date || null,
          title_lat: (text as any).title_lat || null,
          author_lat: (author as any).author_lat || null
        };
      });
      
      // Update state with search results
      setResults(enrichedResults);
      setTotalResults(response.total);
      
      // Track loaded pages
      setLoadedPages(prev => {
        if (prev.includes(page)) {
          return prev;
        } else {
          return [...prev, page];
        }
      });
      
      return true;
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
      setTotalResults(0);
      return false;
    } finally {
      setIsLoading(false);
      isSearchExecutingRef.current = false;
    }
  }, [textsMetadata, authorsMetadata]);

  // Apply filters - update URL params
  const applyFilters = useCallback(() => {
    console.log('Applying filters by updating URL params');
    
    if (!searchQuery) {
      console.log('No search query, cannot apply filters');
      return;
    }
    
    // Build URL parameters with current state
    const urlParams = buildUrlParams({
      query: searchQuery,
      page: 1, // Reset to page 1 when applying filters
      rows: rowsPerPage,
      filters: filters
    });
    
    console.log('Updating URL to:', `?${urlParams}`);
    
    // Update URL - this will trigger the useEffect that watches location.search
    navigate(`?${urlParams}`);
  }, [searchQuery, filters, rowsPerPage, navigate]);

  // Reset filters
  const resetFilters = useCallback(() => {
    console.log('Resetting filters');
    
    if (!searchQuery) {
      console.log('No search query, cannot reset filters');
      return;
    }
    
    // Create default filters
    const defaultFilters: FilterState = {
      genres: [],
      authors: [],
      deathDateRange: { min: 0, max: 2000 }
    };
    
    // Update filters state
    setFilters(defaultFilters);
    
    // Build URL without filters
    const urlParams = buildUrlParams({
      query: searchQuery,
      page: 1,
      rows: rowsPerPage
      // No filters parameter
    });
    
    console.log('Updating URL to:', `?${urlParams}`);
    
    // Update URL - this will trigger the useEffect
    navigate(`?${urlParams}`);
  }, [searchQuery, rowsPerPage, navigate]);

  // Handle search form submission
  const handleSearch = useCallback((query: string) => {
    if (!query.trim()) return;
    
    console.log(`Handling search for: "${query}"`);
    
    // Update URL with the new search query
    const urlParams = buildUrlParams({
      query,
      page: 1, // Reset to page 1 for new searches
      rows: rowsPerPage,
      filters
    });
    
    console.log('Updating URL to:', `?${urlParams}`);
    
    // Update URL - this will trigger the useEffect
    navigate(`?${urlParams}`);
  }, [rowsPerPage, filters, navigate]);
  
  // Handle page change
  const handlePageChange = useCallback((page: number) => {
    // Don't do anything if it's the same page
    if (page === currentPage) return;
    
    console.log(`Changing to page ${page}`);
    
    // Update URL with the new page
    const urlParams = buildUrlParams({
      query: searchQuery,
      page,
      rows: rowsPerPage,
      filters
    });
    
    console.log('Updating URL to:', `?${urlParams}`);
    
    // Update URL - this will trigger the useEffect
    navigate(`?${urlParams}`);
  }, [currentPage, searchQuery, rowsPerPage, filters, navigate]);

  // Handle rows per page change
  const handleRowsPerPageChange = useCallback((newRowsPerPage: number) => {
    if (newRowsPerPage === rowsPerPage) return;
    
    console.log(`Changing rows per page to ${newRowsPerPage}`);
    
    // Update URL with the new rows per page
    const urlParams = buildUrlParams({
      query: searchQuery,
      page: 1, // Reset to first page when changing rows per page
      rows: newRowsPerPage,
      filters
    });
    
    console.log('Updating URL to:', `?${urlParams}`);
    
    // Update URL - this will trigger the useEffect
    navigate(`?${urlParams}`);
  }, [searchQuery, rowsPerPage, filters, navigate]);

  // Main effect to handle URL parameter changes and trigger searches
  useEffect(() => {
    if (metadataLoading) return; // Don't process URL params until metadata is loaded
    
    // Skip if already processing a search or if the URL is the same
    if (isSearchExecutingRef.current || location.search === lastProcessedUrlRef.current) {
      return;
    }
    
    // Update last processed URL
    lastProcessedUrlRef.current = location.search;
    
    const params = parseUrlParams(location.search);
    console.log('Processing URL params:', params);
    
    // Update state based on URL params
    let hasStateChanged = false;
    
    if (params.query !== undefined && params.query !== searchQuery) {
      setSearchQuery(params.query);
      hasStateChanged = true;
    }
    
    if (params.page !== undefined && params.page !== currentPage) {
      setCurrentPage(params.page);
      hasStateChanged = true;
    }
    
    if (params.rows !== undefined && params.rows !== rowsPerPage) {
      setRowsPerPage(params.rows);
      hasStateChanged = true;
    }
    
    // Compare filters deeply
    if (params.filters !== undefined) {
      const currentFiltersJson = JSON.stringify(filters);
      const newFiltersJson = JSON.stringify(params.filters);
      
      if (currentFiltersJson !== newFiltersJson) {
        console.log('Updating filters from URL:', params.filters);
        setFilters(params.filters);
        hasStateChanged = true;
      }
    } else if (
      filters.genres.length > 0 || 
      filters.authors.length > 0 || 
      filters.deathDateRange.min > 0 || 
      filters.deathDateRange.max < 2000
    ) {
      // If URL has no filters but state has filters, reset filters
      console.log('Resetting filters based on URL having no filters');
      setFilters(DEFAULT_FILTERS);
      hasStateChanged = true;
    }
    
    // Only execute search if we have a query
    if (params.query) {
      // Get the actual values to use for the search
      const queryToUse = params.query;
      const pageToUse = params.page || 1;
      const rowsToUse = params.rows || DEFAULT_ROWS_PER_PAGE;
      const filtersToUse = params.filters || DEFAULT_FILTERS;
      
      console.log('Executing search from URL params with filters:', filtersToUse);
      
      // Execute the search with these values
      executeSearch(queryToUse, pageToUse, rowsToUse, filtersToUse);
    } else if (hasStateChanged) {
      // If state changed but no query, just reset results
      setResults([]);
      setTotalResults(0);
    }
    
    // No longer initial render after this effect runs
    isInitialRenderRef.current = false;
  }, [location.search, metadataLoading, executeSearch, searchQuery, currentPage, rowsPerPage, filters]);

  // Value for the context provider
  const contextValue = useMemo(() => ({
    searchQuery,
    setSearchQuery,
    results,
    isLoading,
    totalResults,
    currentPage,
    setCurrentPage,
    rowsPerPage,
    setRowsPerPage,
    filters,
    setFilters,
    executeSearch: (newQuery = searchQuery, page = currentPage) => {
      // This version of executeSearch updates the URL to trigger the actual search
      const urlParams = buildUrlParams({
        query: newQuery,
        page,
        rows: rowsPerPage,
        filters
      });
      navigate(`?${urlParams}`);
    },
    resetFilters,
    applyFilters,
    handleSearch,
    handlePageChange,
    handleRowsPerPageChange,
    getFilteredTextIds
  }), [
    searchQuery,
    results,
    isLoading,
    totalResults,
    currentPage,
    rowsPerPage,
    filters,
    resetFilters,
    applyFilters,
    handleSearch,
    handlePageChange,
    handleRowsPerPageChange,
    getFilteredTextIds,
    navigate
  ]);

  return (
    <SearchContext.Provider value={contextValue}>
      {children}
    </SearchContext.Provider>
  );
};