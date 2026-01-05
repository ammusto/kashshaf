import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SearchResult } from '../../types';
import { ROW_HEIGHT } from '../../constants/search';
import { SearchResultRow } from './SearchResultRow';

interface VirtualizedResultsListProps {
  results: SearchResult[];
  onResultClick: (result: SearchResult) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  totalHits: number;
  maxResults: number;
}

export function VirtualizedResultsList({
  results,
  onResultClick,
  onLoadMore,
  loadingMore,
  totalHits,
  maxResults,
}: VirtualizedResultsListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      if (distanceFromBottom < 200 && !loadingMore) {
        const hasMore = results.length < totalHits && results.length < maxResults;
        if (hasMore) onLoadMore();
      }
    };

    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [results.length, totalHits, maxResults, loadingMore, onLoadMore]);

  const hasMore = results.length < totalHits && results.length < maxResults;

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div className="sticky top-0 bg-white border-b border-app-border-medium h-8 px-6 flex items-center gap-6 z-10 shadow-sm">
        <div className="w-16 flex-shrink-0 text-center">
          <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Vol:Pg</span>
        </div>
        <div className="flex-1 text-center">
          <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Context</span>
        </div>
        <div className="w-48 flex-shrink-0 text-right">
          <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Title</span>
        </div>
      </div>

      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const result = results[virtualRow.index];
          return (
            <div
              key={`${result.id}-${result.part_index}-${result.page_id}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <SearchResultRow
                result={result}
                onClick={() => onResultClick(result)}
              />
            </div>
          );
        })}
      </div>

      {loadingMore && (
        <div className="h-12 flex items-center justify-center">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-app-accent"></div>
          <span className="ml-2 text-xs text-app-text-tertiary">Loading more...</span>
        </div>
      )}

      {!loadingMore && !hasMore && results.length > 0 && (
        <div className="h-10 flex items-center justify-center">
          <span className="text-xs text-app-text-tertiary">
            {results.length >= maxResults
              ? `Showing ${results.length.toLocaleString()} of ${totalHits.toLocaleString()} (max reached)`
              : `All ${results.length.toLocaleString()} results loaded`}
          </span>
        </div>
      )}
    </div>
  );
}
