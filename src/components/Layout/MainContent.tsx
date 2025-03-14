import React from 'react';
import { useMetadata } from '../../contexts/MetadataContext';
import SearchBar from '../SearchBar';
import FiltersPanel from '../Filters/FiltersPanel';
import SearchResults from '../Results/SearchResults';
import { useSearch } from '../../contexts/SearchContext';
import '../Results/results.css';

const MainContent: React.FC = () => {
  const { isLoading: metadataLoading, error: metadataError } = useMetadata();
  const { 
    searchQuery, 
    isLoading: searchLoading, 
    handleSearch, 
    filters, 
    setFilters, 
    applyFilters, 
    resetFilters,
    rowsPerPage
  } = useSearch();

  return (
    <main className="flex-grow container mx-auto px-4 py-6">
      {/* Metadata Loading/Error State */}
      {metadataLoading && (
        <div className="bg-white rounded-lg shadow-md p-6 mb-6 text-center">
          <div className="animate-pulse mb-4">
            <div className="h-8 bg-gray-300 rounded w-1/3 mx-auto"></div>
            <div className="h-4 bg-gray-300 rounded w-1/2 mx-auto mt-4"></div>
          </div>
          <p className="text-gray-700">Loading metadata...</p>
        </div>
      )}
      
      {metadataError && (
        <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6" role="alert">
          <p className="font-bold">Error downloading metadata.</p>
          <p>{metadataError}</p>
        </div>
      )}
      
      {!metadataLoading && !metadataError && (
        <>
          <div className="bg-white rounded-lg shadow-md p-6 mb-6">
            <SearchBar
              query={searchQuery}
              onSearch={handleSearch}
              isLoading={searchLoading}
            />
            
            <FiltersPanel
              filters={filters}
              setFilters={setFilters}
              onApplyFilters={applyFilters}
              onResetFilters={resetFilters}
              searchQuery={searchQuery}
              rowsPerPage={rowsPerPage}
            />
          </div>
          
          <div className="search-results-table">
            <SearchResults />
          </div>
        </>
      )}
    </main>
  );
};

export default MainContent;