import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { workspaceApi, whenAccessed, type WorkspaceEntry } from '../../api/workspace';
import { TextBrowser } from './TextBrowser';
import { BookDetail } from './BookDetail';
import { Notice } from '../ui/Running';

/**
 * What Lab opens to (spec 1.5 §A1).
 *
 * Left, narrow: the texts already in the workspace, by name or by when they
 * were last opened, the current one marked. Right: the whole corpus, searched
 * and filtered, and the metadata of whichever text is being looked at.
 *
 * The workspace is the unit of work from here on. A text is added to it
 * deliberately; adding creates its folder on disk (§A2), and every panel
 * afterwards operates on the text the workspace opened.
 */

type Sort = { key: 'title' | 'accessed'; dir: 'asc' | 'desc' };

export function WorkspaceView({
  entries,
  currentId,
  books,
  authors,
  genres,
  booksLoading,
  booksError,
  onOpen,
  onChanged,
}: {
  entries: WorkspaceEntry[];
  currentId: number | null;
  books: BookMetadata[];
  authors: Map<number, string>;
  genres: Map<number, string>;
  booksLoading: boolean;
  booksError: string | null;
  /** Load this text and leave the workspace view (spec §A3). */
  onOpen: (bookId: number) => void;
  /** The workspace changed on disk; the shell reloads its list. */
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<BookMetadata | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'accessed', dir: 'desc' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceEntry | null>(null);

  const ids = useMemo(() => new Set(entries.map((e) => e.book_id)), [entries]);

  const sorted = useMemo(() => {
    const out = [...entries];
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) =>
      sort.key === 'title'
        ? sign * a.title.localeCompare(b.title, 'ar')
        : sign * (Date.parse(a.accessed) - Date.parse(b.accessed))
    );
    return out;
  }, [entries, sort]);

  const clickHeader = (key: Sort['key']) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' ? 'asc' : 'desc' }));

  const add = useCallback(
    async (book: BookMetadata) => {
      setBusy(true);
      setError(null);
      try {
        await workspaceApi.add(book.id, book.author_id != null ? authors.get(book.author_id) ?? null : null);
        onChanged();
        setMessage(`${book.title} added to the workspace.`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [authors, onChanged]
  );

  const remove = useCallback(
    async (entry: WorkspaceEntry) => {
      setConfirmRemove(null);
      setBusy(true);
      setError(null);
      try {
        await workspaceApi.remove(entry.book_id);
        onChanged();
        setMessage(`${entry.title} removed. Its folder is gone; what it found is still in the database.`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged]
  );

  // A message is a receipt, not a state: it goes on its own.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <div className="flex-1 flex min-h-0" data-testid="workspace-view">
      <aside className="w-[280px] shrink-0 border-r border-app-border-light bg-app-surface flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-app-border-light">
          <h2 className="text-sm font-semibold">Workspace</h2>
          <p className="text-[11px] text-app-text-tertiary mt-0.5">
            {entries.length === 0 ? 'No texts yet' : `${entries.length} text${entries.length === 1 ? '' : 's'}`}
          </p>
        </div>

        <div className="flex text-[11px] text-app-text-tertiary border-b border-app-border-light bg-app-surface-variant">
          <button onClick={() => clickHeader('title')} className="flex-1 text-left px-3 py-1.5 hover:text-app-text-primary">
            Name {sort.key === 'title' && (sort.dir === 'asc' ? '▲' : '▼')}
          </button>
          <button onClick={() => clickHeader('accessed')} className="w-24 text-right px-3 py-1.5 hover:text-app-text-primary">
            Accessed {sort.key === 'accessed' && (sort.dir === 'asc' ? '▲' : '▼')}
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Workspace texts" data-testid="workspace-list">
          {sorted.map((e) => (
            <li key={e.book_id} className="group relative">
              <button
                role="option"
                aria-selected={e.book_id === currentId}
                onClick={() => onOpen(e.book_id)}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left border-b border-app-border-light hover:bg-app-surface-variant ${
                  e.book_id === currentId ? 'bg-app-accent-light' : ''
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-arabic text-sm leading-snug truncate" dir="rtl">
                    {e.title}
                  </span>
                  <span className="block text-[11px] text-app-text-tertiary truncate">
                    {e.author ?? 'Unknown author'}
                    {e.death_ah != null && ` · d. ${e.death_ah}`}
                    {e.confirmed_isnads > 0 && ` · ${e.confirmed_isnads} isnād${e.confirmed_isnads === 1 ? '' : 's'}`}
                    {e.notes > 0 && ` · ${e.notes} note${e.notes === 1 ? '' : 's'}`}
                  </span>
                </span>
                <span className="w-20 shrink-0 text-right text-[11px] text-app-text-tertiary pt-0.5">{whenAccessed(e.accessed)}</span>
              </button>
              <button
                onClick={() => setConfirmRemove(e)}
                title="Remove from workspace"
                aria-label={`Remove ${e.title} from the workspace`}
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 px-1 text-xs text-app-text-tertiary hover:text-app-error"
              >
                ✕
              </button>
            </li>
          ))}
          {entries.length === 0 && (
            <li className="px-3 py-4 text-xs text-app-text-tertiary">
              Find a text on the right and add it. Its folder, with everything you confirm about it, lives in the workspace on disk.
            </li>
          )}
        </ul>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <Notice error={error} message={busy ? 'Working…' : message} />
        {selected ? (
          <BookDetail
            book={selected}
            authorName={selected.author_id != null ? authors.get(selected.author_id) : undefined}
            genreName={selected.genre_id != null ? genres.get(selected.genre_id) : undefined}
            inWorkspace={ids.has(selected.id)}
            onAdd={() => void add(selected)}
            onOpen={() => onOpen(selected.id)}
            onBack={() => setSelected(null)}
          />
        ) : (
          <TextBrowser
            books={books}
            authors={authors}
            genres={genres}
            inWorkspace={ids}
            onSelect={setSelected}
            loading={booksLoading}
            error={booksError}
          />
        )}
      </section>

      {confirmRemove && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setConfirmRemove(null)}>
          <div
            role="dialog"
            aria-label="Remove from workspace"
            className="bg-app-surface rounded shadow-lg border border-app-border-light w-[28rem] max-w-[95vw] p-4 text-sm"
            onClick={(e) => e.stopPropagation()}
            data-testid="confirm-remove"
          >
            <h2 className="font-semibold mb-2">Remove from workspace</h2>
            <p className="text-app-text-secondary">
              This deletes the folder for <span className="font-arabic">{confirmRemove.title}</span> and everything exported into it.
              What you confirmed stays in the database, so adding the text again brings it back.
            </p>
            <div className="flex items-center gap-2 mt-4">
              <button onClick={() => void remove(confirmRemove)} className="px-3 py-1 bg-app-error text-white rounded">
                Delete the folder
              </button>
              <button onClick={() => setConfirmRemove(null)} className="px-3 py-1 border border-app-border-medium rounded">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
