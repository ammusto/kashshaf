import React, { useState } from 'react';
import { FilterState } from '../../types';
import { getAllResultsForExport } from '../../services/opensearch';
import { exportResultsAsCsv, exportResultsAsXlsx } from '../../utils/exportData';
import { useSearch } from '../../contexts/SearchContext';

interface DownloadButtonProps {
  query: string;
  filters: FilterState;
  totalResults: number;
}

const DownloadButton: React.FC<DownloadButtonProps> = ({
  query,
  filters,
  totalResults
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { getFilteredTextIds } = useSearch();
  
  // Handle export
  const handleExport = async (format: 'csv' | 'xlsx') => {
    setIsExporting(true);
    setIsMenuOpen(false);
    
    try {
      // Get filtered text IDs
      const textIds = getFilteredTextIds();
      
      // Get all results (up to the export limit)
      const allResults = await getAllResultsForExport(query, textIds);
      
      // Export based on format
      if (format === 'csv') {
        exportResultsAsCsv(allResults, query);
      } else {
        exportResultsAsXlsx(allResults, query);
      }
    } catch (error) {
      console.error('Failed to export results:', error);
      alert('Download failed');
    } finally {
      setIsExporting(false);
    }
  };
  
  // Toggle dropdown menu
  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };
  
  return (
    <div className="relative">
      <button
        onClick={toggleMenu}
        disabled={isExporting || totalResults === 0}
        className={`
          inline-flex items-center px-4 py-2 border border-transparent font-medium rounded-md shadow-sm
          ${
            isExporting || totalResults === 0
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-gray-600 text-white hover:bg-gray-400'
          }
        `}
      >
        {isExporting ? (
          <>
            <svg
              className="animate-spin -ml-1 mr-2 h-5 w-5 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            Downloading...
          </>
        ) : (
          <>
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
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Download Results
          </>
        )}
      </button>
      
      {isMenuOpen && (
        <div className="absolute left-0 mt-2 w-48 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-10">
          <div className="py-1" role="menu" aria-orientation="vertical">
            <button
              onClick={() => handleExport('csv')}
              className="w-full text-right px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              role="menuitem"
            >
              CSV
            </button>
            <button
              onClick={() => handleExport('xlsx')}
              className="w-full text-right px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              role="menuitem"
            >
              Excel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DownloadButton;