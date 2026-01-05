import { createContext, useContext, useState, useEffect, useMemo, ReactNode, useCallback } from 'react';
import type { BookMetadata } from '../types';
import type { SearchAPI } from '../api';

interface BooksContextValue {
  /** All books loaded at startup */
  books: BookMetadata[];
  /** Map of book ID to book metadata for O(1) lookups */
  booksMap: Map<number, BookMetadata>;
  /** All genres with counts */
  genres: [string, number][];
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
  const [genres, setGenres] = useState<[string, number][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load all books and genres
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [booksData, genresData] = await Promise.all([
        api.getAllBooks(),
        api.getGenres(),
      ]);
      setBooks(booksData);
      setGenres(genresData);
      setError(null);
    } catch (err) {
      console.error('Failed to load books:', err);
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

  const value: BooksContextValue = {
    books,
    booksMap,
    genres,
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
