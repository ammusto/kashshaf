import { useState, useRef, useEffect, useCallback } from 'react';
import type { SearchResults, SearchResult } from '../../types';
import { EXPORT_MAX_RESULTS } from '../../constants/search';
import { VirtualizedResultsList } from '../shared/VirtualizedResultsList';
import { exportSearchResults, type ExportFormat } from '../../utils/exportData';
import { useBooks } from '../../contexts/BooksContext';

interface ResultsPanelProps {
  results: SearchResults | null;
  onResultClick: (result: SearchResult) => void;
  onLoadMore: () => void;
  onExport: () => Promise<SearchResult[]>;
  loading: boolean;
  loadingMore: boolean;
  errorMessage: string;
  maxResults: number;
}

export function ResultsPanel({
  results,
  onResultClick,
  onLoadMore,
  onExport,
  loading,
  loadingMore,
  errorMessage,
  maxResults,
}: ResultsPanelProps) {
  const { booksMap, authorsMap, genresMap } = useBooks();
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(event.target as Node)) {
        setExportDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleExport = useCallback(async (format: ExportFormat) => {
    setExportDropdownOpen(false);
    if (!results || results.total_hits === 0) return;

    setExporting(true);
    try {
      const exportResults = await onExport();
      await exportSearchResults(exportResults, format, booksMap, authorsMap, genresMap);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [results, onExport, booksMap, authorsMap, genresMap]);

  const hasResults = results && results.results.length > 0;
  const exportCount = results ? Math.min(results.total_hits, EXPORT_MAX_RESULTS) : 0;

  return (
    <div className="h-full flex flex-col bg-app-surface border-t-2 border-app-border-light">
      <div className="h-10 bg-app-surface-variant px-6 flex items-center flex-shrink-0 border-b border-app-border-light">
        <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Results</span>

        {/* Export Button */}
        {hasResults && (
          <div className="relative ml-4" ref={exportDropdownRef}>
            <button
              onClick={() => !exporting && setExportDropdownOpen(!exportDropdownOpen)}
              disabled={exporting}
              className={`h-6 px-2 text-xs font-medium rounded bg-white border border-app-border-medium
                       transition-colors flex items-center gap-1
                       ${exporting
                         ? 'text-app-text-tertiary cursor-wait'
                         : 'text-app-text-secondary hover:text-app-accent hover:border-app-accent'}`}
            >
              {exporting ? (
                <div className="animate-spin rounded-full h-3 w-3 border-b border-app-accent"></div>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              )}
              {exporting ? 'Exporting...' : `Export (${exportCount.toLocaleString()})`}
              {!exporting && (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </button>
            {exportDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 bg-white border border-app-border-medium rounded-lg shadow-lg z-20 min-w-[140px] overflow-hidden">
                <button
                  onClick={() => handleExport('csv')}
                  className="w-full px-3 py-2 text-left text-xs text-app-text-primary hover:bg-app-surface-variant flex items-center gap-2"
                >
                  <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export as CSV
                </button>
                <button
                  onClick={() => handleExport('xlsx')}
                  className="w-full px-3 py-2 text-left text-xs text-app-text-primary hover:bg-app-surface-variant flex items-center gap-2"
                >
                  <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                  </svg>
                  Export as Excel
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />
        <span className={`text-xs ${results && results.total_hits > 0 ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary'}`}>
          {results && results.total_hits > 0
            ? `${results.results.length.toLocaleString()} / ${results.total_hits.toLocaleString()} · ${results.elapsed_ms}ms`
            : ''}
        </span>
      </div>

      {errorMessage && (
        <div className="h-10 bg-red-50 px-5 flex items-center flex-shrink-0">
          <span className="text-xs text-app-error">{errorMessage}</span>
        </div>
      )}

      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center space-y-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-app-accent"></div>
          <p className="text-xs text-app-text-tertiary">Searching...</p>
        </div>
      )}

      {!loading && results && results.results.length > 0 && (
        <VirtualizedResultsList
          results={results.results}
          onResultClick={onResultClick}
          onLoadMore={onLoadMore}
          loadingMore={loadingMore}
          totalHits={results.total_hits}
          maxResults={maxResults}
        />
      )}

      {!loading && (!results || results.results.length === 0) && (
        <div className="flex-1 flex flex-col items-center justify-center">
          <span className="text-xs text-app-text-tertiary">
            {results ? 'No results found' : 'Enter a search query'}
          </span>
        </div>
      )}
    </div>
  );
}
