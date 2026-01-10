import { useState, useEffect } from 'react';
import type { SearchHistoryEntry } from '../../types';
import { getSearchHistory, saveSearch, unsaveSearchByQuery, clearHistory } from '../../utils/storage';

interface SearchHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadSearch: (entry: SearchHistoryEntry) => void;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function getSearchTypeBadge(searchType: string): { label: string; color: string } {
  switch (searchType) {
    case 'boolean':
      return { label: 'Boolean', color: 'bg-blue-100 text-blue-700' };
    case 'proximity':
      return { label: 'Proximity', color: 'bg-purple-100 text-purple-700' };
    case 'name':
      return { label: 'Name', color: 'bg-green-100 text-green-700' };
    case 'wildcard':
      return { label: 'Wildcard', color: 'bg-orange-100 text-orange-700' };
    default:
      return { label: searchType, color: 'bg-gray-100 text-gray-700' };
  }
}

export function SearchHistoryModal({ isOpen, onClose, onLoadSearch }: SearchHistoryModalProps) {
  const [entries, setEntries] = useState<SearchHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadHistory();
    }
  }, [isOpen]);

  async function loadHistory() {
    try {
      setLoading(true);
      setError(null);
      const results = await getSearchHistory(100);
      setEntries(results);
    } catch (err) {
      setError(`Failed to load search history: ${err}`);
      console.error('Failed to load search history:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleSave(entry: SearchHistoryEntry, e: React.MouseEvent) {
    e.stopPropagation();

    // Optimistically update the UI immediately
    const newIsSaved = !entry.is_saved;
    setEntries(prev => prev.map(e =>
      e.id === entry.id ? { ...e, is_saved: newIsSaved } : e
    ));

    try {
      if (entry.is_saved) {
        // Unsave the search
        await unsaveSearchByQuery(entry.query_data);
      } else {
        // Save the search
        await saveSearch(
          entry.id,
          entry.search_type,
          entry.query_data,
          entry.display_label,
          entry.book_filter_count,
          entry.book_ids || null
        );
      }
    } catch (err) {
      // Revert on error
      setEntries(prev => prev.map(e =>
        e.id === entry.id ? { ...e, is_saved: entry.is_saved } : e
      ));
      console.error('Failed to toggle save:', err);
    }
  }

  async function handleClearHistory() {
    if (!confirm('Are you sure you want to clear all search history? Saved searches will not be affected.')) {
      return;
    }
    try {
      await clearHistory();
      await loadHistory();
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  }

  function handleLoad(entry: SearchHistoryEntry) {
    onLoadSearch(entry);
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">Search History</h2>
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Clear All
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors"
            >
              <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-app-accent"></div>
            </div>
          )}

          {error && (
            <div className="text-red-500 text-center py-8">{error}</div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="text-app-text-secondary text-center py-8">
              No search history yet. Your searches will appear here automatically.
            </div>
          )}

          {!loading && !error && entries.length > 0 && (
            <div className="space-y-2">
              {entries.map(entry => {
                const badge = getSearchTypeBadge(entry.search_type);
                return (
                  <div
                    key={entry.id}
                    className="group flex items-center gap-3 p-3 rounded-lg bg-app-surface-variant
                               hover:bg-app-accent-light cursor-pointer transition-colors"
                    onClick={() => handleLoad(entry)}
                  >
                    {/* Star button */}
                    <button
                      onClick={(e) => handleToggleSave(entry, e)}
                      className={`p-1.5 rounded-md transition-colors flex-shrink-0
                                  ${entry.is_saved
                                    ? 'text-yellow-500 hover:text-yellow-600'
                                    : 'text-app-text-tertiary hover:text-yellow-500'}`}
                      title={entry.is_saved ? 'Remove from saved' : 'Save this search'}
                    >
                      {entry.is_saved ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                        </svg>
                      )}
                    </button>

                    {/* Main content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 justify-end">
                        {/* Display label */}
                        <span className="font-arabic text-2xl text-app-text-primary truncate" dir="rtl">
                          {entry.display_label}
                        </span>
                        {/* Search type badge */}
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.color}`}>
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-app-text-tertiary justify-end">
                        {/* Book filter info */}
                        <span>
                          {entry.book_filter_count > 0
                            ? `${entry.book_filter_count} texts`
                            : 'All texts'}
                        </span>
                        {/* Created time */}
                        <span>{formatRelativeTime(entry.created_at)}</span>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light">
          <p className="text-xs text-app-text-tertiary text-center">
            Click to load a search. Star to save it permanently. History keeps the last 100 searches.
          </p>
        </div>
      </div>
    </div>
  );
}
