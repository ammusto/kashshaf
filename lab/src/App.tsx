import { useCallback, useEffect, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type LabStatus, type Page, type PageRef } from './api/lab';
import { ModeBadge, UnavailableNotice } from './components/ModeBadge';
import { BookBrowser } from './components/BookBrowser';
import { Reader } from './components/Reader';

/**
 * The Lab shell (spec §7.1).
 *
 * The left rail names every panel the spec plans, with the ones their phases
 * have not delivered shown disabled and labelled — not hidden. That is ground
 * rule 5 applied to the roadmap as well as to the modes: the user can see what
 * Lab is for, and what it cannot do yet.
 */

interface Panel {
  id: string;
  label: string;
  /** The phase that delivers it; undefined means it is here now. */
  phase?: number;
}

const PANELS: Panel[] = [
  { id: 'books', label: 'Books' },
  { id: 'stats', label: 'Stats', phase: 1 },
  { id: 'isnad', label: 'Isnād', phase: 2 },
  { id: 'reuse', label: 'Reuse', phase: 3 },
  { id: 'quran', label: 'Qurʾān', phase: 3 },
  { id: 'network', label: 'Network', phase: 4 },
  { id: 'poetry', label: 'Poetry (exp.)', phase: 4 },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [panel, setPanel] = useState('books');

  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [booksLoading, setBooksLoading] = useState(false);
  const [booksError, setBooksError] = useState<string | null>(null);

  const [current, setCurrent] = useState<BookMetadata | null>(null);
  const [pages, setPages] = useState<PageRef[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    labApi.status().then(setStatus).catch((e) => {
      setStatus(null);
      console.error('lab_status failed', e);
    });
  }, []);

  const loadBooks = useCallback(async () => {
    setBooksLoading(true);
    setBooksError(null);
    try {
      setBooks(await labApi.listBooks());
    } catch (e) {
      setBooks([]);
      setBooksError(String(e));
    } finally {
      setBooksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status && status.mode !== 'unavailable') void loadBooks();
  }, [status, loadBooks]);

  const recheck = async () => {
    setRechecking(true);
    try {
      setStatus(await labApi.reloadSource());
    } catch (e) {
      console.error('reload_source failed', e);
    } finally {
      setRechecking(false);
    }
  };

  const openBook = async (id: number) => {
    setPageLoading(true);
    setPageError(null);
    try {
      const opened = await labApi.openBook(id);
      setCurrent(opened.book);
      setPages(opened.pages);
      setPageIndex(0);
      setPage(opened.first);
    } catch (e) {
      setCurrent(books.find((b) => b.id === id) ?? null);
      setPages([]);
      setPage(null);
      setPageError(String(e));
    } finally {
      setPageLoading(false);
    }
  };

  const goToPage = async (next: number) => {
    if (next < 0 || next >= pages.length) return;
    const ref = pages[next];
    setPageLoading(true);
    setPageError(null);
    try {
      const p = await labApi.getPage(ref.book_id, ref.part_index, ref.page_id);
      setPageIndex(next);
      setPage(p);
    } catch (e) {
      setPageError(String(e));
    } finally {
      setPageLoading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-app-bg text-app-text-primary">
      <header className="flex items-center justify-between px-4 py-2 border-b border-app-border-light bg-app-surface">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">Kashshaf Lab</h1>
          {status && (
            <span className="text-xs text-app-text-tertiary">{status.lab_version}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {current && (
            <span className="font-arabic text-sm text-app-text-secondary truncate max-w-md" dir="rtl">
              {current.title}
            </span>
          )}
          <ModeBadge status={status} onRetry={recheck} busy={rechecking} />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <nav className="w-40 border-r border-app-border-light bg-app-surface flex flex-col py-2">
          {PANELS.map((p) => (
            <button
              key={p.id}
              onClick={() => !p.phase && setPanel(p.id)}
              disabled={!!p.phase}
              title={p.phase ? `Arrives in Phase ${p.phase}` : undefined}
              className={`text-left px-4 py-2 text-sm ${
                p.phase
                  ? 'text-app-text-tertiary cursor-not-allowed'
                  : panel === p.id
                    ? 'bg-app-accent-light text-app-accent font-medium'
                    : 'hover:bg-app-surface-variant'
              }`}
            >
              {p.label}
              {p.phase && <span className="block text-[10px]">Phase {p.phase}</span>}
            </button>
          ))}
        </nav>

        {status?.mode === 'unavailable' ? (
          <main className="flex-1 overflow-y-auto">
            <UnavailableNotice status={status} />
          </main>
        ) : panel === 'settings' ? (
          <main className="flex-1 overflow-y-auto p-6">
            <SettingsPanel status={status} />
          </main>
        ) : (
          <main className="flex-1 flex min-h-0">
            <aside className="w-80 border-r border-app-border-light bg-app-surface">
              <BookBrowser
                books={books}
                currentId={current?.id ?? null}
                onSelect={openBook}
                loading={booksLoading}
                error={booksError}
              />
            </aside>
            <section className="flex-1 min-w-0">
              <Reader
                page={page}
                pages={pages}
                index={pageIndex}
                onNavigate={goToPage}
                loading={pageLoading}
                error={pageError}
              />
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

/** Mode, corpus and Lab's own directory (spec §7.8, Phase 0 subset). */
function SettingsPanel({ status }: { status: LabStatus | null }) {
  const [dirs, setDirs] = useState<Awaited<ReturnType<typeof labApi.dirs>> | null>(null);
  useEffect(() => {
    labApi.dirs().then(setDirs).catch(() => setDirs(null));
  }, []);
  if (!status) return <p className="text-sm text-app-text-tertiary">Loading…</p>;

  const rows: [string, string][] = [
    ['Mode', status.mode],
    ['Corpus version', status.corpus_version ?? '—'],
    ['Corpus directory', status.corpus_dir ?? '—'],
    ['API', status.api_base ?? '—'],
    ['Bulk token fetch (§5.1)', status.bulk_tokens ? 'available' : 'not available'],
    ['Lab directory', status.lab_dir ?? '—'],
    ['analysis.db', dirs?.analysis_db ?? '—'],
    ['analysis.db schema', dirs?.schema_version != null ? String(dirs.schema_version) : '—'],
    ['Lab version', status.lab_version],
  ];

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold mb-4">Settings</h2>
      <dl className="text-sm border border-app-border-light rounded overflow-hidden">
        {rows.map(([k, v]) => (
          <div key={k} className="flex border-b border-app-border-light last:border-b-0">
            <dt className="w-56 px-3 py-2 bg-app-surface-variant text-app-text-secondary">{k}</dt>
            <dd className="flex-1 px-3 py-2 break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <button
        onClick={() => labApi.openLabDirectory()}
        className="mt-4 px-3 py-1.5 text-sm border border-app-border-medium rounded hover:bg-app-surface-variant"
      >
        Open Lab folder
      </button>
      <p className="text-xs text-app-text-tertiary mt-4">
        The lexicon editor, algorithm defaults, export directory and “Export
        everything” arrive with the phases that produce something to export.
      </p>
    </div>
  );
}
