import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
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

  // Get filtered text IDs based on filters
  const getFilteredTextIds = useCallback((): number[] => {
    console.log('Filtering texts with filters:', filters);
    console.log(`Starting with ${textsMetadata.size} texts and ${authorsMetadata.size} authors`);
    
    // Start with all texts
    let filteredTexts = Array.from(textsMetadata.values());
    console.log(`Initial text count: ${filteredTexts.length}`);
    
    // Filter by genres
    if (filters.genres.length > 0) {
      const genresSet = new Set(filters.genres);
      filteredTexts = filteredTexts.filter(text => 
        text.tags && text.tags.some(genre => genresSet.has(genre))
      );
      console.log(`After genre filtering: ${filteredTexts.length} texts`);
    }
    
    // Filter by authors
    if (filters.authors.length > 0) {
      const authorsSet = new Set(filters.authors);
      filteredTexts = filteredTexts.filter(text => {
        const hasAuthor = authorsSet.has(text.au_id);
        if (!hasAuthor && process.env.NODE_ENV !== 'production') {
          console.debug(`Text ${text.id} with au_id ${text.au_id} filtered out (not in selected authors)`);
        }
        return hasAuthor;
      });
      console.log(`After author filtering: ${filteredTexts.length} texts`);
    }
    
    // Filter by death date
    if (filters.deathDateRange.min > 0 || filters.deathDateRange.max < 2000) {
      console.log(`Filtering by death date range: ${filters.deathDateRange.min} - ${filters.deathDateRange.max}`);
      
      // Get author IDs within death date range
      const authorIdsInRange = new Set<number>();
      let authorsMissingDeathDate = 0;
      
      authorsMetadata.forEach(author => {
        if (author.death_date === 0 || author.death_date === undefined) {
          authorsMissingDeathDate++;
        } else if (
          author.death_date >= filters.deathDateRange.min && 
          author.death_date <= filters.deathDateRange.max
        ) {
          authorIdsInRange.add(author.id);
        }
      });
      
      console.log(`Found ${authorIdsInRange.size} authors in death date range`);
      if (authorsMissingDeathDate > 0) {
        console.warn(`Note: ${authorsMissingDeathDate} authors have no death date information`);
      }
      
      // Filter texts by those author IDs
      let textsWithoutAuthor = 0;
      filteredTexts = filteredTexts.filter(text => {
        // Check if the text's author exists and is in range
        const authorInRange = authorIdsInRange.has(text.au_id);
        
        // If author not found, log this for debugging
        if (!authorsMetadata.has(text.au_id)) {
          textsWithoutAuthor++;
          if (textsWithoutAuthor <= 10) {
            console.warn(`Text ${text.id} references au_id ${text.au_id} which is not found in authors metadata`);
          }
        }
        
        return authorInRange;
      });
      
      if (textsWithoutAuthor > 10) {
        console.warn(`${textsWithoutAuthor} texts referenced author IDs not found in authors metadata`);
      }
      
      console.log(`After death date filtering: ${filteredTexts.length} texts`);
    }
    
    // Return text IDs
    const textIds = filteredTexts.map(text => text.id);
    console.log(`Final filtered text count: ${textIds.length}`);
    return textIds;
  }, [filters, textsMetadata, authorsMetadata]);

  // Execute search with improved metadata handling and pagination support
  const executeSearch = useCallback(async (query: string = searchQuery, page: number = currentPage) => {
    if (!query.trim()) return;
    
    setIsLoading(true);
    console.log(`Executing search for "${query}" on page ${page}`);
    
    try {
      // Get filtered text IDs
      const textIds = getFilteredTextIds();
      
      // Calculate pages to load
      const pagesToLoad = [page]; // Focus on loading just the requested page
      
      // Execute search
      const response = await searchTexts(
        normalizeArabicText(query),
        page, // Use the page parameter
        rowsPerPage,
        textIds,
        pagesToLoad
      );
      
      console.log(`Search returned ${response.hits.length} results from a total of ${response.total}`);
      
      // Track metadata issues for debugging
      let missingTextsCount = 0;
      let missingAuthorsCount = 0;
      
      // Map results to include text and author metadata
      const enrichedResults = response.hits.map(result => {
        // Find text metadata
        const text = textsMetadata.get(result.text_id);
        
        if (!text) {
          missingTextsCount++;
          if (missingTextsCount <= 5) {
            console.warn(`Missing text metadata for text_id: ${result.text_id}`);
          }
          
          // Return result with placeholders for missing metadata
          return {
            ...result,
            text_title: `Text ID: ${result.text_id}`,
            author_name: 'Unknown Author'
          };
        }
        
        // Find author metadata using text.au_id
        const author = authorsMetadata.get(text.au_id);
        
        if (!author) {
          missingAuthorsCount++;
          if (missingAuthorsCount <= 5) {
            console.warn(`Missing author metadata for au_id: ${text.au_id} (text_id: ${result.text_id})`);
          }
          
          // Return result with text info but placeholder for author
          return {
            ...result,
            text_title: text.title || `Text ID: ${result.text_id}`,
            author_name: `Author ID: ${text.au_id}`
          };
        }
        
        // Return fully enriched result with proper author name display
        let authorName = author.name;
        
        // If au_sh_ar field is available, use it for display
        if ((author as any).au_sh_ar) {
          authorName = (author as any).au_sh_ar;
        }
        
        // Include the death_date from the author metadata
        return {
          ...result,
          text_title: text.title || '',
          author_name: authorName || '',
          death_date: author.death_date || null,
          // Include other potential fields that might be useful
          title_lat: (text as any).title_lat || null,
          author_lat: (author as any).author_lat || null
        };
      });
      
      // Log any metadata issues
      if (missingTextsCount > 0) {
        console.warn(`${missingTextsCount} search results had missing text metadata`);
      }
      
      if (missingAuthorsCount > 0) {
        console.warn(`${missingAuthorsCount} search results had missing author metadata`);
      }
      
      // Update state
      setResults(enrichedResults);
      setTotalResults(response.total);
      setCurrentPage(page); // Ensure current page is updated
      setLoadedPages(prev => {
        if (prev.includes(page)) {
          return prev;
        } else {
          return [...prev, page];
        }
      });
      
      // Update URL params if needed
      updateUrlParams(query, page);
    } catch (error) {
      console.error('Search failed:', error);
      // Display a user-friendly error message
      setResults([]);
      setTotalResults(0);
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery, currentPage, rowsPerPage, textsMetadata, authorsMetadata, getFilteredTextIds]);

  // Update URL params
  const updateUrlParams = useCallback((query: string, page: number = currentPage) => {
    const params = buildUrlParams({
      query,
      page,
      rows: rowsPerPage,
      filters
    });
    
    console.log(`Updating URL params: query=${query}, page=${page}, rows=${rowsPerPage}`);
    navigate(`?${params}`, { replace: true });
  }, [navigate, currentPage, rowsPerPage, filters]);

  // Reset filters
  const resetFilters = useCallback(() => {
    setFilters({
      genres: [],
      authors: [],
      deathDateRange: { min: 0, max: 2000 }
    });
    setCurrentPage(1);
  }, []);

  // Apply filters
  const applyFilters = useCallback(() => {
    console.log("Applying filters:", filters);
    setCurrentPage(1);
    setLoadedPages([]);
    executeSearch(searchQuery, 1); // Reset to page 1 when applying filters
  }, [filters, searchQuery, executeSearch]);

  // Handle search
  const handleSearch = useCallback((query: string) => {
    console.log(`New search for: "${query}"`);
    setSearchQuery(query);
    setCurrentPage(1);
    setLoadedPages([]);
    executeSearch(query, 1); // Always start on page 1 for new searches
  }, [executeSearch]);
  
  // Handle page change
  const handlePageChange = useCallback((page: number) => {
    console.log(`Changing to page ${page}`);
    
    // Don't do anything if it's the same page
    if (page === currentPage) return;
    
    // Execute search with the new page
    executeSearch(searchQuery, page);
  }, [currentPage, searchQuery, executeSearch]);

  // Handle rows per page change
  const handleRowsPerPageChange = useCallback((newRowsPerPage: number) => {
    console.log(`Changing rows per page to ${newRowsPerPage}`);
    setRowsPerPage(newRowsPerPage);
    setCurrentPage(1); // Reset to first page
    executeSearch(searchQuery, 1); // Execute search with new page size
  }, [searchQuery, executeSearch]);

  // Parse URL params when metadata is loaded
  useEffect(() => {
    if (metadataLoading) return; // Don't process URL params until metadata is loaded
    
    const params = parseUrlParams(location.search);
    console.log('Parsed URL params:', params);
    
    if (params.query) {
      setSearchQuery(params.query);
    }
    
    if (params.page) {
      setCurrentPage(params.page);
    }
    
    if (params.rows) {
      setRowsPerPage(params.rows);
    }
    
    if (params.filters) {
      setFilters(params.filters);
    }
    
    // Execute search if we have a query
    if (params.query) {
      executeSearch(params.query, params.page || 1);
    }
  }, [location.search, metadataLoading, executeSearch]);

  return (
    <SearchContext.Provider
      value={{
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
        executeSearch,
        resetFilters,
        applyFilters,
        handleSearch,
        handlePageChange,
        handleRowsPerPageChange,
        getFilteredTextIds
      }}
    >
      {children}
    </SearchContext.Provider>
  );
};