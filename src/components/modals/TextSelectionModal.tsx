import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BookMetadata } from '../../types';
import type { Collection } from '../../types/collections';
import { useBooks } from '../../contexts/BooksContext';

export type TextSelectionMode = 'select' | 'create-collection' | 'edit-collection';

interface TextSelectionModalProps {
  onClose: () => void;
  selectedBookIds: Set<number>;
  onSelectionChange: (selectedIds: Set<number>) => void;
  // New props for collection modes
  mode?: TextSelectionMode;
  editingCollection?: Collection;
  collections?: Collection[];
  onSaveCollection?: () => void;
  onUpdateCollection?: (id: number, bookIds: number[]) => Promise<void>;
}

// Normalize Arabic text for search matching
function normalizeArabicForSearch(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670\u0671]/g, '') // Remove diacritics
    .replace(/[أإآ]/g, 'ا') // Normalize hamza carriers
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/ک/g, 'ك') // Persian/Urdu
    .replace(/[یے]/g, 'ي')
    .replace(/[ۀە]/g, 'ه')
    .replace(/ۃ/g, 'ة')
    .toLowerCase();
}

// Truncate text to specified length
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

const ROW_HEIGHT = 48;

export function TextSelectionModal({
  onClose,
  selectedBookIds,
  onSelectionChange,
  mode = 'select',
  editingCollection,
  collections = [],
  onSaveCollection,
  onUpdateCollection,
}: TextSelectionModalProps) {
  // Get cached books from context - no loading needed!
  const { books: allBooks, genres, authorsMap, genresMap, loading } = useBooks();

  const [activeTab, setActiveTab] = useState<'all' | 'selected'>('all');

  // Filters for All Texts (all client-side)
  const [deathAhMin, setDeathAhMin] = useState<string>('');
  const [deathAhMax, setDeathAhMax] = useState<string>('');
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Genre dropdown open state
  const [genreDropdownOpen, setGenreDropdownOpen] = useState(false);
  const genreDropdownRef = useRef<HTMLDivElement>(null);

  // Collection filter dropdown state
  const [collectionDropdownOpen, setCollectionDropdownOpen] = useState(false);
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<Set<number>>(new Set());
  const collectionDropdownRef = useRef<HTMLDivElement>(null);

  // Track if changes were made in edit mode
  const [initialBookIds] = useState(() =>
    editingCollection ? new Set(editingCollection.book_ids) : new Set<number>()
  );
  const hasChanges = useMemo(() => {
    if (mode !== 'edit-collection' || !editingCollection) return false;
    if (selectedBookIds.size !== initialBookIds.size) return true;
    for (const id of selectedBookIds) {
      if (!initialBookIds.has(id)) return true;
    }
    return false;
  }, [mode, editingCollection, selectedBookIds, initialBookIds]);

  const [updating, setUpdating] = useState(false);

  // Selected Texts tab search
  const [selectedSearch, setSelectedSearch] = useState('');

  // Refs for virtualization
  const allTextsParentRef = useRef<HTMLDivElement>(null);
  const selectedTextsParentRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (genreDropdownRef.current && !genreDropdownRef.current.contains(event.target as Node)) {
        setGenreDropdownOpen(false);
      }
      if (collectionDropdownRef.current && !collectionDropdownRef.current.contains(event.target as Node)) {
        setCollectionDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Toggle genre in multi-select
  const toggleGenre = useCallback((genreId: number) => {
    setSelectedGenreIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(genreId)) {
        newSet.delete(genreId);
      } else {
        newSet.add(genreId);
      }
      return newSet;
    });
  }, []);

  // Toggle collection in multi-select
  const toggleCollection = useCallback((collectionId: number) => {
    setSelectedCollectionIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(collectionId)) {
        newSet.delete(collectionId);
      } else {
        newSet.add(collectionId);
      }
      return newSet;
    });
  }, []);

  // Clear all filters
  const clearFilters = useCallback(() => {
    setDeathAhMin('');
    setDeathAhMax('');
    setSelectedGenreIds(new Set());
    setSelectedCollectionIds(new Set());
    setSearchQuery('');
  }, []);

  // Check if any filters are active
  const hasActiveFilters = deathAhMin || deathAhMax || selectedGenreIds.size > 0 || selectedCollectionIds.size > 0 || searchQuery;

  // Get book IDs from selected collections (union/OR logic)
  const collectionBookIds = useMemo(() => {
    if (selectedCollectionIds.size === 0) return null;
    const ids = new Set<number>();
    for (const collection of collections) {
      if (selectedCollectionIds.has(collection.id)) {
        collection.book_ids.forEach(id => ids.add(id));
      }
    }
    return ids;
  }, [collections, selectedCollectionIds]);

  // Filter books - ALL client-side, instant!
  const filteredBooks = useMemo(() => {
    let result = allBooks;

    // Date range filter
    if (deathAhMin) {
      const min = parseInt(deathAhMin, 10);
      result = result.filter(book => book.death_ah !== undefined && book.death_ah >= min);
    }
    if (deathAhMax) {
      const max = parseInt(deathAhMax, 10);
      result = result.filter(book => book.death_ah !== undefined && book.death_ah <= max);
    }

    // Genre filter
    if (selectedGenreIds.size > 0) {
      result = result.filter(book => book.genre_id !== undefined && selectedGenreIds.has(book.genre_id));
    }

    // Collection filter (OR logic between collections, AND with other filters)
    if (collectionBookIds) {
      result = result.filter(book => collectionBookIds.has(book.id));
    }

    // Search query (title/author)
    if (searchQuery.trim()) {
      const normalized = normalizeArabicForSearch(searchQuery);
      result = result.filter(book => {
        const normalizedTitle = normalizeArabicForSearch(book.title);
        const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
        const normalizedAuthor = authorName ? normalizeArabicForSearch(authorName) : '';
        return normalizedTitle.includes(normalized) || normalizedAuthor.includes(normalized);
      });
    }

    return result;
  }, [allBooks, deathAhMin, deathAhMax, selectedGenreIds, collectionBookIds, searchQuery, authorsMap]);

  // Toggle book selection
  const toggleBook = useCallback((bookId: number) => {
    const newSelection = new Set(selectedBookIds);
    if (newSelection.has(bookId)) {
      newSelection.delete(bookId);
    } else {
      newSelection.add(bookId);
    }
    onSelectionChange(newSelection);
  }, [selectedBookIds, onSelectionChange]);

  // Select all showing books
  const selectAllShowing = useCallback(() => {
    const newSelection = new Set(selectedBookIds);
    filteredBooks.forEach(book => newSelection.add(book.id));
    onSelectionChange(newSelection);
  }, [filteredBooks, selectedBookIds, onSelectionChange]);

  // Clear all selected
  const clearAllSelected = useCallback(() => {
    onSelectionChange(new Set());
  }, [onSelectionChange]);

  // Handle update collection in edit mode
  const handleUpdateCollection = useCallback(async () => {
    if (!editingCollection || !onUpdateCollection) return;
    try {
      setUpdating(true);
      await onUpdateCollection(editingCollection.id, Array.from(selectedBookIds));
      onClose();
    } catch (err) {
      console.error('Failed to update collection:', err);
    } finally {
      setUpdating(false);
    }
  }, [editingCollection, onUpdateCollection, selectedBookIds, onClose]);

  // Get header title based on mode
  const headerTitle = useMemo(() => {
    switch (mode) {
      case 'create-collection':
        return 'Create Collection';
      case 'edit-collection':
        return editingCollection ? `Edit: ${editingCollection.name}` : 'Edit Collection';
      default:
        return 'Select Texts';
    }
  }, [mode, editingCollection]);

  // Filter selected books by search term
  const selectedBooks = useMemo(() => {
    return allBooks.filter(book => selectedBookIds.has(book.id));
  }, [allBooks, selectedBookIds]);

  const filteredSelectedBooks = useMemo(() => {
    if (!selectedSearch.trim()) return selectedBooks;
    const normalized = normalizeArabicForSearch(selectedSearch);
    return selectedBooks.filter(book => {
      const normalizedTitle = normalizeArabicForSearch(book.title);
      const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
      const normalizedAuthor = authorName ? normalizeArabicForSearch(authorName) : '';
      return normalizedTitle.includes(normalized) || normalizedAuthor.includes(normalized);
    });
  }, [selectedBooks, selectedSearch, authorsMap]);

  // Virtualizers
  const allTextsVirtualizer = useVirtualizer({
    count: filteredBooks.length,
    getScrollElement: () => allTextsParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const selectedTextsVirtualizer = useVirtualizer({
    count: filteredSelectedBooks.length,
    getScrollElement: () => selectedTextsParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-app-lg w-[1000px] h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-8 py-5 border-b border-app-border-light flex items-center gap-5">
          <h2 className="text-xl font-semibold text-app-text-primary">{headerTitle}</h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="w-9 h-9 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                     flex items-center justify-center text-app-text-secondary text-lg transition-colors"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="px-8 py-3 border-b border-app-border-light flex gap-4 bg-app-surface-variant">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'all'
                ? 'bg-app-accent text-white shadow-sm'
                : 'text-app-text-secondary hover:bg-app-accent-light'
            }`}
          >
            All Texts ({filteredBooks.length.toLocaleString()})
          </button>
          <button
            onClick={() => setActiveTab('selected')}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'selected'
                ? 'bg-app-accent text-white shadow-sm'
                : 'text-app-text-secondary hover:bg-app-accent-light'
            }`}
          >
            Selected Texts ({selectedBookIds.size})
          </button>

          {/* Save Collection button - only visible when texts selected and in select/create mode */}
          {selectedBookIds.size > 0 && (mode === 'select' || mode === 'create-collection') && onSaveCollection && (
            <>
              <div className="flex-1" />
              <button
                onClick={onSaveCollection}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                Save Collection
              </button>
            </>
          )}
        </div>

        {/* Tab Content */}
        {activeTab === 'all' ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Filters - All in one row */}
            <div className="px-8 py-3 border-b border-app-border-light flex items-center gap-3">
              {/* Date Range */}
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-app-text-secondary font-medium whitespace-nowrap">
                  Death:
                </label>
                <input
                  type="number"
                  placeholder="From"
                  value={deathAhMin}
                  onChange={(e) => setDeathAhMin(e.target.value)}
                  className="w-20 h-8 px-2 text-xs rounded border border-app-border-medium
                           focus:outline-none focus:border-app-accent"
                />
                <span className="text-app-text-tertiary text-xs">-</span>
                <input
                  type="number"
                  placeholder="To"
                  value={deathAhMax}
                  onChange={(e) => setDeathAhMax(e.target.value)}
                  className="w-20 h-8 px-2 text-xs rounded border border-app-border-medium
                           focus:outline-none focus:border-app-accent"
                />
              </div>

              {/* Genre Multi-Select Dropdown */}
              <div className="flex items-center gap-1.5 relative" ref={genreDropdownRef}>
                <label className="text-xs text-app-text-secondary font-medium whitespace-nowrap">
                  Genre:
                </label>
                <button
                  onClick={() => setGenreDropdownOpen(!genreDropdownOpen)}
                  className="h-8 px-2 text-xs rounded border border-app-border-medium
                           bg-white cursor-pointer flex items-center gap-1 min-w-[100px]"
                >
                  <span className="truncate">
                    {selectedGenreIds.size === 0
                      ? 'All'
                      : selectedGenreIds.size === 1
                        ? genresMap.get(Array.from(selectedGenreIds)[0]) ?? 'Unknown'
                        : `${selectedGenreIds.size} selected`}
                  </span>
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {genreDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-app-border-medium rounded shadow-lg z-20 min-w-[180px] max-h-[300px] overflow-auto">
                    {genres.map(([genreId, genreName]) => (
                      <label
                        key={genreId}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-app-surface-variant cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedGenreIds.has(genreId)}
                          onChange={() => toggleGenre(genreId)}
                          className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
                        />
                        <span className="text-xs text-app-text-primary capitalize flex-1">{genreName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Collection Multi-Select Dropdown */}
              {collections.length > 0 && (
                <div className="flex items-center gap-1.5 relative" ref={collectionDropdownRef}>
                  <label className="text-xs text-app-text-secondary font-medium whitespace-nowrap">
                    Collection:
                  </label>
                  <button
                    onClick={() => setCollectionDropdownOpen(!collectionDropdownOpen)}
                    className="h-8 px-2 text-xs rounded border border-app-border-medium
                             bg-white cursor-pointer flex items-center gap-1 min-w-[100px]"
                  >
                    <span className="truncate">
                      {selectedCollectionIds.size === 0
                        ? 'All'
                        : selectedCollectionIds.size === 1
                          ? collections.find(c => c.id === Array.from(selectedCollectionIds)[0])?.name ?? 'Unknown'
                          : `${selectedCollectionIds.size} selected`}
                    </span>
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {collectionDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 bg-white border border-app-border-medium rounded shadow-lg z-20 min-w-[200px] max-h-[300px] overflow-auto">
                      {collections.map((collection) => (
                        <label
                          key={collection.id}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-app-surface-variant cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selectedCollectionIds.has(collection.id)}
                            onChange={() => toggleCollection(collection.id)}
                            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
                          />
                          <span className="text-xs text-app-text-primary flex-1 truncate">
                            {collection.name} ({collection.book_ids.length})
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Search (Title/Author) */}
              <div className="flex-1 flex items-center gap-1.5">
                <label className="text-xs text-app-text-secondary font-medium whitespace-nowrap">
                  Search:
                </label>
                <input
                  type="text"
                  dir="rtl"
                  placeholder="Title or author"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 h-8 px-3 text-lg rounded border border-app-border-medium
                           focus:outline-none focus:border-app-accent text-right font-arabic"
                />
              </div>

              {/* Clear Filters */}
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="h-8 px-3 text-xs font-medium rounded bg-gray-100 text-gray-600
                           hover:bg-gray-200 transition-colors whitespace-nowrap"
                >
                  Clear Filters
                </button>
              )}
            </div>

            {/* Action Buttons */}
            <div className="px-8 py-2 border-b border-app-border-light flex items-center gap-3 bg-app-surface-variant/50">
              <button
                onClick={selectAllShowing}
                className="px-3 py-1.5 text-xs font-medium rounded bg-app-accent-light text-app-accent
                         hover:bg-app-accent hover:text-white transition-colors"
              >
                Select Showing ({filteredBooks.length})
              </button>
              {selectedBookIds.size > 0 && (
                <button
                  onClick={clearAllSelected}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-red-50 text-red-600
                           hover:bg-red-100 transition-colors"
                >
                  Clear All Selected
                </button>
              )}
              <div className="flex-1" />
              <span className="text-xs text-app-text-tertiary">
                {selectedBookIds.size} selected
              </span>
            </div>

            {/* Virtualized Book List */}
            <div
              ref={allTextsParentRef}
              className="flex-1 overflow-auto"
            >
              {loading ? (
                <div className="flex items-center justify-center h-40">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-app-accent"></div>
                </div>
              ) : filteredBooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary">
                  No books match filters
                </div>
              ) : (
                <div
                  style={{
                    height: `${allTextsVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {allTextsVirtualizer.getVirtualItems().map((virtualRow) => {
                    const book = filteredBooks[virtualRow.index];
                    const isSelected = selectedBookIds.has(book.id);
                    return (
                      <div
                        key={book.id}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <BookRow
                          book={book}
                          isSelected={isSelected}
                          onToggle={() => toggleBook(book.id)}
                          authorsMap={authorsMap}
                          genresMap={genresMap}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Search for Selected */}
            <div className="px-8 py-3 border-b border-app-border-light flex gap-3 items-center">
              <div className="flex-1 flex items-center gap-1.5">
                <label className="text-xs text-app-text-secondary font-medium whitespace-nowrap">
                  Search:
                </label>
                <input
                  type="text"
                  dir="rtl"
                  placeholder="Filter selected texts"
                  value={selectedSearch}
                  onChange={(e) => setSelectedSearch(e.target.value)}
                  className="flex-1 h-8 px-3 text-lg rounded border border-app-border-medium
                           focus:outline-none focus:border-app-accent text-right font-arabic"
                />
              </div>
              {selectedBookIds.size > 0 && (
                <button
                  onClick={clearAllSelected}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-red-50 text-red-600
                           hover:bg-red-100 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>

            {/* Virtualized Selected Books List */}
            <div
              ref={selectedTextsParentRef}
              className="flex-1 overflow-auto"
            >
              {filteredSelectedBooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary">
                  {selectedBookIds.size === 0
                    ? 'No texts selected'
                    : 'No matches found'}
                </div>
              ) : (
                <div
                  style={{
                    height: `${selectedTextsVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {selectedTextsVirtualizer.getVirtualItems().map((virtualRow) => {
                    const book = filteredSelectedBooks[virtualRow.index];
                    return (
                      <div
                        key={book.id}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <BookRow
                          book={book}
                          isSelected={true}
                          onToggle={() => toggleBook(book.id)}
                          authorsMap={authorsMap}
                          genresMap={genresMap}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer for collection modes */}
        {(mode === 'create-collection' || mode === 'edit-collection') && (
          <div className="px-8 py-4 border-t border-app-border-light flex items-center justify-end gap-3 bg-app-surface-variant">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-app-text-secondary hover:bg-white rounded-lg transition-colors"
            >
              Cancel
            </button>
            {mode === 'create-collection' && onSaveCollection && (
              <button
                onClick={onSaveCollection}
                disabled={selectedBookIds.size === 0}
                className="px-4 py-2 text-sm font-medium bg-app-accent text-white rounded-lg hover:bg-app-accent-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save Collection
              </button>
            )}
            {mode === 'edit-collection' && (
              <button
                onClick={handleUpdateCollection}
                disabled={!hasChanges || updating}
                className="px-4 py-2 text-sm font-medium bg-app-accent text-white rounded-lg hover:bg-app-accent-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {updating && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                Update Collection
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Book row component - compact single line
function BookRow({
  book,
  isSelected,
  onToggle,
  authorsMap,
  genresMap,
}: {
  book: BookMetadata;
  isSelected: boolean;
  onToggle: () => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
}) {
  const titleTruncated = truncate(book.title, 75);
  const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  const authorTruncated = authorName ? truncate(authorName, 50) : 'Unknown';
  const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;

  return (
    <div
      onClick={onToggle}
      className={`h-[48px] px-6 flex items-center gap-3 cursor-pointer border-b border-app-border-light
               transition-colors ${isSelected ? 'bg-app-accent-light' : 'hover:bg-app-surface-variant'}`}
    >
      {/* Checkbox */}
      <div
        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          isSelected
            ? 'bg-app-accent border-app-accent'
            : 'border-app-border-medium'
        }`}
      >
        {isSelected && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* Title - Author (d. date) */}
      <div className="flex-1 min-w-0 flex items-center gap-2" dir="rtl">
        <span className="text-2xl font-medium text-app-accent font-arabic truncate">
          {titleTruncated}
        </span>
        <span className="text-xs text-app-text-tertiary">—</span>
        <span className="text-xl text-app-text-secondary font-arabic truncate">
          {authorTruncated}
        </span>
        {book.death_ah !== undefined && (
          <span className="text-sm whitespace-nowrap">
            (d. {book.death_ah === 0 ? '?' : book.death_ah})
          </span>
        )}
      </div>

      {/* Genre */}
      {genreName && (
        <span className="text-sm text-app-text-tertiary bg-app-surface-variant px-2 py-0.5 rounded capitalize flex-shrink-0">
          {genreName}
        </span>
      )}
    </div>
  );
}
