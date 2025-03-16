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

// Validation functions
const containsWildcard = (query: string): boolean => {
  return query.includes('*');
};

const isPhrase = (query: string): boolean => {
  const words = query.trim().split(/\s+/);
  return words.length > 1;
};

const validateSearchQuery = (query: string): boolean => {
  if (isPhrase(query) && containsWildcard(query)) {
    return false; // Invalid: phrase with wildcard
  }
  return true; // Valid query
};

interface SearchContextType {
  // Search state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  results: SearchResult[];
  isLoading: boolean;
  totalResults: number;
  searchError: string | null;
  
  // Pagination
  currentPage: number;
  rowsPerPage: number;
  
  // Filters
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  
  // Actions
  handleSearch: (query: string) => void;
  handlePageChange: (page: number) => void;
  handleRowsPerPageChange: (rows: number) => void;
  applyFilters: (newFilters: FilterState) => void;
  resetFilters: () => void;
  resetSearch: () => void; // New reset search function
  
  // Utility
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
  const [searchError, setSearchError] = useState<string | null>(null);
  
  // Refs for stale closure prevention
  const searchQueryRef = useRef(searchQuery);
  const currentPageRef = useRef(currentPage);
  const rowsPerPageRef = useRef(rowsPerPage);
  const filtersRef = useRef(filters);
  
  // Update refs when state changes
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);
  
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);
  
  useEffect(() => {
    rowsPerPageRef.current = rowsPerPage;
  }, [rowsPerPage]);
  
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  
  // Get filtered text IDs based on active filters
  const getFilteredTextIds = useCallback((): number[] => {
    if (!textsMetadata || !authorsMetadata) return [];
    
    // Start with all texts
    let filteredTexts = Array.from(textsMetadata.values());
    
    // Filter by genres
    if (filtersRef.current.genres.length > 0) {
      const genresSet = new Set(filtersRef.current.genres);
      filteredTexts = filteredTexts.filter(text => 
        text.tags && text.tags.some(genre => genresSet.has(genre))
      );
    }
    
    // Filter by authors
    if (filtersRef.current.authors.length > 0) {
      const authorsSet = new Set(filtersRef.current.authors);
      filteredTexts = filteredTexts.filter(text => authorsSet.has(text.au_id));
    }
    
    // Filter by death date range
    if (filtersRef.current.deathDateRange.min > 0 || filtersRef.current.deathDateRange.max < 2000) {
      // Get author IDs within death date range
      const authorIdsInRange = new Set<number>();
      
      authorsMetadata.forEach(author => {
        if (author.death_date && 
            author.death_date >= filtersRef.current.deathDateRange.min && 
            author.death_date <= filtersRef.current.deathDateRange.max) {
          authorIdsInRange.add(author.id);
        }
      });
      
      // Filter texts by those author IDs
      filteredTexts = filteredTexts.filter(text => authorIdsInRange.has(text.au_id));
    }
    
    return filteredTexts.map(text => text.id);
  }, [textsMetadata, authorsMetadata]);
  
  // Execute search
  const executeSearch = useCallback(async (
    query: string,
    page: number,
    size: number,
    searchFilters: FilterState
  ) => {
    if (!query.trim() || metadataLoading) return;
    
    // Validate the query - don't allow wildcards in phrase searches
    if (!validateSearchQuery(query)) {
      setSearchError("Wildcards (*) are not allowed in phrase searches. Please use wildcards only with single words.");
      setIsLoading(false);
      setResults([]);
      setTotalResults(0);
      return;
    }
    
    // Clear any previous errors
    setSearchError(null);
    setIsLoading(true);
    
    try {
      // Determine text IDs based on filters
      let textIds: number[] = [];
      
      // Check if we have any filters applied that would restrict text selection
      const hasGenreFilter = searchFilters.genres.length > 0;
      const hasAuthorFilter = searchFilters.authors.length > 0;
      const hasDeathDateFilter = 
        searchFilters.deathDateRange.min > 0 || 
        searchFilters.deathDateRange.max < 2000;
      
      // If any filters are applied, get the filtered text IDs
      if (hasGenreFilter || hasAuthorFilter || hasDeathDateFilter) {
        // Start with all texts
        let filteredTexts = Array.from(textsMetadata.values());
        
        // Filter by genres
        if (hasGenreFilter) {
          const genresSet = new Set(searchFilters.genres);
          filteredTexts = filteredTexts.filter(text => 
            text.tags && text.tags.some(genre => genresSet.has(genre))
          );
        }
        
        // Filter by authors
        if (hasAuthorFilter) {
          const authorsSet = new Set(searchFilters.authors);
          filteredTexts = filteredTexts.filter(text => authorsSet.has(text.au_id));
        }
        
        // Filter by death date range
        if (hasDeathDateFilter) {
          // Get author IDs within death date range
          const authorIdsInRange = new Set<number>();
          
          authorsMetadata.forEach(author => {
            if (author.death_date && 
                author.death_date >= searchFilters.deathDateRange.min && 
                author.death_date <= searchFilters.deathDateRange.max) {
              authorIdsInRange.add(author.id);
            }
          });
          
          // Filter texts by those author IDs
          filteredTexts = filteredTexts.filter(text => authorIdsInRange.has(text.au_id));
        }
        
        // Get text IDs for the filtered texts
        textIds = filteredTexts.map(text => text.id);
        
        // If no texts match the filters, return empty results
        if (textIds.length === 0) {
          setResults([]);
          setTotalResults(0);
          setIsLoading(false);
          return;
        }
      }
      
      // Execute search
      const response = await searchTexts(
        normalizeArabicText(query),
        page,
        size,
        textIds.length > 0 ? textIds : undefined,
        [page]
      );
      
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
      
      // Update state
      if (enrichedResults.length === 0) {
        // If no results found, explicitly clear results and set total to 0
        setResults([]);
        setTotalResults(0);
      } else {
        setResults(enrichedResults);
        setTotalResults(response.total);
      }
      
    } catch (error) {
      console.error('Search failed:', error);
      if (error instanceof Error) {
        setSearchError(error.message);
      } else {
        setSearchError('An unexpected error occurred during search');
      }
      setResults([]);
      setTotalResults(0);
    } finally {
      setIsLoading(false);
    }
  }, [textsMetadata, authorsMetadata, metadataLoading]);

  // Create ref for executeSearch
  const executeSearchRef = useRef(executeSearch);

  // Update the ref when executeSearch changes
  useEffect(() => {
    executeSearchRef.current = executeSearch;
  }, [executeSearch]);

  // Process URL params on mount or URL change
  useEffect(() => {
    if (metadataLoading) return;

    const params = parseUrlParams(location.search);

    // Validate the query if it exists
    if (params.query && !validateSearchQuery(params.query)) {
      setSearchError("Wildcards (*) are not allowed in phrase searches. Please use wildcards only with single words.");
      setResults([]);
      setTotalResults(0);
      
      // Clear invalid query from URL by replacing with valid URL
      navigate('/', { replace: true });
      return;
    }

    let shouldSearch = false;

    // Update search query if changed
    if (params.query && params.query !== searchQueryRef.current) {
      setSearchQuery(params.query);
      shouldSearch = true;
    }

    // Update page if changed
    if (params.page && params.page !== currentPageRef.current) {
      setCurrentPage(params.page);
      shouldSearch = true;
    }

    // Update rows per page if changed
    if (params.rows && params.rows !== rowsPerPageRef.current) {
      setRowsPerPage(params.rows);
      shouldSearch = true;
    }

    // Update filters if changed
    if (params.filters) {
      const currentFiltersStr = JSON.stringify(filtersRef.current);
      const newFiltersStr = JSON.stringify(params.filters);

      if (currentFiltersStr !== newFiltersStr) {
        setFilters(params.filters);
        shouldSearch = true;
      }
    } else if (filtersRef.current.genres.length > 0 ||
      filtersRef.current.authors.length > 0 ||
      filtersRef.current.deathDateRange.min > 0 ||
      filtersRef.current.deathDateRange.max < 2000) {
      // Reset filters if URL has no filters but we have active filters
      setFilters(DEFAULT_FILTERS);
      shouldSearch = true;
    }

    // Execute search if needed
    if (shouldSearch && params.query) {
      executeSearchRef.current(
        params.query,
        params.page || 1,
        params.rows || DEFAULT_ROWS_PER_PAGE,
        params.filters || DEFAULT_FILTERS
      );
    }
  }, [location.search, metadataLoading, navigate]);

  // Update URL and trigger search
  const updateUrlAndSearch = useCallback((params: {
    query?: string,
    page?: number,
    rows?: number,
    filters?: FilterState
  }) => {
    const queryToUse = params.query !== undefined ? params.query : searchQueryRef.current;
    
    // Validate the query before updating URL
    if (queryToUse && !validateSearchQuery(queryToUse)) {
      setSearchError("Wildcards (*) are not allowed in phrase searches. Please use wildcards only with single words.");
      return;
    }
    
    // Build the URL params
    const urlParams = buildUrlParams({
      query: queryToUse,
      page: params.page !== undefined ? params.page : currentPageRef.current,
      rows: params.rows !== undefined ? params.rows : rowsPerPageRef.current,
      filters: params.filters !== undefined ? params.filters : filtersRef.current
    });

    // Update URL without reloading the page
    navigate(`?${urlParams}`, { replace: false });
  }, [navigate]);

  // Handle search form submission
  const handleSearch = useCallback((query: string) => {
    if (!query.trim()) return;

    // Validate the query before initiating search
    if (!validateSearchQuery(query)) {
      setSearchError("Wildcards (*) are not allowed in phrase searches. Please use wildcards only with single words.");
      return;
    }

    updateUrlAndSearch({ query, page: 1 }); // Reset to page 1 for new searches
  }, [updateUrlAndSearch]);

  // Handle page change
  const handlePageChange = useCallback((page: number) => {
    if (page === currentPageRef.current) return;

    updateUrlAndSearch({ page });
  }, [updateUrlAndSearch]);

  // Handle rows per page change
  const handleRowsPerPageChange = useCallback((rows: number) => {
    if (rows === rowsPerPageRef.current) return;

    updateUrlAndSearch({ rows, page: 1 }); // Reset to page 1 when changing rows
  }, [updateUrlAndSearch]);

  // Apply filters
  const applyFilters = useCallback((newFilters: FilterState) => {
    updateUrlAndSearch({ filters: newFilters, page: 1 }); // Reset to page 1 when applying filters
  }, [updateUrlAndSearch]);

  // Reset filters
  const resetFilters = useCallback(() => {
    updateUrlAndSearch({
      filters: DEFAULT_FILTERS,
      page: 1
    });
  }, [updateUrlAndSearch]);

  // Reset search - new function
  const resetSearch = useCallback(() => {
    // Clear search query
    setSearchQuery('');
    // Reset page to 1
    setCurrentPage(1);
    // Reset rows per page to default
    setRowsPerPage(DEFAULT_ROWS_PER_PAGE);
    // Reset filters
    setFilters(DEFAULT_FILTERS);
    // Clear results
    setResults([]);
    // Clear total results
    setTotalResults(0);
    // Clear search error
    setSearchError(null);
    
    // Update URL to remove all search params
    navigate('/', { replace: true });
  }, [navigate]);

  // Context value
  const contextValue = useMemo(() => ({
    searchQuery,
    setSearchQuery,
    results,
    isLoading,
    totalResults,
    searchError,
    currentPage,
    rowsPerPage,
    filters,
    setFilters,
    handleSearch,
    handlePageChange,
    handleRowsPerPageChange,
    applyFilters,
    resetFilters,
    resetSearch,
    getFilteredTextIds
  }), [
    searchQuery,
    results,
    isLoading,
    totalResults,
    searchError,
    currentPage,
    rowsPerPage,
    filters,
    handleSearch,
    handlePageChange,
    handleRowsPerPageChange,
    applyFilters,
    resetFilters,
    resetSearch,
    getFilteredTextIds
  ]);

  return (
    <SearchContext.Provider value={contextValue}>
      {children}
    </SearchContext.Provider>
  );
};