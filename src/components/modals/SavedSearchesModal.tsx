import { useState, useEffect } from 'react';
import type { SavedSearchEntry } from '../../types';
import { getSavedSearches, unsaveSearch } from '../../utils/storage';

interface SavedSearchesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadSearch: (search: SavedSearchEntry) => void;
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
    case 'concordance':
      return { label: 'Concordance', color: 'bg-teal-100 text-teal-700' };
    default:
      return { label: searchType, color: 'bg-gray-100 text-gray-700' };
  }
}

export function SavedSearchesModal({ isOpen, onClose, onLoadSearch }: SavedSearchesModalProps) {
  const [searches, setSearches] = useState<SavedSearchEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSearches();
    }
  }, [isOpen]);

  async function loadSearches() {
    try {
      setLoading(true);
      setError(null);
      const results = await getSavedSearches(100);
      setSearches(results);
    } catch (err) {
      setError(`Failed to load saved searches: ${err}`);
      console.error('Failed to load saved searches:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await unsaveSearch(id);
      setSearches(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete search:', err);
    }
  }

  function handleLoad(search: SavedSearchEntry) {
    onLoadSearch(search);
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">Saved Searches</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors"
          >
            <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
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

          {!loading && !error && searches.length === 0 && (
            <div className="text-app-text-secondary text-center py-8">
              No saved searches yet. Star searches from the history to save them here.
            </div>
          )}

          {!loading && !error && searches.length > 0 && (
            <div className="space-y-2">
              {searches.map(search => {
                const badge = getSearchTypeBadge(search.search_type);
                return (
                  <div
                    key={search.id}
                    className="group flex items-center gap-3 p-3 rounded-lg bg-app-surface-variant
                               hover:bg-app-accent-light cursor-pointer transition-colors"
                    onClick={() => handleLoad(search)}
                  >
                    {/* Main content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 justify-end">
                        {/* Display label */}
                        <span className="font-arabic text-2xl text-app-text-primary truncate" dir="rtl">
                          {search.display_label}
                        </span>
                        {/* Search type badge */}
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.color}`}>
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-app-text-tertiary justify-end">
                        {/* Book filter info */}
                        <span>
                          {search.book_filter_count > 0
                            ? `${search.book_filter_count} texts`
                            : 'All texts'}
                        </span>
                        {/* Saved time */}
                        <span>Saved {formatRelativeTime(search.created_at)}</span>
                      </div>
                    </div>

                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDelete(search.id, e)}
                      className="p-1.5 rounded-md hover:bg-red-100 text-app-text-tertiary hover:text-red-500 transition-colors"
                      title="Remove from saved"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light">
          <p className="text-xs text-app-text-tertiary text-center">
            Click to load a saved search. Saved searches are never auto-deleted.
          </p>
        </div>
      </div>
    </div>
  );
}
