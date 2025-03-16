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
    searchError,
    handlePageChange,
    handleRowsPerPageChange,
    resetSearch
  } = useSearch();

  // If there's a search error, display it
  if (searchError) {
    return (
      <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-6 rounded-lg shadow-md">
        <div className="flex items-center">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <p className="text-lg font-medium">Search Error</p>
            <p className="text-base">{searchError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (results.length === 0 && !isLoading) {
    // If there's a search query but no results, show "no results" message
    if (searchQuery) {
      return (
        <div className="bg-white rounded-lg shadow-md p-6 text-center">
          <p className="text-lg">No results for {searchQuery}"</p>
          <button
            onClick={resetSearch}
            className="mt-4 inline-flex items-center px-4 py-2 border border-transparent font-medium rounded-md shadow-sm bg-gray-200 text-gray-800 hover:bg-gray-300"
          >
            <svg
              className="-ml-1 mr-2 h-5 w-5"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            Reset Search
          </button>
        </div>
      );
    }
    // Otherwise, don't render anything
    return null;
  }

  // Determine the display of total results
  const displayResults = totalResults > MAX_RESULT_WINDOW 
    ? MAX_RESULT_WINDOW 
    : totalResults;

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">
          {totalResults > MAX_RESULT_WINDOW 
            ? `Displaying ${displayResults} of ${totalResults} Results for "${searchQuery}"` 
            : `${totalResults} Results for "${searchQuery}"`}
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
          
          <button
            onClick={resetSearch}
            className="inline-flex items-center px-4 py-2 border border-transparent font-medium rounded-md shadow-sm bg-gray-200 text-gray-800 hover:bg-gray-300">
            <svg
              className="-ml-1 mr-2 h-5 w-5"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            Clear Search
          </button>
          
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