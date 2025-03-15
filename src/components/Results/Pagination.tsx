import React from 'react';

interface PaginationProps {
  currentPage: number;
  totalResults: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
}

const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalResults,
  rowsPerPage,
  onPageChange
}) => {
  // Calculate total pages
  const totalPages = Math.ceil(totalResults / rowsPerPage);
  
  // Don't show pagination if there's only one page
  if (totalPages <= 1) {
    return null;
  }
  
  // Generate page numbers to display
  const getPageNumbers = () => {
    const pages = [];
    
    // Always show first page
    pages.push(1);
    
    // Calculate range around current page
    let rangeStart = Math.max(2, currentPage - 2);
    let rangeEnd = Math.min(totalPages - 1, currentPage + 2);
    
    // Adjust range to always show 5 pages if possible
    if (rangeEnd - rangeStart < 4 && totalPages > 5) {
      if (currentPage < totalPages / 2) {
        // Near the beginning
        rangeEnd = Math.min(rangeStart + 4, totalPages - 1);
      } else {
        // Near the end
        rangeStart = Math.max(rangeEnd - 4, 2);
      }
    }
    
    // Add ellipsis after first page if needed
    if (rangeStart > 2) {
      pages.push('ellipsis-start');
    }
    
    // Add pages in range
    for (let i = rangeStart; i <= rangeEnd; i++) {
      pages.push(i);
    }
    
    // Add ellipsis before last page if needed
    if (rangeEnd < totalPages - 1) {
      pages.push('ellipsis-end');
    }
    
    // Always show last page if more than one page
    if (totalPages > 1) {
      pages.push(totalPages);
    }
    
    return pages;
  };
  
  const pageNumbers = getPageNumbers();
  
  // Handle page change with logging to help debug
  const handlePageChange = (page: number) => {
    onPageChange(page);
  };
  
  return (
    <div className="flex items-center justify-between bg-white py-6">
      <div className="flex-1 flex justify-between items-center">
        <button
          onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className={`relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md ${
            currentPage === 1
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          Previous
        </button>
        
        <div className="hidden md:flex">
          {pageNumbers.map((page, index) => {
            if (page === 'ellipsis-start' || page === 'ellipsis-end') {
              return (
                <span
                  key={`ellipsis-${index}`}
                  className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700"
                >
                  ...
                </span>
              );
            }
            
            const isCurrentPage = currentPage === page;
            
            return (
              <button
                key={`page-${page}`}
                onClick={() => handlePageChange(page as number)}
                className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium mx-1 ${
                  isCurrentPage
                    ? 'z-10 bg-gray-50 border-gray-800 text-gray-900'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                aria-current={isCurrentPage ? 'page' : undefined}
              >
                {page}
              </button>
            );
          })}
        </div>
        

        
        <button
          onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className={`relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md ${
            currentPage === totalPages
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default Pagination;