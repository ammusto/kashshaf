import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BookMetadata } from '../../types';
import { useBooks } from '../../contexts/BooksContext';
import { exportBooks, exportAuthors, type ExportFormat } from '../../utils/exportData';
import { CitationBlock } from '../shared/CitationBlock';
import { InfoTooltip } from '../ui';

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

const ROW_HEIGHT = 64;

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

  // Texts table column widths (percentages summing to 100). User can drag the
  // dividers between header cells to redistribute width between adjacent cols.
  const [colWidths, setColWidths] = useState({
    title: 40,
    author: 30,
    death: 12,
    genre: 18,
  });
  const tableRef = useRef<HTMLDivElement>(null);

  // Sort state for the texts table. Default matches the existing on-load
  // ordering (death asc, NULLs last) so behavior is unchanged until a header
  // is clicked.
  type SortKey = 'title' | 'author' | 'death' | 'genre';
  const [sortKey, setSortKey] = useState<SortKey>('death');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSortClick = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        // Same column clicked again — toggle direction
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      // New column — reset to ascending
      setSortDir('asc');
      return key;
    });
  }, []);

  // Authors table column widths (percentages) and resize / sort state.
  const [authorColWidths, setAuthorColWidths] = useState({
    name: 40,
    death: 12,
    books: 13,
    genres: 35,
  });
  const authorTableRef = useRef<HTMLDivElement>(null);

  const [authorSortKey, setAuthorSortKey] = useState<AuthorSortKey>('death');
  const [authorSortDir, setAuthorSortDir] = useState<'asc' | 'desc'>('asc');

  const startAuthorResize = useCallback(
    (
      e: React.MouseEvent,
      leftKey: keyof typeof authorColWidths,
      rightKey: keyof typeof authorColWidths
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const containerWidth = authorTableRef.current?.offsetWidth ?? 1000;
      const startLeft = authorColWidths[leftKey];
      const startRight = authorColWidths[rightKey];
      const totalBudget = startLeft + startRight;
      const MIN_PCT = 5;

      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientX - startX;
        const deltaPct = (deltaPx / containerWidth) * 100;
        const newLeft = Math.max(MIN_PCT, Math.min(totalBudget - MIN_PCT, startLeft - deltaPct));
        const newRight = totalBudget - newLeft;
        setAuthorColWidths((prev) => ({ ...prev, [leftKey]: newLeft, [rightKey]: newRight }));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [authorColWidths]
  );

  const handleAuthorSortClick = useCallback((key: AuthorSortKey) => {
    setAuthorSortKey((prev) => {
      if (prev === key) {
        setAuthorSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setAuthorSortDir('asc');
      return key;
    });
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent, leftKey: keyof typeof colWidths, rightKey: keyof typeof colWidths) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const containerWidth = tableRef.current?.offsetWidth ?? 1000;

      // Capture starting widths so the resize is computed against an anchor,
      // not iteratively (which would drift on rapid moves).
      const startLeft = colWidths[leftKey];
      const startRight = colWidths[rightKey];
      const totalBudget = startLeft + startRight;
      const MIN_PCT = 5;

      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientX - startX;
        const deltaPct = (deltaPx / containerWidth) * 100;
        // RTL convention: dragging the divider rightward grows the visually-right
        // column, which in DOM order is the leftKey. Negate the screen-space
        // delta so the LeftKey grows when dragging right.
        const newLeft = Math.max(MIN_PCT, Math.min(totalBudget - MIN_PCT, startLeft - deltaPct));
        const newRight = totalBudget - newLeft;
        setColWidths((prev) => ({ ...prev, [leftKey]: newLeft, [rightKey]: newRight }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [colWidths]
  );

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

  // Reset scroll to top whenever filters or sort change. Without this, the
  // virtualizer's window can land beyond the new (smaller) array length and
  // briefly render stale rows from the previous render.
  useEffect(() => {
    if (listParentRef.current) {
      listParentRef.current.scrollTop = 0;
    }
  }, [
    searchQuery,
    deathAhMin,
    deathAhMax,
    selectedGenreIds,
    sortKey,
    sortDir,
    authorSortKey,
    authorSortDir,
  ]);

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

  // Sort filtered books by the active sort column. Done as a memo so the
  // virtualizer stays stable when the underlying data hasn't changed.
  const sortedFilteredBooks = useMemo(() => {
    const out = [...filteredBooks];
    out.sort((a, b) => compareBooks(a, b, sortKey, sortDir, authorsMap, genresMap));
    return out;
  }, [filteredBooks, sortKey, sortDir, authorsMap, genresMap]);

  // Text virtualizer
  const textVirtualizer = useVirtualizer({
    count: sortedFilteredBooks.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    enabled: activeTab === 'texts',
  });

  // Sort filtered authors by the active author-sort column.
  const sortedFilteredAuthors = useMemo(() => {
    const out = [...filteredAuthors];
    out.sort((a, b) => compareAuthors(a, b, authorSortKey, authorSortDir));
    return out;
  }, [filteredAuthors, authorSortKey, authorSortDir]);

  // Author virtualizer
  const authorVirtualizer = useVirtualizer({
    count: sortedFilteredAuthors.length,
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
        colWidths={colWidths}
        startResize={startResize}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSortClick}
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
          <span className="text-app-text-tertiary">-</span>
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
            className="flex-1 h-9 px-4 text-sm rounded-lg border border-app-border-medium
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

      {/* List View — keying on activeTab forces a clean remount when switching
          tabs so the previous tab's virtualized rows can't linger. */}
      <div ref={listParentRef} key={`tab-${activeTab}`} className="flex-1 overflow-auto bg-white">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-app-accent"></div>
          </div>
        ) : activeTab === 'texts' ? (
          // Text Browser List
          sortedFilteredBooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary text-lg">
              No books match your filters
            </div>
          ) : (
            <div ref={tableRef} className="relative">
              <TextsTableHeader
                colWidths={colWidths}
                startResize={startResize}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSortClick}
              />
              <div
                // Content-aware key: when the filtered/sorted list identity
                // changes, fully remount the inner container so the previous
                // render's absolutely-positioned rows can't linger.
                key={`texts-${sortedFilteredBooks.length}-${sortKey}-${sortDir}-${searchQuery}-${[...selectedGenreIds].sort().join(',')}-${deathAhMin}-${deathAhMax}`}
                style={{
                  height: `${textVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {textVirtualizer.getVirtualItems().map((virtualRow) => {
                  const book = sortedFilteredBooks[virtualRow.index];
                  if (!book) return null;
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
                        colWidths={colWidths}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )
        ) : (
          // Author Browser List
          sortedFilteredAuthors.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary text-lg">
              No authors match your filters
            </div>
          ) : (
            <div ref={authorTableRef} className="relative">
              <AuthorTableHeader
                colWidths={authorColWidths}
                startResize={startAuthorResize}
                sortKey={authorSortKey}
                sortDir={authorSortDir}
                onSort={handleAuthorSortClick}
              />
              <div
                key={`authors-${sortedFilteredAuthors.length}-${authorSortKey}-${authorSortDir}-${searchQuery}-${[...selectedGenreIds].sort().join(',')}-${deathAhMin}-${deathAhMax}`}
                style={{
                  height: `${authorVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {authorVirtualizer.getVirtualItems().map((virtualRow) => {
                  const author = sortedFilteredAuthors[virtualRow.index];
                  if (!author) return null;
                  return (
                    <div
                      key={author.author_id ?? `unknown-${author.author}`}
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
                        colWidths={authorColWidths}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface TextsColWidths {
  title: number;
  author: number;
  death: number;
  genre: number;
}

type TextsSortKey = 'title' | 'author' | 'death' | 'genre';
type TextsSortDir = 'asc' | 'desc';

// Sticky table header with 4 columns and drag-resize handles between adjacent
// header cells. The same colWidths are passed to every BookListRow so cells
// stay aligned with the header.
function TextsTableHeader({
  colWidths,
  startResize,
  sortKey,
  sortDir,
  onSort,
}: {
  colWidths: TextsColWidths;
  startResize: (
    e: React.MouseEvent,
    leftKey: keyof TextsColWidths,
    rightKey: keyof TextsColWidths
  ) => void;
  sortKey: TextsSortKey;
  sortDir: TextsSortDir;
  onSort: (key: TextsSortKey) => void;
}) {
  // RTL: cumulative widths from the right edge map to "left:" offsets from the
  // container's left edge as (100 - cumulative)%.
  const handleAuthorPos = 100 - colWidths.title;
  const handleDeathPos = 100 - colWidths.title - colWidths.author;
  const handleGenrePos = 100 - colWidths.title - colWidths.author - colWidths.death;

  return (
    <div className="sticky top-0 z-10 bg-app-surface border-b border-app-border-light">
      <div
        dir="rtl"
        className="flex h-10 px-8 text-sm font-semibold text-app-text-tertiary select-none"
      >
        <HeaderCell
          width={colWidths.title}
          label="Title"
          sortKey="title"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.author}
          label="Author"
          sortKey="author"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.death}
          label="Death"
          sortKey="death"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.genre}
          label="Genre"
          sortKey="genre"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
      </div>
      {/* Drag handles overlay; absolute positioning relative to header bar */}
      <ResizeHandle leftPercent={handleAuthorPos} onMouseDown={(e) => startResize(e, 'title', 'author')} />
      <ResizeHandle leftPercent={handleDeathPos} onMouseDown={(e) => startResize(e, 'author', 'death')} />
      <ResizeHandle leftPercent={handleGenrePos} onMouseDown={(e) => startResize(e, 'death', 'genre')} />
    </div>
  );
}

function HeaderCell<K extends string>({
  width,
  label,
  sortKey,
  activeSort,
  sortDir,
  onSort,
}: {
  width: number;
  label: string;
  sortKey: K;
  activeSort: K;
  sortDir: TextsSortDir;
  onSort: (key: K) => void;
}) {
  const isActive = activeSort === sortKey;
  const arrow = !isActive ? '' : sortDir === 'asc' ? '▲' : '▼';
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      style={{ width: `${width}%` }}
      className={`px-3 flex items-center justify-center gap-1 truncate
                  cursor-pointer hover:text-app-accent transition-colors
                  ${isActive ? 'text-app-accent' : ''}`}
      dir="auto"
    >
      <span className="truncate">{label}</span>
      {arrow && <span className="text-[10px] flex-shrink-0">{arrow}</span>}
    </button>
  );
}

// Shared sort comparator so the texts list and the author drilldown agree.
function compareBooks(
  a: BookMetadata,
  b: BookMetadata,
  sortKey: TextsSortKey,
  sortDir: TextsSortDir,
  authorsMap: Map<number, string>,
  genresMap: Map<number, string>
): number {
  let cmp = 0;
  if (sortKey === 'title') {
    cmp = (a.title || '').localeCompare(b.title || '', 'ar');
  } else if (sortKey === 'author') {
    const aName = a.author_id !== undefined ? authorsMap.get(a.author_id) ?? '' : '';
    const bName = b.author_id !== undefined ? authorsMap.get(b.author_id) ?? '' : '';
    cmp = aName.localeCompare(bName, 'ar');
  } else if (sortKey === 'death') {
    const aDeath = a.death_ah ?? Infinity;
    const bDeath = b.death_ah ?? Infinity;
    if (aDeath === bDeath) {
      cmp = 0;
    } else if (!isFinite(aDeath)) {
      return 1;
    } else if (!isFinite(bDeath)) {
      return -1;
    } else {
      cmp = aDeath - bDeath;
    }
  } else if (sortKey === 'genre') {
    const aGenre = a.genre_id !== undefined ? genresMap.get(a.genre_id) ?? '' : '';
    const bGenre = b.genre_id !== undefined ? genresMap.get(b.genre_id) ?? '' : '';
    cmp = aGenre.localeCompare(bGenre, 'ar');
  }
  return sortDir === 'asc' ? cmp : -cmp;
}

type AuthorSortKey = 'name' | 'death' | 'books' | 'genres';

interface AuthorColWidths {
  name: number;
  death: number;
  books: number;
  genres: number;
}

// Sort comparator for the authors table. Same NULL-handling for death as
// compareBooks: unknown deaths always sink to the bottom regardless of
// direction.
function compareAuthors(
  a: AuthorInfo,
  b: AuthorInfo,
  sortKey: AuthorSortKey,
  sortDir: TextsSortDir
): number {
  let cmp = 0;
  if (sortKey === 'name') {
    cmp = a.author.localeCompare(b.author, 'ar');
  } else if (sortKey === 'death') {
    const aDeath = a.death_ah ?? Infinity;
    const bDeath = b.death_ah ?? Infinity;
    if (aDeath === bDeath) {
      cmp = 0;
    } else if (!isFinite(aDeath)) {
      return 1;
    } else if (!isFinite(bDeath)) {
      return -1;
    } else {
      cmp = aDeath - bDeath;
    }
  } else if (sortKey === 'books') {
    cmp = a.bookCount - b.bookCount;
  } else if (sortKey === 'genres') {
    // Sort by the genre listing string (alphabetical of joined genres)
    const aGenres = Array.from(a.genres).sort().join(', ');
    const bGenres = Array.from(b.genres).sort().join(', ');
    cmp = aGenres.localeCompare(bGenres, 'ar');
  }
  return sortDir === 'asc' ? cmp : -cmp;
}

function ResizeHandle({
  leftPercent,
  onMouseDown,
}: {
  leftPercent: number;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{ left: `${leftPercent}%` }}
      className="absolute top-0 bottom-0 -translate-x-1/2 w-2 cursor-col-resize
                 group flex items-center justify-center"
    >
      {/* Visible track on hover */}
      <div className="w-px h-full bg-app-border-medium group-hover:bg-app-accent transition-colors" />
    </div>
  );
}

// Book row in list view (4 columns aligned with the table header)
function BookListRow({
  book,
  onClick,
  authorsMap,
  genresMap,
  colWidths,
}: {
  book: BookMetadata;
  onClick: () => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
  colWidths: TextsColWidths;
}) {
  const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;
  const death =
    book.death_ah !== undefined && book.death_ah !== 0 ? `${book.death_ah} AH` : '';

  return (
    <div
      onClick={onClick}
      className="h-[64px] px-8 flex items-center cursor-pointer border-b border-app-border-light
                 hover:bg-app-accent-light transition-colors"
      dir="rtl"
    >
      <BookCell width={colWidths.title} arabic>
        {book.title}
      </BookCell>
      <BookCell width={colWidths.author} arabic muted>
        {authorName || 'Unknown'}
      </BookCell>
      <BookCell width={colWidths.death}>{death || '—'}</BookCell>
      <BookCell width={colWidths.genre} capitalize>
        {genreName || '—'}
      </BookCell>
    </div>
  );
}

function BookCell({
  width,
  arabic,
  muted,
  capitalize,
  children,
}: {
  width: number;
  arabic?: boolean;
  muted?: boolean;
  capitalize?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ width: `${width}%` }}
      className={`px-3 truncate ${arabic ? 'text-2xl font-arabic leading-loose' : 'text-base'} ${
        muted ? 'text-app-text-secondary' : 'text-app-text-primary'
      } ${capitalize ? 'capitalize' : ''}`}
      dir="auto"
    >
      {children}
    </div>
  );
}

// Sticky table header for the authors browser. Mirrors TextsTableHeader but
// with the four authors-table columns and a generic-typed HeaderCell.
function AuthorTableHeader({
  colWidths,
  startResize,
  sortKey,
  sortDir,
  onSort,
}: {
  colWidths: AuthorColWidths;
  startResize: (
    e: React.MouseEvent,
    leftKey: keyof AuthorColWidths,
    rightKey: keyof AuthorColWidths
  ) => void;
  sortKey: AuthorSortKey;
  sortDir: TextsSortDir;
  onSort: (key: AuthorSortKey) => void;
}) {
  // RTL: positions are computed as 100 - cumulative-from-right.
  const handleDeathPos = 100 - colWidths.name;
  const handleBooksPos = 100 - colWidths.name - colWidths.death;
  const handleGenresPos = 100 - colWidths.name - colWidths.death - colWidths.books;

  return (
    <div className="sticky top-0 z-10 bg-app-surface border-b border-app-border-light">
      <div
        dir="rtl"
        className="flex h-10 px-8 text-sm font-semibold text-app-text-tertiary select-none"
      >
        <HeaderCell
          width={colWidths.name}
          label="Name"
          sortKey="name"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.death}
          label="Death"
          sortKey="death"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.books}
          label="# of Books"
          sortKey="books"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <HeaderCell
          width={colWidths.genres}
          label="Genres"
          sortKey="genres"
          activeSort={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
      </div>
      <ResizeHandle leftPercent={handleDeathPos} onMouseDown={(e) => startResize(e, 'name', 'death')} />
      <ResizeHandle leftPercent={handleBooksPos} onMouseDown={(e) => startResize(e, 'death', 'books')} />
      <ResizeHandle leftPercent={handleGenresPos} onMouseDown={(e) => startResize(e, 'books', 'genres')} />
    </div>
  );
}

// Author row in list view (4 columns aligned with the author table header)
function AuthorListRow({
  author,
  onClick,
  colWidths,
}: {
  author: AuthorInfo;
  onClick: () => void;
  colWidths: AuthorColWidths;
}) {
  const death =
    author.death_ah !== undefined && author.death_ah !== 0 ? `${author.death_ah} AH` : '—';
  const genresText = Array.from(author.genres).join(', ') || '—';

  return (
    <div
      onClick={onClick}
      className="h-[64px] px-8 flex items-center cursor-pointer border-b border-app-border-light
                 hover:bg-app-accent-light transition-colors"
      dir="rtl"
    >
      <AuthorCell width={colWidths.name} arabic>
        {author.author}
      </AuthorCell>
      <AuthorCell width={colWidths.death}>{death}</AuthorCell>
      <AuthorCell width={colWidths.books}>{author.bookCount}</AuthorCell>
      <AuthorCell width={colWidths.genres} capitalize>
        {genresText}
      </AuthorCell>
    </div>
  );
}

function AuthorCell({
  width,
  arabic,
  capitalize,
  children,
}: {
  width: number;
  arabic?: boolean;
  capitalize?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ width: `${width}%` }}
      className={`px-3 truncate text-app-text-primary ${
        arabic ? 'text-2xl font-arabic leading-loose' : 'text-base'
      } ${capitalize ? 'capitalize' : ''}`}
      dir="auto"
    >
      {children}
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
  colWidths,
  startResize,
  sortKey,
  sortDir,
  onSort,
}: {
  author: AuthorInfo;
  books: BookMetadata[];
  onBack: () => void;
  onClose: () => void;
  onBookClick: (book: BookMetadata) => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
  colWidths: TextsColWidths;
  startResize: (
    e: React.MouseEvent,
    leftKey: keyof TextsColWidths,
    rightKey: keyof TextsColWidths
  ) => void;
  sortKey: TextsSortKey;
  sortDir: TextsSortDir;
  onSort: (key: TextsSortKey) => void;
}) {
  const listParentRef = useRef<HTMLDivElement>(null);

  // Apply the same sort that's used by the main texts list, so the per-author
  // drilldown stays consistent when the user toggles a header.
  const sortedBooks = useMemo(() => {
    const out = [...books];
    out.sort((a, b) => compareBooks(a, b, sortKey, sortDir, authorsMap, genresMap));
    return out;
  }, [books, sortKey, sortDir, authorsMap, genresMap]);

  const virtualizer = useVirtualizer({
    count: sortedBooks.length,
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
        <div className="relative">
          <TextsTableHeader
            colWidths={colWidths}
            startResize={startResize}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
          />
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const book = sortedBooks[virtualRow.index];
              if (!book) return null;
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
                    colWidths={colWidths}
                  />
                </div>
              );
            })}
          </div>
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
export function BookDetailView({
  book,
  onBack,
  backLabel = 'Back to List',
  onClose,
  authorsMap,
  genresMap,
}: {
  book: BookMetadata;
  /** When omitted, the back button is hidden. */
  onBack?: () => void;
  /** Custom label for the back button. Defaults to "Back to List". */
  backLabel?: string;
  /** When omitted, the close (×) button is hidden. */
  onClose?: () => void;
  authorsMap: Map<number, string>;
  genresMap: Map<number, string>;
}) {
  const tags = parseJsonArray(book.tags);
  const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;

  return (
    <div className="fixed inset-0 bg-app-bg z-50 flex flex-col">
      {/* Header */}
      <div className="px-8 py-5 border-b border-app-border-light bg-white flex items-center gap-4 shadow-sm">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 text-app-text-secondary hover:text-app-accent
                     hover:bg-app-accent-light rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="font-medium">{backLabel}</span>
          </button>
        )}
        <div className="flex-1" />
        {onClose && (
          <button
            onClick={onClose}
            className="w-10 h-10 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                     flex items-center justify-center text-app-text-secondary text-xl transition-colors"
          >
            ×
          </button>
        )}
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
          <TagsRow tags={tags} />

          {/* Basic Metadata Grid */}
          <div className="bg-white rounded-xl p-6 shadow-app-md">
            <h2 className="text-lg font-semibold text-app-text-primary mb-4">Kashshāf Data</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
              {/* Row 1 */}
              <MetadataField
                label="Kashshāf ID"
                value={book.id.toString()}
                tooltip="Unique book ID within the Kashshāf corpus"
              />
              <MetadataField label="Genre" value={genreName || '—'} capitalize />
              <MetadataField label="Token Count" value={book.token_count?.toLocaleString() || '—'} />
              {/* Row 2 */}
              <MetadataField
              label="Author ID" 
              value={book.author_id?.toString() || '—'}
              tooltip="Unique author ID within the Kashshāf corpus" />
              <MetadataField label="Death" value={book.death_ah !== undefined ? `${book.death_ah} AH` : '—'} />
              <MetadataField label="Page Count" value={book.page_count?.toLocaleString() || '—'} />
              {/* Row 3 (Source ID spans the remaining 2 columns) */}
              <MetadataField
                label="Source Corpus"
                value={book.corpus || '—'}
                tooltip="The source corpus from which this text was taken"
              />
              <MetadataField
                label="Source ID"
                value={book.original_id || '—'}
                className="md:col-span-2"
                tooltip="The unique ID of this text within the source corpus"
              />
            </div>
          </div>

          {/* Structured metadata from metadata_json */}
          <MetadataJsonView jsonStr={book.metadata_json} paginated={book.paginated} />

          {/* Citation */}
          <div className="bg-white rounded-xl p-6 shadow-app-md">
            <h2 className="text-lg font-semibold text-app-text-primary mb-4">Citation</h2>
            <CitationBlock book={book} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// metadata_json rendering
// ---------------------------------------------------------------------------

interface MetadataValue {
  value_raw: string;
  source_key?: string;
}

interface MetadataPerson {
  name_raw: string;
  role_raw?: string;
  source_key?: string;
}

interface ParsedMetadata {
  titles?: {
    main?: MetadataValue[];
    [key: string]: MetadataValue[] | undefined;
  };
  responsible_persons?: {
    authors?: MetadataPerson[];
    editors?: MetadataPerson[];
    translators?: MetadataPerson[];
    commentators?: MetadataPerson[];
    arrangers?: MetadataPerson[];
    reviewers?: MetadataPerson[];
    transmitters?: MetadataPerson[];
    preface_by?: MetadataPerson[];
    transcribers?: MetadataPerson[];
    digital_encoders?: MetadataPerson[];
    digital_preparers?: MetadataPerson[];
    contributors?: MetadataPerson[];
    [key: string]: MetadataPerson[] | undefined;
  };
  publication?: {
    publishers?: MetadataValue[];
    places?: MetadataValue[];
    dates?: MetadataValue[];
    edition?: MetadataValue[];
    series?: MetadataValue[];
    volumes?: MetadataValue[];
    page_range?: MetadataValue[];
    page_count_meta?: MetadataValue[];
    container_titles?: MetadataValue[];
    [key: string]: MetadataValue[] | undefined;
  };
}

function parseMetadataJson(jsonStr?: string | null): ParsedMetadata | null {
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as ParsedMetadata;
  } catch {
    return null;
  }
}

// Subsections of responsible_persons that belong under "Edition Information".
// Authors live under "Book Metadata" instead, so they're excluded here.
const EDITION_PERSON_FIELDS: Array<[string, string]> = [
  ['editors', 'Editors'],
  ['translators', 'Translators'],
  ['commentators', 'Commentators'],
  ['arrangers', 'Arrangers'],
  ['reviewers', 'Reviewers'],
  ['transmitters', 'Transmitters'],
  ['preface_by', 'Preface By'],
  ['transcribers', 'Transcribers'],
  ['digital_encoders', 'Digital Encoders'],
  ['digital_preparers', 'Digital Preparers'],
  ['contributors', 'Contributors'],
];

const PUBLICATION_FIELDS: Array<[string, string]> = [
  ['publishers', 'Publisher'],
  ['places', 'Place'],
  ['dates', 'Date'],
  ['edition', 'Edition'],
  ['series', 'Series'],
  ['volumes', 'Volumes'],
  ['page_range', 'Page Range'],
  ['page_count_meta', 'Page Count'],
  ['container_titles', 'Container Title'],
];

function MetadataJsonView({
  jsonStr,
  paginated,
}: {
  jsonStr?: string | null;
  paginated?: boolean;
}) {
  const meta = useMemo(() => parseMetadataJson(jsonStr), [jsonStr]);
  // Render the block whenever there's metadata OR a pagination warning to surface.
  // The block itself decides whether to bail when there's truly nothing to show.
  return <BookAndEditionMetadataBlock meta={meta} paginated={paginated} />;
}

interface MetadataRowSpec {
  label: string;
  values: string[];
}

function BookAndEditionMetadataBlock({
  meta,
  paginated,
}: {
  meta: ParsedMetadata | null;
  paginated?: boolean;
}) {
  const rows: MetadataRowSpec[] = [];

  if (meta) {
    // Title (only `titles.main`)
    pushRow(rows, 'Title', cleanValues(meta.titles?.main));

    // Author (only `responsible_persons.authors`, name_raw only)
    pushRow(rows, 'Author', cleanNames(meta.responsible_persons?.authors));

    // Publication fields. Each is dropped if every value_raw is blank
    // (handles the "if Date is blank do not show it" case generically).
    // Volumes is also pruned: if the only value is "1" (a single-volume work),
    // there's nothing useful to display, so suppress the row entirely.
    if (meta.publication) {
      for (const [key, label] of PUBLICATION_FIELDS) {
        let values = cleanValues(meta.publication[key]);
        if (key === 'volumes') {
          values = values.filter((v) => {
            const trimmed = v.trim();
            return trimmed !== '1' && trimmed !== '١';
          });
        }
        pushRow(rows, label, values);
      }
    }

    // Non-author responsible persons (name_raw only, no role)
    if (meta.responsible_persons) {
      for (const [key, label] of EDITION_PERSON_FIELDS) {
        pushRow(rows, label, cleanNames(meta.responsible_persons[key]));
      }
    }
  }

  // Only flag pagination as mismatched when paginated is explicitly false.
  // Undefined/missing means "we don't know," which we don't claim about.
  const showPaginationWarning = paginated === false;

  if (rows.length === 0 && !showPaginationWarning) return null;

  return (
    <div className="bg-white rounded-xl p-6 shadow-app-md">
      <h2 className="text-lg font-semibold text-app-text-primary mb-4">
        Book and Edition Metadata
      </h2>
      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => (
            <MetadataRow key={row.label} label={row.label} values={row.values} />
          ))}
        </div>
      )}
      {showPaginationWarning && (
        <div
          className={`text-sm font-medium text-red-600 ${
            rows.length > 0 ? 'mt-4 pt-4 border-t border-app-border-light' : ''
          }`}
        >
          Kashshāf pagination does not match a printed edition
        </div>
      )}
    </div>
  );
}

function pushRow(rows: MetadataRowSpec[], label: string, values: string[]) {
  if (values.length > 0) {
    rows.push({ label, values });
  }
}

function cleanValues(items: MetadataValue[] | undefined): string[] {
  if (!items) return [];
  return items.map((it) => it.value_raw).filter((v) => typeof v === 'string' && v.trim().length > 0);
}

function cleanNames(items: MetadataPerson[] | undefined): string[] {
  if (!items) return [];
  return items.map((p) => p.name_raw).filter((v) => typeof v === 'string' && v.trim().length > 0);
}

function MetadataRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex flex-col md:flex-row md:gap-4">
      <div className="text-sm text-app-text-tertiary font-medium md:w-48 md:flex-shrink-0">
        {label}
      </div>
      <div className="flex-1 space-y-1">
        {values.map((v, i) => (
          <div key={i} className="text-app-text-primary text-right" dir="rtl">
            {v}
          </div>
        ))}
      </div>
    </div>
  );
}

function MetadataField({
  label,
  value,
  capitalize = false,
  className = '',
  tooltip,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
  className?: string;
  tooltip?: string;
}) {
  return (
    <div className={className}>
      <div className="text-sm text-app-text-tertiary font-medium mb-1 flex items-center gap-1.5">
        <span>{label}</span>
        {tooltip && <InfoTooltip content={tooltip} />}
      </div>
      <div className={`text-lg text-app-text-primary ${capitalize ? 'capitalize' : ''}`}>
        {value}
      </div>
    </div>
  );
}

const TAGS_PREVIEW = 3;

// Tag list with collapse/expand. The first TAGS_PREVIEW tags are always visible;
// when there are more, an ellipsis chip plus an "Expand" button reveal the rest.
function TagsRow({ tags }: { tags: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tags.length === 0) return null;

  const hasMore = tags.length > TAGS_PREVIEW;
  const visible = expanded || !hasMore ? tags : tags.slice(0, TAGS_PREVIEW);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((tag, idx) => (
        <span
          key={idx}
          className="px-3 py-1 text-sm bg-app-accent-light text-app-accent rounded-full"
        >
          {tag}
        </span>
      ))}
      {hasMore && !expanded && (
        <span className="px-3 py-1 text-sm bg-app-accent-light text-app-accent rounded-full">
          …
        </span>
      )}
      {hasMore && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="px-3 py-1 text-sm font-medium text-app-accent border border-app-accent
                     rounded-full hover:bg-app-accent hover:text-white transition-colors"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </div>
  );
}

