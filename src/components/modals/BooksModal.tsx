import { useState, useEffect } from 'react';
import type { BookMetadata } from '../../types';
import { listBooks } from '../../api/tauri';
import { useBooks } from '../../contexts/BooksContext';

interface BooksModalProps {
  onClose: () => void;
  onSelectBook: (bookId: number) => void;
}

export function BooksModal({ onClose, onSelectBook }: BooksModalProps) {
  const { authorsMap, genres, genresMap } = useBooks();
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<number | null>(null);

  useEffect(() => {
    loadBooks();
  }, [selectedGenre]);

  async function loadBooks() {
    setLoading(true);
    try {
      const result = await listBooks(
        selectedGenre ?? undefined,
        undefined,
        undefined,
        100,
        0
      );
      setBooks(result);
    } catch (err) {
      console.error('Failed to load books:', err);
    } finally {
      setLoading(false);
    }
  }

  // Filter books by search term
  const filteredBooks = books.filter((book) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
    return (
      book.title.toLowerCase().includes(term) ||
      (authorName && authorName.toLowerCase().includes(term))
    );
  });

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-app-lg w-[900px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-8 py-5 border-b border-app-border-light flex items-center gap-5">
          <h2 className="text-xl font-semibold text-app-text-primary">📚 Browse Texts</h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="w-9 h-9 bg-app-surface-variant rounded-lg hover:bg-red-50 hover:text-red-600
                     flex items-center justify-center text-app-text-secondary text-lg transition-colors"
          >
            ×
          </button>
        </div>

        {/* Filters */}
        <div className="px-8 py-5 border-b border-app-border-light flex gap-5 bg-app-surface-variant">
          <input
            type="text"
            placeholder="Search titles or authors..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 h-12 px-5 rounded-lg border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light bg-white"
          />
          <select
            value={selectedGenre ?? ''}
            onChange={(e) => setSelectedGenre(e.target.value ? Number(e.target.value) : null)}
            className="h-12 px-5 rounded-lg border border-app-border-medium
                     focus:outline-none focus:border-app-accent bg-white cursor-pointer"
          >
            <option value="">All genres</option>
            {genres.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>

        {/* Books Grid */}
        <div className="flex-1 overflow-y-auto p-8">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-app-accent"></div>
            </div>
          ) : filteredBooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-app-text-tertiary">
              <span className="text-4xl mb-2">📭</span>
              No books found
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-5">
              {filteredBooks.map((book) => {
                const authorName = book.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
                const genreName = book.genre_id !== undefined ? genresMap.get(book.genre_id) : undefined;
                return (
                  <div
                    key={book.id}
                    onClick={() => onSelectBook(book.id)}
                    className="p-6 border border-app-border-light rounded-xl cursor-pointer
                             hover:border-app-accent hover:bg-app-accent-light hover:shadow-sm transition-all"
                  >
                    <h3
                      dir="rtl"
                      className="text-base font-semibold text-app-accent font-arabic truncate"
                    >
                      {book.title}
                    </h3>
                    <p
                      dir="rtl"
                      className="text-sm text-app-text-secondary font-arabic mt-1.5 truncate"
                    >
                      {authorName || 'Unknown author'}
                    </p>
                    <div className="flex gap-4 mt-4 text-xs text-app-text-tertiary">
                      {book.death_ah && (
                        <span className="bg-app-surface-variant px-3 py-1 rounded">
                          d. {book.death_ah} AH
                        </span>
                      )}
                      {genreName && (
                        <span className="bg-app-surface-variant px-3 py-1 rounded capitalize">
                          {genreName}
                        </span>
                      )}
                      {book.page_count && (
                        <span className="bg-app-surface-variant px-3 py-1 rounded">
                          {book.page_count} pages
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
