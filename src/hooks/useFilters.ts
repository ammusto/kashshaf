import { useState, useEffect, useCallback } from 'react';
import { FilterState, Author, Text } from '../types';
import { getAvailableGenres, searchAuthors } from '../services/opensearch';

interface UseFiltersReturn {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  availableGenres: string[];
  isLoadingGenres: boolean;
  searchedAuthors: Author[];
  isSearchingAuthors: boolean;
  searchAuthorsByName: (query: string) => Promise<void>;
  updateGenreFilters: (genres: string[]) => void;
  updateAuthorFilters: (authors: number[]) => void;
  updateDeathDateRange: (min: number, max: number) => void;
  resetFilters: () => void;
}

const DEFAULT_FILTERS: FilterState = {
  genres: [],
  authors: [],
  deathDateRange: { min: 0, max: 2000 }
};

export const useFilters = (): UseFiltersReturn => {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [availableGenres, setAvailableGenres] = useState<string[]>([]);
  const [isLoadingGenres, setIsLoadingGenres] = useState<boolean>(false);
  const [searchedAuthors, setSearchedAuthors] = useState<Author[]>([]);
  const [isSearchingAuthors, setIsSearchingAuthors] = useState<boolean>(false);
  
  // Load available genres on mount
  useEffect(() => {
    const loadGenres = async () => {
      setIsLoadingGenres(true);
      try {
        const genres = await getAvailableGenres();
        setAvailableGenres(genres);
      } catch (error) {
        console.error('Failed to load genres:', error);
      } finally {
        setIsLoadingGenres(false);
      }
    };
    
    loadGenres();
  }, []);
  
  // Search authors by name
  const searchAuthorsByName = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchedAuthors([]);
      return;
    }
    
    setIsSearchingAuthors(true);
    try {
      const authors = await searchAuthors(query);
      setSearchedAuthors(authors);
    } catch (error) {
      console.error('Failed to search authors:', error);
    } finally {
      setIsSearchingAuthors(false);
    }
  }, []);
  
  // Update genre filters
  const updateGenreFilters = useCallback((genres: string[]) => {
    setFilters(prev => ({
      ...prev,
      genres
    }));
  }, []);
  
  // Update author filters
  const updateAuthorFilters = useCallback((authors: number[]) => {
    setFilters(prev => ({
      ...prev,
      authors
    }));
  }, []);
  
  // Update death date range
  const updateDeathDateRange = useCallback((min: number, max: number) => {
    setFilters(prev => ({
      ...prev,
      deathDateRange: { min, max }
    }));
  }, []);
  
  // Reset filters
  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);
  
  return {
    filters,
    setFilters,
    availableGenres,
    isLoadingGenres,
    searchedAuthors,
    isSearchingAuthors,
    searchAuthorsByName,
    updateGenreFilters,
    updateAuthorFilters,
    updateDeathDateRange,
    resetFilters
  };
};