import React from 'react';
import { useSearch } from '../../contexts/SearchContext';
import ResultsTable from './ResultsTable';
import Pagination from './Pagination';
import DownloadButton from './DownloadButton';

const SearchResults: React.FC = () => {
  const {
    searchQuery,
    results,
    isLoading,
    totalResults,
    currentPage,
    rowsPerPage,
    filters,
    handlePageChange,
    handleRowsPerPageChange
  } = useSearch();

  if (results.length === 0 && !isLoading) {
    // If there's a search query but no results, show "no results" message
    if (searchQuery) {
      return (
        <div className="bg-white rounded-lg shadow-md p-6 text-center">
          <p className="text-lg">لا توجد نتائج لـ "{searchQuery}"</p>
        </div>
      );
    }
    // Otherwise, don't render anything
    return null;
  }

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">
          {totalResults} Results for "{searchQuery}"
        </h2>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center">
            <label htmlFor="rows-select" className="mr-2">
              Show:
            </label>
            <select
              id="rows-select"
              value={rowsPerPage}
              onChange={(e) => handleRowsPerPageChange(Number(e.target.value))}
              className="border border-gray-300 rounded px-2 py-1"
            >
              {[50, 75, 100].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          
          <DownloadButton
            query={searchQuery}
            filters={filters}
            totalResults={totalResults}
          />
        </div>
      </div>
      
      <ResultsTable
        results={results}
        isLoading={isLoading}
      />
      
      <Pagination
        currentPage={currentPage}
        totalResults={totalResults}
        rowsPerPage={rowsPerPage}
        onPageChange={handlePageChange}
      />
    </div>
  );
};

export default SearchResults;