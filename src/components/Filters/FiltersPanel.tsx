import React, { useState, useMemo, useCallback, useEffect } from 'react';
import GenreFilter from './GenreFilter';
import DeathDateFilter from './DeathDateFilter';
import AuthorFilter from './AuthorFilter';
import { FilterState, Author } from '../../types';
import { useMetadata } from '../../contexts/MetadataContext';

interface FiltersPanelProps {
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  searchQuery: string;
  rowsPerPage: number;
}

const FiltersPanel: React.FC<FiltersPanelProps> = ({
  filters,
  setFilters,
  onApplyFilters,
  onResetFilters,
  searchQuery,
  rowsPerPage
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { textsMetadata, authorsMetadata } = useMetadata();
  
  // Create a draft state for filters that only gets applied when the button is clicked
  const [draftFilters, setDraftFilters] = useState<FilterState>(filters);
  
  // Update draft filters when props filters change (from URL or parent)
  useEffect(() => {
    console.log('FiltersPanel: props filters changed', JSON.stringify(filters));
    setDraftFilters(filters);
  }, [filters]);
  
  // Extract unique genres from texts metadata - memoized
  const allGenres = useMemo(() => {
    const genres = new Set<string>();
    textsMetadata.forEach(text => {
      if (text.tags) {
        text.tags.forEach(tag => genres.add(tag));
      }
    });
    return Array.from(genres).sort();
  }, [textsMetadata]);
  
  // Get min and max death dates from authors metadata - memoized
  const deathDateRange = useMemo(() => {
    let min = 3000;
    let max = 0;
    
    authorsMetadata.forEach(author => {
      if (author.death_date) {
        min = Math.min(min, author.death_date);
        max = Math.max(max, author.death_date);
      }
    });
    
    if (min === 3000) min = 0;
    if (max === 0) max = 2000;
    
    return { min, max };
  }, [authorsMetadata]);
  
  // Selected authors data - memoized
  const selectedAuthors = useMemo(() => {
    return draftFilters.authors
      .map(authorId => authorsMetadata.get(authorId))
      .filter((author): author is Author => author !== undefined);
  }, [draftFilters.authors, authorsMetadata]);
  
  // Update genre filters in draft - memoized callback
  const handleGenreChange = useCallback((genres: string[]) => {
    console.log('FiltersPanel: genre change', genres);
    setDraftFilters(prev => ({
      ...prev,
      genres
    }));
  }, []);
  
  // Update author filters in draft - memoized callback
  const handleAuthorChange = useCallback((authors: number[]) => {
    console.log('FiltersPanel: author change', authors);
    setDraftFilters(prev => ({
      ...prev,
      authors
    }));
  }, []);
  
  // Update death date range in draft - memoized callback
  const handleDeathDateChange = useCallback((min: number, max: number) => {
    console.log(`FiltersPanel: death date change min=${min}, max=${max}`);
    setDraftFilters(prev => ({
      ...prev,
      deathDateRange: { min, max }
    }));
  }, []);
  
  // Very direct approach to update URL manually
  const handleApplyFilters = useCallback(() => {
    console.log('FiltersPanel: applying filters DIRECTLY', JSON.stringify(draftFilters));
    
    // Update parent's filters first
    setFilters(draftFilters);
    
    // Build URL parameters
    let url = window.location.pathname + '?';
    
    // Add search query
    if (searchQuery) {
      url += `q=${encodeURIComponent(searchQuery)}`;
    }
    
    // Add page
    url += `&page=1`;
    
    // Add rows per page
    url += `&rows=${rowsPerPage}`;
    
    // Add genres if any
    if (draftFilters.genres.length > 0) {
      url += `&genres=${draftFilters.genres.map(genre => encodeURIComponent(genre)).join(',')}`;
    }
    
    // Add authors if any
    if (draftFilters.authors.length > 0) {
      url += `&authors=${draftFilters.authors.join(',')}`;
    }
    
    // Add death date range if different from default
    if (draftFilters.deathDateRange.min > 0) {
      url += `&death_min=${draftFilters.deathDateRange.min}`;
    }
    
    if (draftFilters.deathDateRange.max < 2000) {
      url += `&death_max=${draftFilters.deathDateRange.max}`;
    }
    
    console.log('DIRECT URL UPDATE to:', url);
    
    // Update URL directly (will cause page reload)
    window.location.href = url;
    
  }, [draftFilters, setFilters, searchQuery, rowsPerPage]);
  
  // Handle reset with direct URL update
  const handleResetFilters = useCallback(() => {
    console.log('FiltersPanel: resetting filters DIRECTLY');
    
    // Update state
    const defaultFilters: FilterState = {
      genres: [],
      authors: [],
      deathDateRange: { min: 0, max: 2000 }
    };
    
    setDraftFilters(defaultFilters);
    setFilters(defaultFilters);
    
    // Build URL without filters
    let url = window.location.pathname + '?';
    
    // Add search query
    if (searchQuery) {
      url += `q=${encodeURIComponent(searchQuery)}`;
    }
    
    // Add page and rows
    url += `&page=1&rows=${rowsPerPage}`;
    
    console.log('DIRECT URL UPDATE to:', url);
    
    // Update URL directly (will cause page reload)
    window.location.href = url;
    
  }, [setFilters, searchQuery, rowsPerPage]);
  
  // Are there any active filters in the draft?
  const hasActiveFilters = 
    draftFilters.genres.length > 0 || 
    draftFilters.authors.length > 0 || 
    (draftFilters.deathDateRange.min > deathDateRange.min || 
     draftFilters.deathDateRange.max < deathDateRange.max);
  
  // Are draft filters different from current filters?
  const hasUnappliedChanges = useMemo(() => {
    const isDifferent = (
      JSON.stringify(draftFilters.genres) !== JSON.stringify(filters.genres) ||
      JSON.stringify(draftFilters.authors) !== JSON.stringify(filters.authors) ||
      draftFilters.deathDateRange.min !== filters.deathDateRange.min ||
      draftFilters.deathDateRange.max !== filters.deathDateRange.max
    );
    console.log(`FiltersPanel: hasUnappliedChanges = ${isDifferent}`);
    return isDifferent;
  }, [draftFilters, filters]);
  
  return (
    <div className="mt-4 border rounded-lg p-4">
      <div className="flex justify-between items-center mb-4">
        <button
          className="flex items-center font-medium text-gray-700 focus:outline-none"
          onClick={() => setIsExpanded(!isExpanded)}
          type="button"
        >
          <span className="ml-2">
            {isExpanded ? (
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="20" 
                height="20" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                <polyline points="18 15 12 9 6 15"></polyline>
              </svg>
            ) : (
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="20" 
                height="20" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            )}
          </span>
          <h3 className="text-lg font-semibold">
            تصفية النتائج
            {hasActiveFilters && (
              <span className="mr-2 bg-indigo-100 text-indigo-800 text-xs font-semibold px-2.5 py-0.5 rounded">
                فلاتر نشطة
              </span>
            )}
            {hasUnappliedChanges && (
              <span className="mr-2 bg-yellow-100 text-yellow-800 text-xs font-semibold px-2.5 py-0.5 rounded">
                تغييرات غير مطبقة
              </span>
            )}
          </h3>
        </button>
        
        <div className="flex gap-2">
          <button
            className={`px-4 py-2 rounded ${
              hasUnappliedChanges
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-300 text-gray-600'
            }`}
            onClick={handleApplyFilters}
            disabled={!hasUnappliedChanges}
            type="button"
          >
            تطبيق الفلاتر
          </button>
          
          {hasActiveFilters && (
            <button
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              onClick={handleResetFilters}
              type="button"
            >
              إعادة ضبط
            </button>
          )}
        </div>
      </div>
      
      {isExpanded && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <GenreFilter
            allGenres={allGenres}
            selectedGenres={draftFilters.genres}
            onChange={handleGenreChange}
          />
          
          <DeathDateFilter
            range={deathDateRange}
            value={draftFilters.deathDateRange}
            onChange={handleDeathDateChange}
          />
          
          <AuthorFilter
            selectedAuthors={selectedAuthors}
            onAuthorChange={handleAuthorChange}
            authorsMetadata={authorsMetadata}
          />
        </div>
      )}
    </div>
  );
};

export default React.memo(FiltersPanel);