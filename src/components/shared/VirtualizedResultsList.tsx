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
  /** totalHits is a lower bound (the walk may still yield more rows). */
  wasCapped?: boolean;
  /** A load-more came back empty: nothing more to fetch. */
  loadedAll?: boolean;
  maxResults: number;
}

export function VirtualizedResultsList({
  results,
  onResultClick,
  onLoadMore,
  loadingMore,
  totalHits,
  wasCapped = false,
  loadedAll = false,
  maxResults,
}: VirtualizedResultsListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const hasMore = !loadedAll && (results.length < totalHits || wasCapped) && results.length < maxResults;

  // Reaching the foot of the list loads the next page. A sentinel rather than
  // a scroll threshold: it fires when the foot comes into view however it got
  // there, including when the results are shorter than the panel and no
  // scroll event is ever sent. Pages after the first come from the walk's
  // prefix cache, so this is usually instant.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = parentRef.current;
    if (!sentinel || !root || !hasMore || loadingMore) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: '200px 0px' }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, loadingMore, results.length]);

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

      {/* The foot of the list. Crossing it loads the next page; the button is
          there for when that does not happen — a trackpad fling that never
          settles, a browser without IntersectionObserver, a load that failed
          and left the list where it was. */}
      <div ref={sentinelRef} aria-hidden />

      {loadingMore && (
        <div className="h-12 flex items-center justify-center">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-app-accent"></div>
          <span className="ml-2 text-xs text-app-text-tertiary">Loading more...</span>
        </div>
      )}

      {!loadingMore && hasMore && (
        <div className="h-12 flex items-center justify-center">
          <button
            onClick={onLoadMore}
            className="px-3 py-1 text-xs font-medium rounded border border-app-border-medium
                       text-app-text-secondary hover:text-app-accent hover:border-app-accent
                       transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {!loadingMore && !hasMore && results.length > 0 && (
        <div className="h-10 flex items-center justify-center">
          <span className="text-xs text-app-text-tertiary">
            {results.length >= maxResults
              ? `Showing ${results.length.toLocaleString()} of ${totalHits.toLocaleString()}${wasCapped ? '+' : ''} (max reached)`
              : wasCapped
                ? `Showing the first ${results.length.toLocaleString()} verified pages (count is a lower bound)`
                : `All ${results.length.toLocaleString()} results loaded`}
          </span>
        </div>
      )}
    </div>
  );
}
