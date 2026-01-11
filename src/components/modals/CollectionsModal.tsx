import { useState, useEffect } from 'react';
import type { Collection } from '../../types/collections';
import {
  getCollections,
  deleteCollection,
  updateCollectionDescription,
} from '../../utils/collections';

interface CollectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEditCollection: (collection: Collection) => void;
  onCreateCollection: () => void;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function CollectionsModal({
  isOpen,
  onClose,
  onEditCollection,
  onCreateCollection,
}: CollectionsModalProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingDescriptionId, setEditingDescriptionId] = useState<number | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadCollections();
    }
  }, [isOpen]);

  async function loadCollections() {
    try {
      setLoading(true);
      setError(null);
      const results = await getCollections();
      setCollections(results);
    } catch (err) {
      setError(`Failed to load collections: ${err}`);
      console.error('Failed to load collections:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete this collection?')) return;
    try {
      await deleteCollection(id);
      setCollections(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('Failed to delete collection:', err);
    }
  }

  function handleRowClick(collection: Collection) {
    onEditCollection(collection);
    onClose();
  }

  function handleToggleExpand(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedId(expandedId === id ? null : id);
    setEditingDescriptionId(null);
  }

  function handleEditDescription(collection: Collection, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingDescriptionId(collection.id);
    setDescriptionDraft(collection.description ?? '');
  }

  async function handleSaveDescription(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const desc = descriptionDraft.trim() || null;
      await updateCollectionDescription(id, desc);
      setCollections(prev =>
        prev.map(c => (c.id === id ? { ...c, description: desc } : c))
      );
      setEditingDescriptionId(null);
    } catch (err) {
      console.error('Failed to update description:', err);
    }
  }

  function handleCancelEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setEditingDescriptionId(null);
    setDescriptionDraft('');
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">Collections</h2>
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

          {!loading && !error && collections.length === 0 && (
            <div className="text-center py-8">
              <p className="text-app-text-secondary mb-4">No collections yet</p>
              <button
                onClick={() => {
                  onCreateCollection();
                  onClose();
                }}
                className="px-4 py-2 bg-app-accent text-white rounded-lg hover:bg-app-accent-dark transition-colors"
              >
                Create Collection
              </button>
            </div>
          )}

          {!loading && !error && collections.length > 0 && (
            <div className="space-y-2">
              {collections.map(collection => {
                const isExpanded = expandedId === collection.id;
                const isEditingDesc = editingDescriptionId === collection.id;
                return (
                  <div
                    key={collection.id}
                    className="rounded-lg bg-app-surface-variant hover:bg-app-accent-light cursor-pointer transition-colors"
                    onClick={() => handleRowClick(collection)}
                  >
                    {/* Main row */}
                    <div className="flex items-center gap-3 p-3">
                      {/* Icon */}
                      <div className="text-app-accent">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-app-text-primary truncate">
                          {collection.name}
                        </div>
                        <div className="text-xs text-app-text-tertiary">
                          Created {formatDate(collection.created_at)}
                        </div>
                      </div>

                      {/* Text count badge */}
                      <span className="text-sm text-app-text-secondary px-2 py-0.5 bg-white/50 rounded">
                        {collection.book_ids.length} texts
                      </span>

                      {/* Delete button */}
                      <button
                        onClick={(e) => handleDelete(collection.id, e)}
                        className="p-1.5 rounded-md hover:bg-red-100 text-app-text-tertiary hover:text-red-500 transition-colors"
                        title="Delete collection"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>

                      {/* Expand/collapse button */}
                      <button
                        onClick={(e) => handleToggleExpand(collection.id, e)}
                        className="p-1.5 rounded-md hover:bg-white/50 text-app-text-tertiary transition-colors"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        <svg
                          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>

                    {/* Expanded description section */}
                    {isExpanded && (
                      <div
                        className="px-3 pb-3 pt-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 bg-white/50 rounded-lg border border-app-border-light">
                          {isEditingDesc ? (
                            <div className="space-y-2">
                              <textarea
                                value={descriptionDraft}
                                onChange={(e) => setDescriptionDraft(e.target.value.slice(0, 150))}
                                className="w-full p-2 text-sm border border-app-border-light rounded resize-none focus:outline-none focus:ring-1 focus:ring-app-accent"
                                rows={2}
                                placeholder="Add a description..."
                                autoFocus
                              />
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-app-text-tertiary">
                                  {descriptionDraft.length}/150
                                </span>
                                <div className="flex gap-2">
                                  <button
                                    onClick={handleCancelEdit}
                                    className="text-xs px-2 py-1 text-app-text-secondary hover:bg-app-surface-variant rounded"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={(e) => handleSaveDescription(collection.id, e)}
                                    className="text-xs px-2 py-1 bg-app-accent text-white rounded hover:bg-app-accent-dark"
                                  >
                                    Save
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2">
                              <p className="flex-1 text-sm text-app-text-secondary italic">
                                {collection.description || 'No description'}
                              </p>
                              <button
                                onClick={(e) => handleEditDescription(collection, e)}
                                className="p-1 rounded hover:bg-app-surface-variant text-app-text-tertiary"
                                title="Edit description"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light flex items-center justify-between">
          <p className="text-xs text-app-text-tertiary">
            Click a collection to edit its texts.
          </p>
          {collections.length > 0 && (
            <button
              onClick={() => {
                onCreateCollection();
                onClose();
              }}
              className="px-3 py-1.5 bg-app-accent text-white text-sm rounded-lg hover:bg-app-accent-dark transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Collection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
