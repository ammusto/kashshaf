import type { SearchResults, SearchResult } from '../../types';
import { VirtualizedResultsList } from '../shared/VirtualizedResultsList';

interface ConcordancePanelProps {
  results: SearchResults | null;
  onResultClick: (result: SearchResult) => void;
  onLoadMore: () => void;
  loading: boolean;
  loadingMore: boolean;
  errorMessage: string;
  maxResults: number;
}

export function ConcordancePanel({
  results,
  onResultClick,
  onLoadMore,
  loading,
  loadingMore,
  errorMessage,
  maxResults,
}: ConcordancePanelProps) {
  return (
    <div className="h-full flex flex-col bg-app-surface border-t-2 border-app-border-light">
      <div className="h-10 bg-app-surface-variant px-6 flex items-center flex-shrink-0 border-b border-app-border-light">
        <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Concordance</span>
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
