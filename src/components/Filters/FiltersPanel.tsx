import React, { useState, useMemo } from 'react';
import GenreFilter from './GenreFilter';
import DeathDateFilter from './DeathDateFilter';
import AuthorFilter from './AuthorFilter';
import { FilterState, Author } from '../../types';
import { useMetadata } from '../../contexts/MetadataContext';

// Updated props interface - removed textsMetadata and authorsMetadata as they'll come from context
interface FiltersPanelProps {
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
}

const FiltersPanel: React.FC<FiltersPanelProps> = ({
  filters,
  setFilters,
  onApplyFilters,
  onResetFilters
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  // Use metadata from context instead of props
  const { textsMetadata, authorsMetadata } = useMetadata();
  
  // Extract unique genres from texts metadata
  const allGenres = useMemo(() => {
    const genres = new Set<string>();
    textsMetadata.forEach(text => {
      if (text.tags) {
        text.tags.forEach(tag => genres.add(tag));
      }
    });
    return Array.from(genres).sort();
  }, [textsMetadata]);
  
  // Get min and max death dates from authors metadata
  const deathDateRange = useMemo(() => {
    let min = 3000;
    let max = 0;
    
    authorsMetadata.forEach(author => {
      if (author.death_date) {
        min = Math.min(min, author.death_date);
        max = Math.max(max, author.death_date);
      }
    });
    
    return { min, max };
  }, [authorsMetadata]);
  
  // Selected authors data - explicitly cast as Author[] after filtering out undefined values
  const selectedAuthors = useMemo(() => {
    return filters.authors
      .map(authorId => authorsMetadata.get(authorId))
      .filter((author): author is Author => author !== undefined);
  }, [filters.authors, authorsMetadata]);
  
  // Update genre filters
  const handleGenreChange = (genres: string[]) => {
    const updatedFilters: FilterState = {
      ...filters,
      genres
    };
    setFilters(updatedFilters);
  };
  
  // Update author filters
  const handleAuthorChange = (authors: number[]) => {
    const updatedFilters: FilterState = {
      ...filters,
      authors
    };
    setFilters(updatedFilters);
  };
  
  // Update death date range
  const handleDeathDateChange = (min: number, max: number) => {
    const updatedFilters: FilterState = {
      ...filters,
      deathDateRange: { min, max }
    };
    setFilters(updatedFilters);
  };
  
  // Are there any active filters?
  const hasActiveFilters = 
    filters.genres.length > 0 || 
    filters.authors.length > 0 || 
    (filters.deathDateRange.min > deathDateRange.min || 
     filters.deathDateRange.max < deathDateRange.max);
  
  return (
    <div className="mt-4 border rounded-lg p-4">
      <div className="flex justify-between items-center mb-4">
        <button
          className="flex items-center font-medium text-gray-700 focus:outline-none"
          onClick={() => setIsExpanded(!isExpanded)}
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
          </h3>
        </button>
        
        <div className="flex gap-2">
          <button
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
            onClick={onApplyFilters}
          >
            تطبيق الفلاتر
          </button>
          
          {hasActiveFilters && (
            <button
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              onClick={onResetFilters}
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
            selectedGenres={filters.genres}
            onChange={handleGenreChange}
          />
          
          <DeathDateFilter
            range={deathDateRange}
            value={filters.deathDateRange}
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

export default FiltersPanel;