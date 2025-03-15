import React, { useState, useMemo, useCallback, useEffect } from 'react';
import GenreFilter from './GenreFilter';
import DeathDateFilter from './DeathDateFilter';
import AuthorFilter from './AuthorFilter';
import { FilterState, Author } from '../../types';
import { useMetadata } from '../../contexts/MetadataContext';
import { useSearch } from '../../contexts/SearchContext';

const FiltersPanel: React.FC = () => {
  const { filters, applyFilters, resetFilters, searchQuery } = useSearch();
  const [isExpanded, setIsExpanded] = useState(false);
  const { textsMetadata, authorsMetadata } = useMetadata();

  // Create a draft state for filters that only gets applied when the button is clicked
  const [draftFilters, setDraftFilters] = useState<FilterState>(filters);

  // Update draft filters when props filters change (from URL or context)
  useEffect(() => {
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
    setDraftFilters(prev => ({
      ...prev,
      genres
    }));
  }, []);

  // Update author filters in draft - memoized callback
  const handleAuthorChange = useCallback((authors: number[]) => {
    setDraftFilters(prev => ({
      ...prev,
      authors
    }));
  }, []);

  // Update death date range in draft - memoized callback
  const handleDeathDateChange = useCallback((min: number, max: number) => {
    setDraftFilters(prev => ({
      ...prev,
      deathDateRange: { min, max }
    }));
  }, []);

  // Handle applying filters
  const handleApplyFilters = useCallback(() => {
    applyFilters(draftFilters);
  }, [draftFilters, applyFilters]);

  // Handle resetting filters
  const handleResetFilters = useCallback(() => {
    resetFilters();
  }, [resetFilters]);

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
    return isDifferent;
  }, [draftFilters, filters]);

  return (
    <div className="mt-4 border rounded-lg p-4">
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-2">
          {isExpanded && (
            <>
              <button
                className={`px-4 py-2 rounded ${hasUnappliedChanges
                  ? 'bg-gray-600 text-white hover:bg-gray-400'
                  : 'bg-gray-300 text-gray-600'
                  }`}
                onClick={handleApplyFilters}
                disabled={!hasUnappliedChanges || !searchQuery}
                type="button"
              >
                Apply Filters
              </button>

              {hasActiveFilters && (
                <button
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                  onClick={handleResetFilters}
                  disabled={!searchQuery}
                  type="button"
                >
                  Reset
                </button>
              )}
            </>
          )}
        </div>
        <button
          className="flex items-center font-medium text-gray-700 focus:outline-none"
          onClick={() => setIsExpanded(!isExpanded)}
          type="button"
        >

          <h3 className="text-lg font-semibold">
            {hasActiveFilters && (
              <span className="mx-1 bg-indigo-100 text-indigo-800 text-xs font-semibold px-2.5 py-0.5 rounded">
                Filters active
              </span>
            )}
            {hasUnappliedChanges && (
              <span className="mx-1 bg-yellow-100 text-yellow-800 text-xs font-semibold px-2.5 py-0.5 rounded">
                Unapplied changes
              </span>
            )}
            Filtered search

          </h3>
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
        </button>


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