import { useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { stripPunctuation } from '@kashshaf/shared';

/**
 * The book browser (spec §7.1): pick the one text every other panel will
 * operate on.
 *
 * The corpus is a few thousand books, so this filters in the browser over the
 * list the backend already returned rather than round-tripping per keystroke.
 */

/** Search matches titles with the same punctuation handling as Kashshaf. */
function matches(book: BookMetadata, needle: string): boolean {
  if (!needle) return true;
  const hay = stripPunctuation(book.title ?? '').toLowerCase();
  return hay.includes(needle) || String(book.id) === needle;
}

export function BookBrowser({
  books,
  currentId,
  onSelect,
  loading,
  error,
}: {
  books: BookMetadata[];
  currentId: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState('');
  const needle = useMemo(() => stripPunctuation(query).toLowerCase(), [query]);
  const shown = useMemo(() => books.filter((b) => matches(b, needle)), [books, needle]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-app-border-light">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles…"
          aria-label="Search titles"
          dir="rtl"
          className="w-full px-3 py-2 text-sm border border-app-border-medium rounded
                     focus:outline-none focus:border-app-border-focus font-arabic"
        />
        <div className="mt-2 text-xs text-app-text-tertiary" data-testid="book-count">
          {loading
            ? 'Loading books…'
            : error
              ? 'Books unavailable'
              : `${shown.length.toLocaleString()} of ${books.length.toLocaleString()} books`}
        </div>
      </div>

      {error && (
        <div className="p-3 text-sm text-app-error" role="alert">
          {error}
        </div>
      )}

      <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Books">
        {shown.map((b) => (
          <li key={b.id}>
            <button
              role="option"
              aria-selected={b.id === currentId}
              onClick={() => onSelect(b.id)}
              className={`w-full text-right px-3 py-2 border-b border-app-border-light
                          hover:bg-app-surface-variant ${
                            b.id === currentId ? 'bg-app-accent-light' : ''
                          }`}
            >
              <div className="font-arabic text-base text-app-text-primary leading-snug" dir="rtl">
                {b.title}
              </div>
              <div className="text-xs text-app-text-tertiary flex gap-2 justify-end mt-0.5">
                {b.death_ah != null && <span>d. {b.death_ah} AH</span>}
                {b.page_count != null && <span>{b.page_count.toLocaleString()} pp.</span>}
                <span>#{b.id}</span>
              </div>
            </button>
          </li>
        ))}
        {!loading && !error && shown.length === 0 && (
          <li className="p-3 text-sm text-app-text-tertiary">No book matches that.</li>
        )}
      </ul>
    </div>
  );
}
