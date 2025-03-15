import React from 'react';
import { useSearch } from '../../contexts/SearchContext';
import ResultsTable from './ResultsTable';
import Pagination from './Pagination';
import DownloadButton from './DownloadButton';
import { MAX_RESULT_WINDOW } from '../../config/api';

const SearchResults: React.FC = () => {
  const {
    searchQuery,
    results,
    isLoading,
    totalResults,
    currentPage,
    rowsPerPage,
    filters,
    isExactSearch,
    handlePageChange,
    handleRowsPerPageChange
  } = useSearch();

  // Format number with commas
  const formatNumber = (num: number): string => {
    return new Intl.NumberFormat().format(num);
  };

  // Get the count text based on whether we're displaying all results or hitting the limit
  const getResultCountText = () => {
    if (totalResults <= MAX_RESULT_WINDOW) {
      return `${formatNumber(totalResults)} Results for "${searchQuery}"`;
    } else {
      return `Showing ${formatNumber(MAX_RESULT_WINDOW)} of ${formatNumber(totalResults)} Results for "${searchQuery}"`;
    }
  };

  if (results.length === 0 && !isLoading) {
    // If there's a search query but no results, show "no results" message
    if (searchQuery) {
      return (
        <div className="bg-white rounded-lg shadow-md p-6 text-center">
          <p className="text-lg">لا توجد نتائج لـ "{searchQuery}"</p>
          {isExactSearch && (
            <p className="text-sm text-gray-500 mt-2">
              You are using exact search mode. Try disabling the "E" option to include proclitics.
            </p>
          )}
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
          {getResultCountText()}
          {isExactSearch && (
            <span className="text-sm text-gray-600 ml-2">(Exact search)</span>
          )}
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
        totalResults={Math.min(totalResults, MAX_RESULT_WINDOW)}
        rowsPerPage={rowsPerPage}
        onPageChange={handlePageChange}
      />
    </div>
  );
};

export default SearchResults;