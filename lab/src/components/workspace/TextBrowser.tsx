import { useCallback, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { normalizeArabicForSearch } from '@kashshaf/shared';
import { VirtualTable, type Column } from '../stats/VirtualTable';

/**
 * The text search of the workspace view (spec 1.5 §A1), reproducing
 * Kashshaf's Text Selection / Metadata Browser: one search box over titles
 * and author names with Arabic normalisation, a death-year range, a genre
 * filter and a corpus filter, over sortable columns.
 *
 * Everything filters in the browser over the list the backend already
 * returned. The corpus is a few thousand books; a round trip per keystroke
 * would be slower and would behave differently in the two modes.
 */

export interface BrowserFilters {
  query: string;
  deathMin: string;
  deathMax: string;
  genreIds: Set<number>;
  corpora: Set<string>;
}

export const NO_FILTERS: BrowserFilters = {
  query: '',
  deathMin: '',
  deathMax: '',
  genreIds: new Set(),
  corpora: new Set(),
};

/** Kashshaf's rule: a book matches on its title or on its author's name. */
export function matchesQuery(book: BookMetadata, needle: string, authorName: string): boolean {
  if (!needle) return true;
  if (String(book.id) === needle) return true;
  return (
    normalizeArabicForSearch(book.title ?? '').includes(needle) ||
    (authorName ? normalizeArabicForSearch(authorName).includes(needle) : false)
  );
}

export function filterBooks(
  books: BookMetadata[],
  f: BrowserFilters,
  authors: Map<number, string>
): BookMetadata[] {
  const needle = normalizeArabicForSearch(f.query.trim());
  const min = f.deathMin.trim() ? Number(f.deathMin) : null;
  const max = f.deathMax.trim() ? Number(f.deathMax) : null;
  return books.filter((b) => {
    if (min != null && !Number.isNaN(min) && (b.death_ah == null || b.death_ah < min)) return false;
    if (max != null && !Number.isNaN(max) && (b.death_ah == null || b.death_ah > max)) return false;
    if (f.genreIds.size > 0 && (b.genre_id == null || !f.genreIds.has(b.genre_id))) return false;
    if (f.corpora.size > 0 && !f.corpora.has(b.corpus ?? '')) return false;
    return matchesQuery(b, needle, (b.author_id != null ? authors.get(b.author_id) : '') ?? '');
  });
}

export function TextBrowser({
  books,
  authors,
  genres,
  inWorkspace,
  onSelect,
  loading,
  error,
}: {
  books: BookMetadata[];
  authors: Map<number, string>;
  genres: Map<number, string>;
  /** Book ids already in the workspace, marked in the list. */
  inWorkspace: Set<number>;
  onSelect: (book: BookMetadata) => void;
  loading: boolean;
  error: string | null;
}) {
  const [f, setF] = useState<BrowserFilters>(NO_FILTERS);
  const [genresOpen, setGenresOpen] = useState(false);

  const corpora = useMemo(
    () => [...new Set(books.map((b) => b.corpus).filter((c): c is string => !!c))].sort(),
    [books]
  );
  const usedGenres = useMemo(() => {
    const ids = new Set(books.map((b) => b.genre_id).filter((g): g is number => g != null));
    return [...ids].map((id) => ({ id, name: genres.get(id) ?? `#${id}` })).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [books, genres]);

  const shown = useMemo(() => filterBooks(books, f, authors), [books, f, authors]);
  const active = !!(f.query || f.deathMin || f.deathMax || f.genreIds.size || f.corpora.size);

  const toggleGenre = useCallback((id: number) => {
    setF((prev) => {
      const next = new Set(prev.genreIds);
      if (!next.delete(id)) next.add(id);
      return { ...prev, genreIds: next };
    });
  }, []);

  const toggleCorpus = useCallback((c: string) => {
    setF((prev) => {
      const next = new Set(prev.corpora);
      if (!next.delete(c)) next.add(c);
      return { ...prev, corpora: next };
    });
  }, []);

  const columns: Column<BookMetadata>[] = useMemo(
    () => [
      {
        key: 'title',
        label: 'Title',
        rtl: true,
        width: '38%',
        sortValue: (b) => b.title ?? '',
        render: (b) => (
          <span>
            {inWorkspace.has(b.id) && <span className="text-app-accent ltr:mr-1 rtl:ml-1" title="In the workspace">●</span>}
            {b.title}
          </span>
        ),
      },
      {
        key: 'author',
        label: 'Author',
        rtl: true,
        width: '26%',
        sortValue: (b) => (b.author_id != null ? authors.get(b.author_id) ?? '' : ''),
      },
      {
        key: 'death',
        label: 'Died',
        align: 'right',
        width: '9%',
        defaultSort: 'asc',
        sortValue: (b) => b.death_ah ?? null,
        render: (b) => (b.death_ah != null ? `${b.death_ah} AH` : '—'),
      },
      {
        key: 'genre',
        label: 'Genre',
        rtl: true,
        width: '17%',
        sortValue: (b) => (b.genre_id != null ? genres.get(b.genre_id) ?? '' : ''),
      },
      {
        key: 'pages',
        label: 'Pages',
        align: 'right',
        width: '10%',
        sortValue: (b) => b.page_count ?? null,
        render: (b) => (b.page_count != null ? b.page_count.toLocaleString() : '—'),
      },
    ],
    [authors, genres, inWorkspace]
  );

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="text-browser">
      <div className="px-4 py-3 border-b border-app-border-light bg-app-surface space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={f.query}
            onChange={(e) => setF({ ...f, query: e.target.value })}
            placeholder="Search titles and authors…"
            aria-label="Search titles and authors"
            dir="rtl"
            className="flex-1 px-3 py-2 font-arabic text-lg border border-app-border-medium rounded focus:outline-none focus:border-app-border-focus"
          />
          {active && (
            <button onClick={() => setF(NO_FILTERS)} className="px-2 py-1 text-xs border border-app-border-medium rounded">
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            Died between
            <input
              value={f.deathMin}
              onChange={(e) => setF({ ...f, deathMin: e.target.value })}
              inputMode="numeric"
              aria-label="Death year, from"
              className="w-16 px-1.5 py-1 border border-app-border-medium rounded tabular-nums"
            />
            and
            <input
              value={f.deathMax}
              onChange={(e) => setF({ ...f, deathMax: e.target.value })}
              inputMode="numeric"
              aria-label="Death year, to"
              className="w-16 px-1.5 py-1 border border-app-border-medium rounded tabular-nums"
            />
            AH
          </label>

          <div className="relative">
            <button
              onClick={() => setGenresOpen((v) => !v)}
              className="px-2 py-1 border border-app-border-medium rounded"
              aria-expanded={genresOpen}
            >
              Genre{f.genreIds.size > 0 ? ` (${f.genreIds.size})` : ''} ▾
            </button>
            {genresOpen && (
              <div className="absolute z-20 mt-1 w-72 max-h-72 overflow-y-auto bg-app-surface border border-app-border-medium rounded shadow-lg p-1">
                {usedGenres.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 px-2 py-1 hover:bg-app-surface-variant cursor-pointer">
                    <input type="checkbox" checked={f.genreIds.has(g.id)} onChange={() => toggleGenre(g.id)} />
                    <span className="font-arabic" dir="rtl">
                      {g.name}
                    </span>
                  </label>
                ))}
                {usedGenres.length === 0 && <div className="px-2 py-1 text-app-text-tertiary">No genres in this corpus.</div>}
              </div>
            )}
          </div>

          {corpora.length > 1 &&
            corpora.map((c) => (
              <button
                key={c}
                onClick={() => toggleCorpus(c)}
                className={`px-2 py-1 border rounded ${
                  f.corpora.has(c) ? 'bg-app-accent-light border-app-accent text-app-accent' : 'border-app-border-medium'
                }`}
              >
                {c}
              </button>
            ))}

          <span className="text-app-text-tertiary ltr:ml-auto" data-testid="browser-count">
            {loading
              ? 'Loading texts…'
              : error
                ? 'Texts unavailable'
                : `${shown.length.toLocaleString()} of ${books.length.toLocaleString()} texts`}
          </span>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-app-error" role="alert">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <VirtualTable
          columns={columns}
          rows={shown}
          rowKey={(b) => b.id}
          onRowClick={onSelect}
          height="fill"
          emptyText={loading ? 'Loading texts…' : 'No text matches that.'}
          testId="text-table"
        />
      </div>
    </div>
  );
}
