import { createContext, useContext, useState, useEffect, useMemo, ReactNode, useCallback } from 'react';
import type { BookMetadata } from '../types';
import type { SearchAPI } from '../api';

interface BooksContextValue {
  /** All books loaded at startup */
  books: BookMetadata[];
  /** Map of book ID to book metadata for O(1) lookups */
  booksMap: Map<number, BookMetadata>;
  /** All authors as [id, name] pairs */
  authors: [number, string][];
  /** Map of author ID to author name for O(1) lookups */
  authorsMap: Map<number, string>;
  /** All genres as [id, name] pairs */
  genres: [number, string][];
  /** Map of genre ID to genre name for O(1) lookups */
  genresMap: Map<number, string>;
  /** Loading state */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Reload books data (useful after mode change) */
  reload: () => Promise<void>;
}

const BooksContext = createContext<BooksContextValue | null>(null);

interface BooksProviderProps {
  children: ReactNode;
  /** The API instance to use for data access */
  api: SearchAPI;
}

export function BooksProvider({ children, api }: BooksProviderProps) {
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [authors, setAuthors] = useState<[number, string][]>([]);
  const [genres, setGenres] = useState<[number, string][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load all books, authors, and genres
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      console.log('[BooksContext] Loading metadata from API...');
      const [booksData, authorsData, genresData] = await Promise.all([
        api.getAllBooks(),
        api.getAuthors(),
        api.getGenres(),
      ]);
      console.log(`[BooksContext] Loaded ${booksData.length} books, ${authorsData.length} authors, ${genresData.length} genres`);
      setBooks(booksData);
      setAuthors(authorsData);
      setGenres(genresData);
      setError(null);
    } catch (err) {
      console.error('[BooksContext] Failed to load books:', err);
      setError(`Failed to load books: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Load data on mount and when API changes
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Create a Map for O(1) lookups by ID
  const booksMap = useMemo(() => {
    const map = new Map<number, BookMetadata>();
    for (const book of books) {
      map.set(book.id, book);
    }
    return map;
  }, [books]);

  // Create author lookup map
  const authorsMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const [id, name] of authors) {
      map.set(id, name);
    }
    return map;
  }, [authors]);

  // Create genre lookup map
  const genresMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const [id, name] of genres) {
      map.set(id, name);
    }
    return map;
  }, [genres]);

  const value: BooksContextValue = {
    books,
    booksMap,
    authors,
    authorsMap,
    genres,
    genresMap,
    loading,
    error,
    reload: loadData,
  };

  return (
    <BooksContext.Provider value={value}>
      {children}
    </BooksContext.Provider>
  );
}

export function useBooks(): BooksContextValue {
  const context = useContext(BooksContext);
  if (!context) {
    throw new Error('useBooks must be used within a BooksProvider');
  }
  return context;
}
