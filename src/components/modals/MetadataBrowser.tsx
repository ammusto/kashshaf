import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BookMetadata } from '../../types';
import { useBooks } from '../../contexts/BooksContext';
import { exportBooks, exportAuthors, type ExportFormat } from '../../utils/exportData';

interface MetadataBrowserProps {
  onClose: () => void;
}

type BrowserTab = 'texts' | 'authors';
type ViewState = 'list' | 'detail' | 'authorBooks';
type DetailSource = 'list' | 'authorBooks'; // Where we came from when viewing a book detail

interface AuthorInfo {
  author: string;
  author_id?: number;
  death_ah?: number;
  bookCount: number;
  totalPages: number;
  genres: Set<string>;
}

// Normalize Arabic text for search matching
function normalizeArabicForSearch(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670\u0671]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[یے]/g, 'ي')
    .replace(/[ۀە]/g, 'ه')
    .replace(/ۃ/g, 'ة')
    .toLowerCase();
}

const ROW_HEIGHT = 56;

export function MetadataBrowser({ onClose }: MetadataBrowserProps) {
  const { books: allBooks, genres, authorsMap, genresMap, loading } = useBooks();

  // Tab state
  const [activeTab, setActiveTab] = useState<BrowserTab>('texts');

  // View state: 'list', 'detail' (for books), or 'authorBooks' (for author's books modal)
  const [view, setView] = useState<ViewState>('list');
  const [selectedBook, setSelectedBook] = useState<BookMetadata | null>(null);
  const [selectedAuthor, setSelectedAuthor] = useState<AuthorInfo | null>(null);
  const [detailSource, setDetailSource] = useState<DetailSource>('list'); // Track where we came from

  // Filters (shared between tabs)
  const [deathAhMin, setDeathAhMin] = useState<string>('');
  const [deathAhMax, setDeathAhMax] = useState<string>('');
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Genre dropdown
  const [genreDropdownOpen, setGenreDropdownOpen] = useState(false);
  const genreDropdownRef = useRef<HTMLDivElement>(null);

  // Export dropdown
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);

  // Scroll position preservation
  const scrollPositionRef = useRef<number>(0);
  const listParentRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (genreDropdownRef.current && !genreDropdownRef.current.contains(event.target as Node)) {
        setGenreDropdownOpen(false);
      }
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(event.target as Node)) {
        setExportDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Restore scroll position when returning to list
  useEffect(() => {
    if (view === 'list' && listParentRef.current && scrollPositionRef.current > 0) {
      listParentRef.current.scrollTop = scrollPositionRef.current;
    }
  }, [view]);

  // Reset scroll position when switching tabs
  useEffect(() => {
    scrollPositionRef.current = 0;
    if (listParentRef.current) {
      listParentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

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

  const clearFilters = useCallback(() => {
    setDeathAhMin('');
    setDeathAhMax('');
    setSelectedGenreIds(new Set());
    setSearchQuery('');
  }, []);

  const hasActiveFilters = deathAhMin || deathAhMax || selectedGenreIds.size > 0 || searchQuery;

  // Filter books - ALL client-side
  const filteredBooks = useMemo(() => {
    let result = allBooks;

    if (deathAhMin) {
      const min = parseInt(deathAhMin, 10);
      result = result.filter(book => book.death_ah !== undefined && book.death_ah >= min);
    }
    if (deathAhMax) {
      const max = parseInt(deathAhMax, 10);
      result = result.filter(book => book.death_ah !== undefined && book.death_ah <= max);
    }
    if (selectedGenreIds.size > 0) {
      result = result.filter(book => book.genre_id !== undefined && selectedGenreIds.has(book.genre_id));
    }
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
  }, [allBooks, deathAhMin, deathAhMax, selectedGenreIds, searchQuery, authorsMap]);

  // Get unique authors from filtered books
  const filteredAuthors = useMemo(() => {
    const authorIdMap = new Map<number, AuthorInfo>();

    for (const book of filteredBooks) {
      const authorId = book.author_id ?? -1; // -1 for unknown
      const authorName = authorId >= 0 ? authorsMap.get(authorId) ?? 'Unknown' : 'Unknown';

      if (!authorIdMap.has(authorId)) {
        authorIdMap.set(authorId, {
          author: authorName,
          author_id: authorId >= 0 ? authorId : undefined,
          death_ah: book.death_ah,
          bookCount: 0,
          totalPages: 0,
          genres: new Set(),
        });
      }

      const info = authorIdMap.get(authorId)!;
      info.bookCount++;
      info.totalPages += book.page_count || 0;
      if (book.genre_id !== undefined) {
        const genreName = genresMap.get(book.genre_id);
        if (genreName) {
          info.genres.add(genreName);
        }
      }
      // Use the death_ah from the first book if not set
      if (info.death_ah === undefined && book.death_ah !== undefined) {
        info.death_ah = book.death_ah;
      }
    }

    // Convert to array and sort by death date ascending (unknown dates at end)
    return Array.from(authorIdMap.values()).sort((a, b) => {
      const aDate = a.death_ah ?? Infinity;
      const bDate = b.death_ah ?? Infinity;
      return aDate - bDate;
    });
  }, [filteredBooks, authorsMap, genresMap]);

  // Get books for a specific author
  const getAuthorBooks = useCallback((authorId: number | undefined) => {
    return filteredBooks.filter(book => {
      if (authorId === undefined) {
        return book.author_id === undefined;
      }
      return book.author_id === authorId;
    });
  }, [filteredBooks]);

  const handleBookClick = useCallback((book: BookMetadata, source: DetailSource = 'list') => {
    // Save scroll position before navigating
    if (listParentRef.current) {
      scrollPositionRef.current = listParentRef.current.scrollTop;
    }
    setSelectedBook(book);
    setDetailSource(source);
    setView('detail');
  }, []);

  const handleAuthorClick = useCallback((author: AuthorInfo) => {
    if (listParentRef.current) {
      scrollPositionRef.current = listParentRef.current.scrollTop;
    }
    setSelectedAuthor(author);
    setView('authorBooks');
  }, []);

  const handleBack = useCallback(() => {
    if (view === 'detail' && detailSource === 'authorBooks') {
      // Came from author's books view, go back there
      setView('authorBooks');
    } else {
      // Default: go back to list
      setView('list');
    }
    // Keep selected items so we can potentially highlight them
  }, [view, detailSource]);

  // Export metadata with format selection
  const handleExportMetadata = useCallback(async (format: ExportFormat) => {
    setExportDropdownOpen(false);
    try {
      if (activeTab === 'texts') {
        await exportBooks(filteredBooks, format, authorsMap, genresMap);
      } else {
        await exportAuthors(filteredAuthors, format);
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
  }, [activeTab, filteredBooks, filteredAuthors, authorsMap, genresMap]);

  // Text virtualizer
  const textVirtualizer = useVirtualizer({
    count: filteredBooks.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    enabled: activeTab === 'texts',
  });

  // Author virtualizer
  const authorVirtualizer = useVirtualizer({
    count: filteredAuthors.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    enabled: activeTab === 'authors',
  });

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (view === 'detail' || view === 'authorBooks') {
          handleBack();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, handleBack, onClose]);

  // Book detail view
  if (view === 'detail' && selectedBook) {
    return (
      <BookDetailView
        book={selectedBook}
        onBack={handleBack}
        onClose={onClose}
        authorsMap={authorsMap}
        genresMap={genresMap}
      />
    );
  }

  // Author's books modal view
  if (view === 'authorBooks' && selectedAuthor) {
    return (
      <AuthorBooksView
        author={selectedAuthor}
        books={getAuthorBooks(selectedAuthor.author_id)}
        onBack={handleBack}
        onClose={onClose}
        onBookClick={(book) => handleBookClick(book, 'authorBooks')}
        authorsMap={authorsMap}
        genresMap={genresMap}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-app-bg z-50 flex flex-col">
      {/* Header */}
      <div className="px-8 py-5 border-b border-app-border-light bg-white flex items-center gap-5 shadow-sm">
        <h1 className="text-2xl font-semibold text-app-text-primary">Metadata Browser</h1>
        <span className="text-app-text-tertiary">
          {activeTab === 'texts'
            ? `${filteredBooks.length.toLocaleString()} texts`
            : `${filteredAuthors.length.toLocaleString()} authors`
          }
        </span>
        <div className="flex-1" />

        {/* Export Metadata Dropdown */}
        <div className="relative" ref={exportDropdownRef}>
          <button
            onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
            className="h-10 px-4 text-sm font-medium rounded-lg bg-app-accent text-white
                     hover:bg-app-accent/90 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export Metadata
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {exportDropdownOpen && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-app-border-medium rounded-lg shadow-lg z-20 min-w-[160px] overflow-hidden">
              <button
                onClick={() => handleExportMetadata('csv')}
                className="w-full px-4 py-2.5 text-left text-sm text-app-text-primary hover:bg-app-surface-variant flex items-center gap-2"
              >
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Export as CSV
              </button>
              <button
                onClick={() => handleExportMetadata('xlsx')}
                className="w-full px-4 py-2.5 text-left text-sm text-app-text-primary hover:bg-app-surface-variant flex items-center gap-2"
              >
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                Export as Excel
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="w-10 h-10 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                   flex items-center justify-center text-app-text-secondary text-xl transition-colors"
        >
          ×
        </button>
      </div>

      {/* Tabs */}
      <div className="px-8 py-3 border-b border-app-border-light bg-white flex gap-2">
        <button
          onClick={() => setActiveTab('texts')}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'texts'
              ? 'bg-app-accent text-white shadow-sm'
              : 'bg-app-surface-variant text-app-text-secondary hover:bg-app-accent-light hover:text-app-accent'
          }`}
        >
          Text Browser
        </button>
        <button
          onClick={() => setActiveTab('authors')}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'authors'
              ? 'bg-app-accent text-white shadow-sm'
              : 'bg-app-surface-variant text-app-text-secondary hover:bg-app-accent-light hover:text-app-accent'
          }`}
        >
          Author Browser
        </button>
      </div>

      {/* Filters */}
      <div className="px-8 py-4 border-b border-app-border-light bg-white flex items-center gap-4">
        {/* Date Range */}
        <div className="flex items-center gap-2">
          <label className="text-sm text-app-text-secondary font-medium">Death:</label>
          <input
            type="number"
            placeholder="From"
            value={deathAhMin}
            onChange={(e) => setDeathAhMin(e.target.value)}
            className="w-24 h-9 px-3 text-sm rounded-lg border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-1 focus:ring-app-accent"
          />
          <span className="text-app-text-tertiary">—</span>
          <input
            type="number"
            placeholder="To"
            value={deathAhMax}
            onChange={(e) => setDeathAhMax(e.target.value)}
            className="w-24 h-9 px-3 text-sm rounded-lg border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-1 focus:ring-app-accent"
          />
        </div>

        {/* Genre Multi-Select */}
        <div className="flex items-center gap-2 relative" ref={genreDropdownRef}>
          <label className="text-sm text-app-text-secondary font-medium">Genre:</label>
          <button
            onClick={() => setGenreDropdownOpen(!genreDropdownOpen)}
            className="h-9 px-3 text-sm rounded-lg border border-app-border-medium
                     bg-white cursor-pointer flex items-center gap-2 min-w-[140px]"
          >
            <span className="truncate">
              {selectedGenreIds.size === 0
                ? 'All Genres'
                : selectedGenreIds.size === 1
                  ? genresMap.get(Array.from(selectedGenreIds)[0]) ?? 'Unknown'
                  : `${selectedGenreIds.size} selected`}
            </span>
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {genreDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-app-border-medium rounded-lg shadow-lg z-20 min-w-[220px] max-h-[350px] overflow-auto">
              {genres.map(([genreId, genreName]) => (
                <label
                  key={genreId}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-app-surface-variant cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedGenreIds.has(genreId)}
                    onChange={() => toggleGenre(genreId)}
                    className="w-4 h-4 rounded accent-app-accent cursor-pointer"
                  />
                  <span className="text-sm text-app-text-primary capitalize flex-1">{genreName}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="flex-1 flex items-center gap-2">
          <label className="text-sm text-app-text-secondary font-medium">Search:</label>
          <input
            type="text"
            dir="rtl"
            placeholder={activeTab === 'texts' ? 'Title or author...' : 'Author name...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 max-w-md h-9 px-4 text-sm rounded-lg border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-1 focus:ring-app-accent
                     text-right font-arabic"
          />
        </div>

        {/* Clear Filters */}
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="h-9 px-4 text-sm font-medium rounded-lg bg-gray-100 text-gray-600
                     hover:bg-gray-200 transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* List View */}
      <div ref={listParentRef} className="flex-1 overflow-auto bg-white">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-app-accent"></div>
          </div>
        ) : activeTab === 'texts' ? (
          // Text Browser List
          filteredBooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary text-lg">
              No books match your filters
            </div>
          ) : (
            <div
              style={{
                height: `${textVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {textVirtualizer.getVirtualItems().map((virtualRow) => {
                const book = filteredBooks[virtualRow.index];
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
                    <BookListRow
                      book={book}
                      onClick={() => handleBookClick(book)}
                      authorsMap={authorsMap}
                      genresMap={genresMap}
                    />
                  </div>
                );
              })}
            </div>
          )
        ) : (
          // Author Browser List
          filteredAuthors.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary text-lg">
              No authors match your filters
            </div>
          ) : (
            <div
              style={{
                height: `${authorVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {authorVirtualizer.getVirtualItems().map((virtualRow) => {
                const author = filteredAuthors[virtualRow.index];
                return (
                  <div
                    key={author.author}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <AuthorListRow
                      author={author}
                      onClick={() => handleAuthorClick(author)}
                    />
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// Book row in list view
function BookListRow({
  book,
  onClick,
  authorsMap,
  genresMap,
}: {
  book: BookMetadata;
  onClick: () => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
}) {
  const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;

  return (
    <div
      onClick={onClick}
      className="h-[56px] px-8 flex items-center gap-4 cursor-pointer border-b border-app-border-light
               hover:bg-app-accent-light transition-colors"
    >
      {/* Title - Author (d. date) */}
      <div className="flex-1 min-w-0 flex items-center gap-3" dir="rtl">
        <span className="text-xl font-medium text-app-text-primary font-arabic truncate">
          {book.title}
        </span>
        <span className="text-app-text-tertiary">—</span>
        <span className="text-lg text-app-text-secondary font-arabic truncate">
          {authorName || 'Unknown'}
        </span>
        {book.death_ah !== undefined && book.death_ah !== 0 && (
          <span className="text-sm text-app-text-tertiary whitespace-nowrap">
            (ت {book.death_ah})
          </span>
        )}
      </div>

      {/* Genre */}
      {genreName && (
        <span className="text-sm text-app-text-tertiary bg-app-surface-variant px-3 py-1 rounded-lg capitalize flex-shrink-0">
          {genreName}
        </span>
      )}

      {/* Page count */}
      {book.page_count !== undefined && (
        <span className="text-sm text-app-text-tertiary flex-shrink-0">
          {book.page_count.toLocaleString()} pages
        </span>
      )}

      {/* Arrow */}
      <svg className="w-5 h-5 text-app-text-tertiary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

// Author row in list view
function AuthorListRow({
  author,
  onClick,
}: {
  author: AuthorInfo;
  onClick: () => void;
}) {
  const genresList = Array.from(author.genres).slice(0, 3);
  const moreGenres = author.genres.size > 3 ? author.genres.size - 3 : 0;

  return (
    <div
      onClick={onClick}
      className="h-[56px] px-8 flex items-center gap-4 cursor-pointer border-b border-app-border-light
               hover:bg-app-accent-light transition-colors"
    >
      {/* Author name (d. date) */}
      <div className="flex-1 min-w-0 flex items-center gap-3" dir="rtl">
        <span className="text-xl font-medium text-app-text-primary font-arabic truncate">
          {author.author}
        </span>
        {author.death_ah !== undefined && author.death_ah !== 0 && (
          <span className="text-sm text-app-text-tertiary whitespace-nowrap">
            (ت {author.death_ah})
          </span>
        )}
      </div>

      {/* Book count */}
      <span className="text-sm text-app-accent font-medium flex-shrink-0">
        {author.bookCount} {author.bookCount === 1 ? 'book' : 'books'}
      </span>

      {/* Genres */}
      <div className="flex gap-1 flex-shrink-0">
        {genresList.map(genre => (
          <span key={genre} className="text-xs text-app-text-tertiary bg-app-surface-variant px-2 py-0.5 rounded capitalize">
            {genre}
          </span>
        ))}
        {moreGenres > 0 && (
          <span className="text-xs text-app-text-tertiary bg-app-surface-variant px-2 py-0.5 rounded">
            +{moreGenres}
          </span>
        )}
      </div>

      {/* Total pages */}
      <span className="text-sm text-app-text-tertiary flex-shrink-0">
        {author.totalPages.toLocaleString()} pages
      </span>

      {/* Arrow */}
      <svg className="w-5 h-5 text-app-text-tertiary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

// Author's books view (modal-like)
function AuthorBooksView({
  author,
  books,
  onBack,
  onClose,
  onBookClick,
  authorsMap,
  genresMap,
}: {
  author: AuthorInfo;
  books: BookMetadata[];
  onBack: () => void;
  onClose: () => void;
  onBookClick: (book: BookMetadata) => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
}) {
  const listParentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: books.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  return (
    <div className="fixed inset-0 bg-app-bg z-50 flex flex-col">
      {/* Header */}
      <div className="px-8 py-5 border-b border-app-border-light bg-white flex items-center gap-4 shadow-sm">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-app-text-secondary hover:text-app-accent
                   hover:bg-app-accent-light rounded-lg transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="font-medium">Back to Authors</span>
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="w-10 h-10 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                   flex items-center justify-center text-app-text-secondary text-xl transition-colors"
        >
          ×
        </button>
      </div>

      {/* Author Info */}
      <div className="px-8 py-6 bg-white border-b border-app-border-light">
        <h1 className="text-3xl font-bold text-app-text-primary font-arabic" dir="rtl">
          {author.author}
        </h1>
        <div className="flex items-center gap-4 mt-3 text-app-text-secondary">
          {author.death_ah !== undefined && author.death_ah !== 0 && (
            <span>d. {author.death_ah} AH</span>
          )}
          <span className="text-app-accent font-medium">
            {author.bookCount} {author.bookCount === 1 ? 'book' : 'books'}
          </span>
          <span>{author.totalPages.toLocaleString()} total pages</span>
        </div>
        {author.genres.size > 0 && (
          <div className="flex gap-2 mt-3">
            {Array.from(author.genres).map(genre => (
              <span key={genre} className="text-sm text-app-text-tertiary bg-app-surface-variant px-3 py-1 rounded-lg capitalize">
                {genre}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Books List */}
      <div ref={listParentRef} className="flex-1 overflow-auto bg-white">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const book = books[virtualRow.index];
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
                <BookListRow
                  book={book}
                  onClick={() => onBookClick(book)}
                  authorsMap={authorsMap}
                  genresMap={genresMap}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Parse JSON array string into array of strings
function parseJsonArray(jsonStr?: string): string[] {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Book detail view
function BookDetailView({
  book,
  onBack,
  onClose,
  authorsMap,
  genresMap,
}: {
  book: BookMetadata;
  onBack: () => void;
  onClose: () => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
}) {
  const tags = parseJsonArray(book.tags);
  const bookMeta = parseJsonArray(book.book_meta);
  const authorMeta = parseJsonArray(book.author_meta);
  const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;

  return (
    <div className="fixed inset-0 bg-app-bg z-50 flex flex-col">
      {/* Header */}
      <div className="px-8 py-5 border-b border-app-border-light bg-white flex items-center gap-4 shadow-sm">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-app-text-secondary hover:text-app-accent
                   hover:bg-app-accent-light rounded-lg transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="font-medium">Back to List</span>
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="w-10 h-10 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                   flex items-center justify-center text-app-text-secondary text-xl transition-colors"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-8 space-y-6">
          {/* Title */}
          <h1 className="text-4xl font-bold text-app-text-primary font-arabic" dir="rtl">
            {book.title}
          </h1>

          {/* Author */}
          <div className="text-2xl text-app-text-secondary font-arabic" dir="rtl">
            {authorName || 'Unknown Author'}
            {book.death_ah !== undefined && book.death_ah !== 0 && (
              <span className="text-app-text-tertiary"> (ت {book.death_ah})</span>
            )}
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag, idx) => (
                <span
                  key={idx}
                  className="px-3 py-1 text-sm bg-app-accent-light text-app-accent rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Basic Metadata Grid */}
          <div className="bg-white rounded-xl p-6 shadow-app-md">
            <h2 className="text-lg font-semibold text-app-text-primary mb-4">Basic Information</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
              <MetadataField label="Kashshāf ID" value={book.id.toString()} />
              <MetadataField label="Source Corpus" value={book.corpus || '—'} />
              <MetadataField label="Source ID" value={book.original_id || '—'} />
              <MetadataField label="Genre" value={genreName || '—'} capitalize />
              <MetadataField label="Death" value={book.death_ah !== undefined ? `${book.death_ah} AH` : '—'} />
              <MetadataField
                label="Century"
                value={
                  book.century_ah !== undefined
                    ? `${book.century_ah} AH / ${book.century_ah + 6} CE`
                    : '—'
                }
              />
              <MetadataField label="Author ID" value={book.author_id?.toString() || '—'} />
              <MetadataField label="Page Count" value={book.page_count?.toLocaleString() || '—'} />
              <MetadataField label="Token Count" value={book.token_count?.toLocaleString() || '—'} />
            </div>
          </div>

          {/* Book Metadata */}
          {bookMeta.length > 0 && (
            <div className="bg-white rounded-xl p-6 shadow-app-md">
              <h2 className="text-lg font-semibold text-app-text-primary mb-4">Book Details</h2>
              <div className="space-y-2">
                {bookMeta.map((item, idx) => (
                  <MetadataItem key={idx} value={item} />
                ))}
              </div>
            </div>
          )}

          {/* Author Metadata */}
          {authorMeta.length > 0 && (
            <div className="bg-white rounded-xl p-6 shadow-app-md">
              <h2 className="text-lg font-semibold text-app-text-primary mb-4">Author Details</h2>
              <div className="space-y-2">
                {authorMeta.map((item, idx) => (
                  <MetadataItem key={idx} value={item} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetadataField({
  label,
  value,
  capitalize = false,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div>
      <div className="text-sm text-app-text-tertiary font-medium mb-1">{label}</div>
      <div className={`text-lg text-app-text-primary ${capitalize ? 'capitalize' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// Renders a metadata item, parsing "key: value" format if present
function MetadataItem({ value }: { value: string }) {
  const colonIndex = value.indexOf(':');
  if (colonIndex > 0 && colonIndex < 40) {
    const key = value.slice(0, colonIndex).trim();
    const val = value.slice(colonIndex + 1).trim();
    return (
      <div className="flex gap-2 py-1.5 border-b border-app-border-light last:border-0">
        <span className="text-sm text-app-text-tertiary font-medium min-w-[120px]">{key}</span>
        <span className="text-lg text-app-text-primary" dir="auto">{val}</span>
      </div>
    );
  }
  return (
    <div className="py-1.5 border-b border-app-border-light last:border-0">
      <span className="text-lg text-app-text-primary" dir="auto">{value}</span>
    </div>
  );
}
