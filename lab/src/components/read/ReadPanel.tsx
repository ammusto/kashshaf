import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { stripHtml } from '@kashshaf/shared';
import { labApi, type Page } from '../../api/lab';
import { Pages, sameAt, type At } from '../../api/pages';
import { entryForPage, notesApi, tocApi, type Note, type TocNode, type TocRow } from '../../api/workspace';
import { Reader, type Mark } from '../Reader';
import { TocPane } from './TocPane';
import { LoadingOverlay, Notice } from '../ui/Running';

/**
 * The Read panel (spec 1.5 §C).
 *
 * It owns one text's reading state: the page list with its printed numbers,
 * the table of contents, the notes, and where the reader is. The Reuse panel
 * embeds a second one as its left half (§H1), which is why this loads its own
 * data instead of taking it from the shell — two readers on the same text sit
 * on different pages.
 */

export interface Selection {
  at: At;
  range: [number, number];
  /** The selected words, for whatever the caller does with them. */
  text: string;
}

export function ReadPanel({
  book,
  initialAt,
  highlight,
  onFindReuse,
  onPageChange,
  onSectionChange,
  onNotesChanged,
  showToc: showTocDefault = true,
  extraActions,
}: {
  book: BookMetadata | null;
  /** Where to open; the first page when absent. */
  initialAt?: At | null;
  /** A range to mark and scroll to on the opened page (a search hit). */
  highlight?: [number, number] | null;
  /** "Find reuse" on the selection (spec §C4); hidden when absent. */
  onFindReuse?: (sel: Selection) => void;
  onPageChange?: (at: At) => void;
  /** The section the reader is in, as it changes (spec 1.5 H3, "Analyse section"). */
  onSectionChange?: (section: TocRow | null) => void;
  onNotesChanged?: () => void;
  showToc?: boolean;
  /** Buttons the embedding panel adds to the selection strip. */
  extraActions?: (sel: Selection) => React.ReactNode;
}) {
  const [pages, setPages] = useState<Pages>(() => Pages.empty(book?.parts));
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tree, setTree] = useState<TocNode[]>([]);
  const [rows, setRows] = useState<TocRow[]>([]);
  const [tocError, setTocError] = useState<string | null>(null);
  const [tocLoading, setTocLoading] = useState(false);
  const [tocOpen, setTocOpen] = useState(showTocDefault);

  const [notes, setNotes] = useState<Note[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<{ note: Note | null; at: At; range: [number, number]; text: string } | null>(null);

  const [partInput, setPartInput] = useState('');
  const [pageInput, setPageInput] = useState('');
  const bookId = book?.id ?? null;

  // --- the page list, the contents and the notes, once per text ------------

  useEffect(() => {
    if (bookId == null) {
      setPages(Pages.empty());
      setPage(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    labApi
      .listPages(bookId)
      .then((entries) => {
        if (!live) return;
        setPages(new Pages(entries, book?.parts));
      })
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [bookId, book?.parts]);

  useEffect(() => {
    if (bookId == null) return;
    let live = true;
    setTocLoading(true);
    setTocError(null);
    Promise.all([tocApi.tree(bookId), tocApi.rows(bookId)])
      .then(([t, r]) => {
        if (!live) return;
        setTree(t);
        setRows(r);
      })
      .catch((e) => {
        if (!live) return;
        setTree([]);
        setRows([]);
        setTocError(String(e));
      })
      .finally(() => live && setTocLoading(false));
    return () => {
      live = false;
    };
  }, [bookId]);

  const reloadNotes = useCallback(() => {
    if (bookId == null) return;
    notesApi
      .list(bookId)
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [bookId]);
  useEffect(reloadNotes, [reloadNotes]);

  // --- navigation (spec §C2) ----------------------------------------------

  const go = useCallback(
    async (next: number) => {
      if (bookId == null || next < 0 || next >= pages.length) return;
      const entry = pages.at(next);
      if (!entry) return;
      setLoading(true);
      setError(null);
      try {
        const p = await labApi.getPage(bookId, entry.part_index, entry.page_id);
        setIndex(next);
        setPage(p);
        setSelection(null);
        onPageChange?.({ part_index: entry.part_index, page_id: entry.page_id });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [bookId, pages, onPageChange]
  );

  // Open where the caller asked, once the page list is in.
  const openedFor = useRef<string>('');
  useEffect(() => {
    if (bookId == null || pages.length === 0) return;
    const wanted = initialAt ?? pages.at(0)!;
    const key = `${bookId}:${wanted.part_index}:${wanted.page_id}`;
    if (openedFor.current === key) return;
    openedFor.current = key;
    const i = pages.indexOf(wanted.part_index, wanted.page_id);
    void go(i >= 0 ? i : 0);
    // `go` changes with `pages`; the key guard is what stops the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, pages, initialAt?.part_index, initialAt?.page_id]);

  // The inputs follow the page unless the reader is typing in them.
  const current = page ? { part_index: page.part_index, page_id: page.page_id } : null;
  useEffect(() => {
    if (!current) return;
    setPartInput(String(current.part_index + 1));
    setPageInput(pages.printed(current.part_index, current.page_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.part_index, current?.page_id, pages]);

  const jumpToInput = () => {
    const entry = pages.find(pageInput, partInput);
    if (!entry) {
      setError(`No page ${pages.multiPart ? `${partInput}:${pageInput}` : pageInput} in this text.`);
      return;
    }
    void go(pages.indexOf(entry.part_index, entry.page_id));
  };

  // Arrow keys page the book, except while the reader is in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setTocOpen((v) => !v);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      // The text is right-to-left, so the right arrow goes back in it.
      if (e.key === 'ArrowRight') void go(index - 1);
      if (e.key === 'ArrowLeft') void go(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  // --- the contents (spec §C3) --------------------------------------------

  const currentEntry = useMemo(
    () => (current ? entryForPage(rows, current.part_index, current.page_id) : null),
    [rows, current?.part_index, current?.page_id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    onSectionChange?.(currentEntry ?? null);
    // The callback is the caller's; re-running on the entry alone is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.id]);

  const jumpTo = (node: TocNode) => {
    const i = pages.indexOf(node.part_index, node.page_id);
    if (i >= 0) void go(i);
  };

  // --- notes (spec §C4) ----------------------------------------------------

  const pageNotes = useMemo(
    () => (current ? notes.filter((n) => n.part_index === current.part_index && n.page_id === current.page_id) : []),
    [notes, current?.part_index, current?.page_id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const marks: Mark[] = useMemo(
    () =>
      pageNotes.map((n) => ({
        start: n.tok_start,
        end: n.tok_end,
        className: 'tok-note',
        title: n.text,
      })),
    [pageNotes]
  );

  const onSelectRange = useCallback(
    (range: [number, number] | null) => {
      if (!range || !page) {
        setSelection(null);
        return;
      }
      const words = page.tokens.filter((t) => t.idx >= range[0] && t.idx < range[1]).map((t) => t.surface);
      setSelection({ at: { part_index: page.part_index, page_id: page.page_id }, range, text: words.join(' ') });
    },
    [page]
  );

  const saveNote = async () => {
    if (!editing || bookId == null) return;
    try {
      if (editing.note) await notesApi.update(editing.note.id, editing.text);
      else
        await notesApi.save({
          book_id: bookId,
          part_index: editing.at.part_index,
          page_id: editing.at.page_id,
          tok_start: editing.range[0],
          tok_end: editing.range[1],
          text: editing.text,
        });
      setEditing(null);
      reloadNotes();
      onNotesChanged?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteNote = async (note: Note) => {
    try {
      await notesApi.delete(note.id);
      setEditing(null);
      reloadNotes();
      onNotesChanged?.();
    } catch (e) {
      setError(String(e));
    }
  };

  // --- render --------------------------------------------------------------

  const label = current ? pages.label(current.part_index, current.page_id) : '—';
  const sectionTitle = currentEntry?.title ?? null;

  const toolbar = (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-app-border-light bg-app-surface text-xs">
      <button onClick={() => void go(index - 1)} disabled={index <= 0 || loading} className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40">
        ‹ Prev
      </button>
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          jumpToInput();
        }}
      >
        {pages.multiPart && (
          <>
            <input
              value={partInput}
              onChange={(e) => setPartInput(e.target.value)}
              aria-label="Part"
              inputMode="numeric"
              className="w-10 px-1 py-1 text-center tabular-nums border border-app-border-medium rounded"
            />
            <span className="text-app-text-tertiary">:</span>
          </>
        )}
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          aria-label="Page"
          className="w-14 px-1 py-1 text-center tabular-nums border border-app-border-medium rounded"
        />
        <button type="submit" className="px-2 py-1 border border-app-border-medium rounded">
          Go
        </button>
      </form>
      <button
        onClick={() => void go(index + 1)}
        disabled={index >= pages.length - 1 || loading}
        className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
      >
        Next ›
      </button>

      {sectionTitle && (
        <span className="flex-1 min-w-0 font-arabic text-sm text-app-text-secondary truncate text-center" dir="rtl" title={sectionTitle}>
          {sectionTitle}
        </span>
      )}
      {!sectionTitle && <div className="flex-1" />}

      <span className="text-app-text-tertiary tabular-nums" data-testid="read-locator">
        {label}
      </span>
      {!tocOpen && (
        <button onClick={() => setTocOpen(true)} title="Contents (Ctrl+T)" className="px-2 py-1 border border-app-border-medium rounded">
          Contents
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-1 min-w-0 flex min-h-0 relative overflow-hidden" data-testid="read-panel">
      <div className="flex-1 min-w-0 flex flex-col min-h-0 relative">
        <Notice error={error} />
        <Reader
          page={page}
          pages={pages.entries.map((e) => ({ book_id: e.book_id, part_index: e.part_index, page_id: e.page_id }))}
          index={index}
          onNavigate={(i) => void go(i)}
          onSelectRange={onSelectRange}
          highlight={highlight ?? null}
          labels={pages}
          marks={marks}
          toolbar={toolbar}
          loading={loading}
          error={null}
        />

        {selection && (
          <div className="px-3 py-1.5 border-t border-app-border-light bg-app-surface-variant flex items-center gap-2 text-xs" data-testid="selection-actions">
            <span className="flex-1 min-w-0 font-arabic truncate" dir="rtl">
              {selection.text}
            </span>
            <button
              onClick={() => setEditing({ note: null, at: selection.at, range: selection.range, text: '' })}
              className="px-2 py-1 border border-app-border-medium rounded"
              data-testid="annotate"
            >
              Annotate
            </button>
            {onFindReuse && (
              <button onClick={() => onFindReuse(selection)} className="px-2 py-1 border border-app-border-medium rounded" data-testid="find-reuse">
                Find reuse
              </button>
            )}
            {extraActions?.(selection)}
          </div>
        )}

        {pageNotes.length > 0 && (
          <div className="px-3 py-1 border-t border-app-border-light text-xs text-app-text-tertiary flex flex-wrap gap-2" data-testid="page-notes">
            {pageNotes.map((n) => (
              <button
                key={n.id}
                onClick={() => setEditing({ note: n, at: { part_index: n.part_index, page_id: n.page_id }, range: [n.tok_start, n.tok_end], text: n.text })}
                className="px-2 py-0.5 rounded bg-app-surface border border-app-border-light hover:border-app-accent max-w-xs truncate"
                title={n.text}
              >
                {n.text.split('\n')[0] || '(empty note)'}
              </button>
            ))}
          </div>
        )}

        {loading && pages.length === 0 && <LoadingOverlay step={{ label: 'Loading the text…' }} />}
      </div>

      {tocOpen && (
        <TocPane
          tree={tree}
          pages={pages}
          currentId={currentEntry?.id ?? null}
          onJump={jumpTo}
          onClose={() => setTocOpen(false)}
          loading={tocLoading}
          error={tocError}
        />
      )}

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setEditing(null)}>
          <div
            role="dialog"
            aria-label="Annotation"
            className="bg-app-surface rounded shadow-lg border border-app-border-light w-[32rem] max-w-[95vw] p-4"
            onClick={(e) => e.stopPropagation()}
            data-testid="note-editor"
          >
            <h2 className="text-sm font-semibold mb-1">{editing.note ? 'Edit the note' : 'Annotate this passage'}</h2>
            <p className="text-xs text-app-text-tertiary mb-2">
              {pages.label(editing.at.part_index, editing.at.page_id)} · words {editing.range[0]}–{editing.range[1] - 1}
            </p>
            {page && sameAt(editing.at, current) && (
              <p className="font-arabic text-sm bg-app-surface-variant rounded p-2 mb-3 max-h-24 overflow-y-auto" dir="rtl">
                {selectedWords(page, editing.range)}
              </p>
            )}
            <textarea
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              autoFocus
              aria-label="Note"
              className="w-full h-32 border border-app-border-medium rounded p-2 text-sm"
            />
            <div className="flex items-center gap-2 mt-3">
              <button onClick={() => void saveNote()} disabled={!editing.text.trim()} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
                Save
              </button>
              <button onClick={() => setEditing(null)} className="px-3 py-1 text-sm border border-app-border-medium rounded">
                Cancel
              </button>
              {editing.note && (
                <button onClick={() => void deleteNote(editing.note!)} className="ltr:ml-auto px-3 py-1 text-sm text-app-error border border-app-border-medium rounded">
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function selectedWords(page: Page, range: [number, number]): string {
  const words = page.tokens.filter((t) => t.idx >= range[0] && t.idx < range[1]).map((t) => t.surface);
  return words.length > 0 ? words.join(' ') : stripHtml(page.body).slice(0, 200);
}
