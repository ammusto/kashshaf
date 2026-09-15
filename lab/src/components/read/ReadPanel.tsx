import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page } from '../../api/lab';
import { Pages, type At } from '../../api/pages';
import {
  DEFAULT_NOTE_COLOR,
  NOTE_COLORS,
  entryForPage,
  noteColor,
  notesApi,
  tocApi,
  type Note,
  type NoteColor,
  type TocNode,
  type TocRow,
} from '../../api/workspace';
import { plainNote, toggleMark } from '../../api/noteText';
import { searchApi, toTerms, type Hit, type SearchInput, type SearchResults } from '../../api/search';
import { selectedText, tokenRangeOfSelection } from '../../api/selection';
import { Reader, type Mark } from '../Reader';
import { TocPane } from './TocPane';
import { SearchForm } from './SearchForm';
import { ResultRow } from './ResultRow';
import { Splitter, useDragWidth } from '../ui/Splitter';
import { CitationBlock } from '../ui/CitationBlock';
import { LoadingOverlay, Notice } from '../ui/Running';

/**
 * Reading and searching one text, in one panel (Phase 7 §B).
 *
 * The arrangement is Kashshaf's: the search form down the left, the text
 * filling the middle, its results underneath behind a draggable splitter, the
 * contents on the right. A result scrolls the text above it to that page with
 * the hit marked. There is no separate Search tab, because a search here is
 * always a search of the text you are reading.
 *
 * The text selects like text. The overlay that used to capture the mouse is
 * gone; a passage is chosen the ordinary way and read back through
 * `tokenRangeOfSelection`, which the spans' token indices still make exact.
 * What used to be a floating selection toolbar is now two buttons in the
 * reader's own toolbar.
 */

export interface Selection {
  at: At;
  range: [number, number];
  /** The selected words, for whatever the caller does with them. */
  text: string;
}

const EMPTY = (id: number): SearchInput => ({ id, query: '', mode: 'surface', cliticToggle: false });
const PAGE_SIZE = 50;

/** What survives a trip to another panel and back (§B). */
interface Remembered {
  and: SearchInput[];
  or: SearchInput[];
  tab: 'and' | 'or';
  results: SearchResults | null;
  offset: number;
  at: At | null;
  scrollTop: number;
  ratio: number;
}

const blank = (): Remembered => ({
  and: [EMPTY(1)],
  or: [EMPTY(2)],
  tab: 'and',
  results: null,
  offset: 0,
  at: null,
  scrollTop: 0,
  ratio: 0.62,
});

const memory = new Map<number, Remembered>();

/**
 * How many readers are on screen. The reuse panel puts two side by side
 * (8 D), and a keystroke meant for one of them must not page both.
 */
let mounted = 0;

export function resetReadMemory() {
  memory.clear();
}

function remembered(bookId: number | null): Remembered {
  if (bookId == null) return blank();
  let m = memory.get(bookId);
  if (!m) {
    m = blank();
    memory.set(bookId, m);
  }
  return m;
}

export function ReadPanel({
  book,
  initialAt,
  highlight,
  highlightClass,
  onFindReuse,
  onPageChange,
  onSectionChange,
  onNotesChanged,
  showToc: showTocDefault = true,
  showSearch = true,
  onSelectionChange,
}: {
  book: BookMetadata | null;
  initialAt?: At | null;
  highlight?: [number, number] | null;
  /** The class the highlight is drawn in; see `Reader`. */
  highlightClass?: string;
  /** "Find reuse on this page": hands the open page to the Reuse panel (§B). */
  onFindReuse?: (at: At) => void;
  /** The page now open, and its label by the C1 rule. */
  onPageChange?: (at: At, label: string) => void;
  onSectionChange?: (section: TocRow | null) => void;
  onNotesChanged?: () => void;
  showToc?: boolean;
  /** Reuse embeds the reader without the search rail. */
  showSearch?: boolean;
  /** The passage selected in the text, for Reuse's "Analyse selected" (§C1). */
  onSelectionChange?: (sel: Selection | null) => void;
}) {
  const bookId = book?.id ?? null;
  const mem = remembered(bookId);

  /** True while the pointer is over this reader; see `mounted`. */
  const hot = useRef(false);
  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
    };
  }, []);

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
  const [editing, setEditing] = useState<{ note: Note | null; at: At; range: [number, number]; text: string; color: NoteColor } | null>(null);
  const [citing, setCiting] = useState(false);
  /** A note to bring into view once its page has rendered (9 B1). */
  const [seekNote, setSeekNote] = useState<number | null>(null);
  const noteBox = useRef<HTMLTextAreaElement | null>(null);

  const [andInputs, setAnd] = useState<SearchInput[]>(mem.and);
  const [orInputs, setOr] = useState<SearchInput[]>(mem.or);
  const [tab, setTab] = useState<'and' | 'or'>(mem.tab);
  const [results, setResults] = useState<SearchResults | null>(mem.results);
  const [offset, setOffset] = useState(mem.offset);
  const [searching, setSearching] = useState(false);
  const [ratio, setRatio] = useState(mem.ratio);
  const nextId = useRef(3);

  const [partInput, setPartInput] = useState('');
  const [pageInput, setPageInput] = useState('');
  const [mark, setMark] = useState<[number, number] | null>(highlight ?? null);

  const textRef = useRef<HTMLDivElement>(null);
  const { width: railWidth, handle: railHandle } = useDragWidth('lab.read.rail', 300, 220, 520);

  // --- the text ------------------------------------------------------------

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
      .then((entries) => live && setPages(new Pages(entries, book?.parts)))
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
    notesApi.list(bookId).then(setNotes).catch(() => setNotes([]));
  }, [bookId]);
  useEffect(reloadNotes, [reloadNotes]);

  const go = useCallback(
    async (next: number, marked: [number, number] | null = null) => {
      if (bookId == null || next < 0 || next >= pages.length) return;
      const entry = pages.at(next);
      if (!entry) return;
      setLoading(true);
      setError(null);
      try {
        const p = await labApi.getPage(bookId, entry.part_index, entry.page_id);
        setIndex(next);
        setPage(p);
        setMark(marked);
        setSelection(null);
        const at = { part_index: entry.part_index, page_id: entry.page_id };
        mem.at = at;
        mem.scrollTop = 0;
        onPageChange?.(at, pages.label(entry.part_index, entry.page_id));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [bookId, pages, onPageChange, mem]
  );

  // A caller that changes only the span, and not the page, still means it:
  // the reuse panel moves the mark from one match to the next within a page.
  useEffect(() => {
    setMark(highlight ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.[0], highlight?.[1]]);

  // Open where we left off, or where the caller asked.
  const openedFor = useRef<string>('');
  useEffect(() => {
    if (bookId == null || pages.length === 0) return;
    const wanted = initialAt ?? mem.at ?? pages.at(0)!;
    const key = `${bookId}:${wanted.part_index}:${wanted.page_id}`;
    if (openedFor.current === key) return;
    openedFor.current = key;
    const i = pages.indexOf(wanted.part_index, wanted.page_id);
    void go(i >= 0 ? i : 0, initialAt ? highlight ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, pages, initialAt?.part_index, initialAt?.page_id]);

  // Where you were scrolled to is part of where you were (§B).
  const restored = useRef('');
  useEffect(() => {
    const el = textRef.current;
    if (!el || !page) return;
    const key = `${page.part_index}:${page.page_id}`;
    if (restored.current === key) return;
    restored.current = key;
    // Unless the caller sent us to a particular span: the reader has just
    // scrolled it into view, and where the page was left is no longer what
    // is being asked for (10 G). Child effects run first, so without this
    // the restore undoes the scroll.
    if (mark) return;
    el.scrollTop = mem.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.part_index, page?.page_id]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      // With two readers up, the shortcuts belong to the one being read.
      if (mounted > 1 && !hot.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setTocOpen((v) => !v);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      // The text reads right to left, so the right arrow goes back in it.
      if (e.key === 'ArrowRight') void go(index - 1);
      if (e.key === 'ArrowLeft') void go(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  const currentEntry = useMemo(
    () => (current ? entryForPage(rows, current.part_index, current.page_id) : null),
    [rows, current?.part_index, current?.page_id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    onSectionChange?.(currentEntry ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.id]);

  // --- the selection, as the browser makes it (§B) -------------------------

  useEffect(() => {
    const read = () => {
      if (!current) return;
      const range = tokenRangeOfSelection(textRef.current);
      const next = range ? { at: current, range, text: selectedText() } : null;
      setSelection(next);
      onSelectionChange?.(next);
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectionChange, current?.part_index, current?.page_id]);

  // --- notes ---------------------------------------------------------------

  const pageNotes = useMemo(
    () => (current ? notes.filter((n) => n.part_index === current.part_index && n.page_id === current.page_id) : []),
    [notes, current?.part_index, current?.page_id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 9 B2: an annotation is a coloured ground behind the words it is on,
  // with the note itself on hover and a click to open it.
  const marks: Mark[] = useMemo(
    () =>
      pageNotes.map((n) => ({
        start: n.tok_start,
        end: n.tok_end,
        className: `tok-note tok-note-${noteColor(n.color)}`,
        title: plainNote(n.text),
        id: n.id,
      })),
    [pageNotes]
  );

  /** Open an annotation for editing, from the text or from the contents. */
  const openNote = useCallback(
    (id: number) => {
      const n = notes.find((x) => x.id === id);
      if (!n) return;
      setEditing({
        note: n,
        at: { part_index: n.part_index, page_id: n.page_id },
        range: [n.tok_start, n.tok_end],
        text: n.text,
        color: noteColor(n.color),
      });
    },
    [notes]
  );

  /** Go to a note's page and put it on screen (9 B1). */
  const jumpToNote = useCallback(
    (n: Note) => {
      const i = pages.indexOf(n.part_index, n.page_id);
      setSeekNote(n.id);
      if (i >= 0 && (current?.part_index !== n.part_index || current?.page_id !== n.page_id)) void go(i);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages, go, current?.part_index, current?.page_id]
  );

  useEffect(() => {
    if (seekNote == null || !page) return;
    const el = textRef.current?.querySelector(`[data-mark="${seekNote}"]`);
    if (!el) return;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    setSeekNote(null);
  }, [seekNote, page, notes]);

  /** Bold or underline whatever is selected in the note box (9 B3). */
  const applyMark = (which: 'bold' | 'underline') => {
    const el = noteBox.current;
    if (!el || !editing) return;
    const next = toggleMark(editing.text, el.selectionStart, el.selectionEnd, which);
    setEditing({ ...editing, text: next.text });
    // Keep the words selected, so the two marks can be applied one after
    // the other.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };

  const saveNote = async () => {
    if (!editing || bookId == null) return;
    try {
      if (editing.note) await notesApi.update(editing.note.id, editing.text, editing.color);
      else
        await notesApi.save({
          book_id: bookId,
          part_index: editing.at.part_index,
          page_id: editing.at.page_id,
          tok_start: editing.range[0],
          tok_end: editing.range[1],
          text: editing.text,
          color: editing.color,
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

  // --- search --------------------------------------------------------------

  const runSearch = useCallback(
    async (at = 0) => {
      if (bookId == null) return;
      const { and_terms, or_terms } = toTerms(andInputs, orInputs);
      if (and_terms.length === 0 && or_terms.length === 0) return;
      setSearching(true);
      setError(null);
      try {
        const r = await searchApi.book({ book_id: bookId, and_terms, or_terms, limit: PAGE_SIZE, offset: at });
        setResults(r);
        setOffset(at);
        mem.results = r;
        mem.offset = at;
      } catch (e) {
        setResults(null);
        setError(String(e));
      } finally {
        setSearching(false);
      }
    },
    [bookId, andInputs, orInputs, mem]
  );

  const setInputs = (which: 'and' | 'or', next: SearchInput[]) => {
    (which === 'and' ? setAnd : setOr)(next);
    mem[which] = next;
  };

  const showHit = (hit: Hit) => {
    const i = pages.indexOf(hit.part_index, hit.page_id);
    if (i < 0) return;
    void go(i, hit.matched.length ? [Math.min(...hit.matched), Math.max(...hit.matched) + 1] : null);
  };

  // --- render --------------------------------------------------------------

  if (!book) {
    return <div className="flex-1 p-6 text-sm text-app-text-secondary">Open a text from the workspace first.</div>;
  }

  const label = current ? pages.label(current.part_index, current.page_id) : '—';

  const toolbar = (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-app-border-light bg-app-surface text-xs">
      <button
        onClick={() => void go(index - 1)}
        disabled={index <= 0 || loading}
        className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
      >
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
            <span className="text-app-text-secondary">:</span>
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

      {currentEntry?.title ? (
        <span
          className="flex-1 min-w-0 font-arabic text-sm text-app-text-secondary truncate text-center"
          dir="rtl"
          title={currentEntry.title}
        >
          {currentEntry.title}
        </span>
      ) : (
        <div className="flex-1" />
      )}

      <span className="text-app-text-secondary tabular-nums" data-testid="read-locator">
        {label}
      </span>

      <button
        onClick={() => setCiting(true)}
        disabled={!book}
        title="Cite this text, at this page"
        data-testid="cite"
        className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40 hover:bg-app-surface-variant"
      >
        Cite
      </button>

      <button
        onClick={() =>
          selection && setEditing({ note: null, at: selection.at, range: selection.range, text: '', color: DEFAULT_NOTE_COLOR })
        }
        disabled={!selection}
        title={selection ? 'Annotate the selected words' : 'Select some words first'}
        data-testid="annotate"
        className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40 hover:bg-app-surface-variant"
      >
        Annotate
      </button>

      {onFindReuse && current && (
        <button
          onClick={() => onFindReuse(current)}
          className="px-2 py-1 border border-app-border-medium rounded hover:bg-app-surface-variant"
          data-testid="find-reuse-page"
          title="Look for this page's text elsewhere in the corpus"
        >
          Find reuse on this page
        </button>
      )}
      {!tocOpen && (
        <button onClick={() => setTocOpen(true)} title="Contents (Ctrl+T)" className="px-2 py-1 border border-app-border-medium rounded">
          Contents
        </button>
      )}
    </div>
  );

  const reader = (
    <Reader
      page={page}
      pages={pages.entries.map((e) => ({ book_id: e.book_id, part_index: e.part_index, page_id: e.page_id }))}
      index={index}
      onNavigate={(i) => void go(i)}
      highlight={mark}
      highlightClass={highlightClass}
      labels={pages}
      marks={marks}
      onMarkClick={openNote}
      toolbar={toolbar}
      interaction="text"
      paneRef={textRef}
      onScroll={(top) => {
        mem.scrollTop = top;
      }}
      loading={loading}
      error={null}
    />
  );

  return (
    <div
      className="flex-1 min-w-0 flex min-h-0 relative overflow-hidden"
      data-testid="read-panel"
      onMouseEnter={() => (hot.current = true)}
      onMouseLeave={() => (hot.current = false)}
    >
      {showSearch && (
        <aside
          className="relative flex-shrink-0 bg-app-surface border-r border-app-border-light"
          style={{ width: railWidth }}
          data-testid="search-rail"
        >
          {railHandle}
          <SearchForm
            tab={tab}
            onTab={(t) => {
              setTab(t);
              mem.tab = t;
            }}
            andInputs={andInputs}
            orInputs={orInputs}
            onChange={(which, input) =>
              setInputs(which, (which === 'and' ? andInputs : orInputs).map((i) => (i.id === input.id ? input : i)))
            }
            onAdd={(which) => setInputs(which, [...(which === 'and' ? andInputs : orInputs), EMPTY(nextId.current++)])}
            onRemove={(which, id) => setInputs(which, (which === 'and' ? andInputs : orInputs).filter((i) => i.id !== id))}
            onSearch={() => void runSearch(0)}
            onClear={() => {
              setInputs('and', [EMPTY(nextId.current++)]);
              setInputs('or', [EMPTY(nextId.current++)]);
              setTab('and');
              setResults(null);
              mem.tab = 'and';
              mem.results = null;
            }}
            running={searching}
            disabled={bookId == null}
          />
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col min-h-0 p-4">
        <Notice error={error} />

        {showSearch ? (
          <>
            <div className="overflow-hidden rounded-xl bg-app-surface mb-3 flex flex-col min-h-0 border border-app-border-light" style={{ flex: ratio }}>
              {reader}
            </div>

            <Splitter
              ratio={ratio}
              onDrag={(r) => {
                setRatio(r);
                mem.ratio = r;
              }}
            />

            <div className="overflow-hidden rounded-xl bg-app-surface flex flex-col min-h-0 border border-app-border-light" style={{ flex: 1 - ratio }}>
              <div className="h-10 bg-app-surface-variant px-6 flex items-center flex-shrink-0 border-b border-app-border-light gap-4">
                <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide" data-testid="search-summary">
                  {results
                    ? `${results.total.toLocaleString()} page${results.total === 1 ? '' : 's'}${results.capped ? '+' : ''}`
                    : 'Results'}
                </span>
                {results && results.total > PAGE_SIZE && (
                  <span className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => void runSearch(Math.max(0, offset - PAGE_SIZE))}
                      disabled={offset === 0}
                      className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40"
                    >
                      ‹
                    </button>
                    <span className="tabular-nums text-app-text-secondary">
                      {(offset + 1).toLocaleString()}–{Math.min(offset + results.hits.length, results.total).toLocaleString()}
                    </span>
                    <button
                      onClick={() => void runSearch(offset + PAGE_SIZE)}
                      disabled={offset + PAGE_SIZE >= results.total}
                      className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40"
                    >
                      ›
                    </button>
                  </span>
                )}
                {results && <span className="text-xs text-app-text-secondary ltr:ml-auto">{results.elapsed_ms} ms</span>}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto relative">
                {results?.hits.map((h) => (
                  <ResultRow
                    key={`${h.part_index}:${h.page_id}`}
                    hit={h}
                    pages={pages}
                    section={entryForPage(rows, h.part_index, h.page_id)?.title ?? null}
                    onClick={() => showHit(h)}
                  />
                ))}
                {results && results.hits.length === 0 && (
                  <p className="p-6 text-sm text-app-text-secondary">Nothing in this text matches that.</p>
                )}
                {!results && (
                  <p className="p-6 text-sm text-app-text-secondary">
                    Search the text on the left. A term matches on its surface form, its lemma or its root, and the
                    clitic toggle also matches the word with و ف ب ل or ك in front of it.
                  </p>
                )}
                {searching && <LoadingOverlay step={{ label: 'Searching the text…' }} />}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-xl bg-app-surface border border-app-border-light">
            {reader}
          </div>
        )}
      </div>

      {tocOpen && (
        <TocPane
          tree={tree}
          pages={pages}
          currentId={currentEntry?.id ?? null}
          onJump={(node) => {
            const i = pages.indexOf(node.part_index, node.page_id);
            if (i >= 0) void go(i);
          }}
          onClose={() => setTocOpen(false)}
          loading={tocLoading}
          error={tocError}
          notes={notes}
          onJumpNote={jumpToNote}
        />
      )}

      {citing && book && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setCiting(false)}>
          <div
            role="dialog"
            aria-label="Citation"
            className="bg-app-surface rounded-2xl shadow-lg border border-app-border-light w-[36rem] max-w-[95vw] p-5"
            onClick={(e) => e.stopPropagation()}
            data-testid="cite-modal"
          >
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-semibold flex-1">Citation</h2>
              <button onClick={() => setCiting(false)} aria-label="Close" className="text-app-text-secondary hover:text-app-text-primary px-1">
                ✕
              </button>
            </div>
            {/* Where the reader is, which is what the citation cites. */}
            <CitationBlock
              book={book}
              volume={current && pages.multiPart ? String(current.part_index + 1) : undefined}
              page={current ? pages.printed(current.part_index, current.page_id) : undefined}
              withPageRef={!!current}
            />
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setEditing(null)}>
          <div
            role="dialog"
            aria-label="Annotation"
            className="bg-app-surface rounded-2xl shadow-lg border border-app-border-light w-[32rem] max-w-[95vw] p-5"
            onClick={(e) => e.stopPropagation()}
            data-testid="note-editor"
          >
            <h2 className="text-sm font-semibold mb-1">{editing.note ? 'Edit the note' : 'Annotate this passage'}</h2>
            {/* 9 B4: the C1 rule here too, so a one-part text says only its page. */}
            <p className="text-xs text-app-text-secondary mb-2" data-testid="note-location">
              {pages.multiPart && `Volume: ${editing.at.part_index + 1}, `}
              Page: {pages.printed(editing.at.part_index, editing.at.page_id)} · tokens {editing.range[0]}–
              {editing.range[1] - 1}
            </p>

            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => applyMark('bold')}
                aria-label="Bold"
                title="Bold the selected words"
                className="w-8 h-7 border border-app-border-medium rounded font-bold text-sm hover:bg-app-surface-variant"
              >
                B
              </button>
              <button
                onClick={() => applyMark('underline')}
                aria-label="Underline"
                title="Underline the selected words"
                className="w-8 h-7 border border-app-border-medium rounded underline text-sm hover:bg-app-surface-variant"
              >
                U
              </button>
              <span className="w-px h-5 bg-app-border-light" />
              <span className="text-xs text-app-text-secondary">Highlight</span>
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setEditing({ ...editing, color: c })}
                  aria-label={c}
                  aria-pressed={editing.color === c}
                  title={c}
                  data-testid={`note-color-${c}`}
                  className={`tok-note tok-note-${c} w-6 h-6 rounded border ${
                    editing.color === c ? 'border-app-text-primary' : 'border-app-border-medium'
                  }`}
                />
              ))}
            </div>

            <textarea
              ref={noteBox}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              autoFocus
              aria-label="Note"
              className="w-full h-32 border border-app-border-medium rounded-lg p-2 text-sm"
            />
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => void saveNote()}
                disabled={!editing.text.trim()}
                className="px-3 py-1 text-sm bg-app-accent text-white rounded-lg disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={() => setEditing(null)} className="px-3 py-1 text-sm border border-app-border-medium rounded-lg">
                Cancel
              </button>
              {editing.note && (
                <button
                  onClick={() => void deleteNote(editing.note!)}
                  className="ltr:ml-auto px-3 py-1 text-sm text-app-error border border-app-border-medium rounded-lg"
                >
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
