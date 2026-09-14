import { useCallback, useEffect, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, rustErr, rustOk, type FreqStatus, type LabStatus, type Page, type PageRef, type Progress } from './api/lab';
import { ModeBadge, UnavailableNotice } from './components/ModeBadge';
import { BookBrowser } from './components/BookBrowser';
import { Reader } from './components/Reader';
import { StatsPanel, type HitRef } from './components/stats/StatsPanel';
import { IsnadWorkbench } from './components/isnad/IsnadWorkbench';
import { ReusePanel } from './components/reuse/ReusePanel';
import { QuranPanel } from './components/quran/QuranPanel';
import { NetworkPanel } from './components/network/NetworkPanel';
import { PoetryPanel } from './components/poetry/PoetryPanel';

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
  { id: 'stats', label: 'Stats' },
  { id: 'isnad', label: 'Isnād' },
  { id: 'reuse', label: 'Reuse' },
  { id: 'quran', label: 'Qurʾān' },
  { id: 'network', label: 'Network' },
  { id: 'poetry', label: 'Poetry (exp.)' },
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
  const [highlight, setHighlight] = useState<[number, number] | null>(null);

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
    setHighlight(null);
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

  const goToPage = async (next: number, mark: [number, number] | null = null) => {
    if (next < 0 || next >= pages.length) return;
    const ref = pages[next];
    setPageLoading(true);
    setPageError(null);
    try {
      const p = await labApi.getPage(ref.book_id, ref.part_index, ref.page_id);
      setPageIndex(next);
      setPage(p);
      setHighlight(mark);
    } catch (e) {
      setPageError(String(e));
    } finally {
      setPageLoading(false);
    }
  };

  /** A concordance row or section heading: open the reader there, marked. */
  const showHit = (hit: HitRef) => {
    const idx = pages.findIndex((p) => p.part_index === hit.part_index && p.page_id === hit.page_id);
    if (idx < 0) return;
    setPanel('books');
    void goToPage(idx, [hit.tok_start, hit.tok_end]);
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
        ) : panel === 'stats' ? (
          <main className="flex-1 min-h-0">
            <StatsPanel book={current} onShowHit={showHit} />
          </main>
        ) : panel === 'isnad' ? (
          <main className="flex-1 min-h-0">
            <IsnadWorkbench book={current} />
          </main>
        ) : panel === 'reuse' ? (
          <main className="flex-1 min-h-0">
            <ReusePanel book={current} local={status?.mode === 'local'} />
          </main>
        ) : panel === 'quran' ? (
          <main className="flex-1 min-h-0">
            <QuranPanel book={current} />
          </main>
        ) : panel === 'network' ? (
          <main className="flex-1 min-h-0">
            <NetworkPanel book={current} />
          </main>
        ) : panel === 'poetry' ? (
          <main className="flex-1 min-h-0">
            <PoetryPanel book={current} />
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
                onNavigate={(i) => goToPage(i)}
                highlight={highlight}
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

/** Mode, corpus, Lab's directory, stop words and the frequency snapshot (spec §7.8). */
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
    <div className="max-w-3xl space-y-8">
      <section>
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
      </section>

      <FreqSnapshotSettings local={status.mode === 'local'} />
      <StopwordSettings />

      <p className="text-xs text-app-text-tertiary">
        The lexicon editor, algorithm defaults, export directory and “Export
        everything” arrive with the phases that produce something to export.
      </p>
    </div>
  );
}

/** Corpus frequencies (spec §3.4): present, or why not, and the local build. */
function FreqSnapshotSettings({ local }: { local: boolean }) {
  const [status, setStatus] = useState<FreqStatus | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    labApi.statsFreqStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    let un: (() => void) | undefined;
    labApi.onStatsProgress((p) => p.stage === 'freq' && setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await labApi.statsBuildFreqTables());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const line = (label: string, r: FreqStatus[keyof FreqStatus] | undefined) =>
    r === undefined ? '…' : rustOk(r) != null ? `${label}: ${rustOk(r)!.toLocaleString()} entries` : `${label}: ${rustErr(r)}`;

  return (
    <section>
      <h3 className="text-base font-semibold mb-2">Corpus frequencies</h3>
      <p className="text-xs text-app-text-secondary mb-2">
        Keyness compares the book with the whole corpus using a frequency snapshot shipped with the
        corpus (spec §3.4). If the corpus you have does not include it, local mode can build it
        here — one scan of the corpus, several minutes on the full 4.1.0.
      </p>
      <div className="text-sm space-y-1" data-testid="freq-status">
        <div>{line('Lemmas', status?.lemma)}</div>
        <div>{line('Roots', status?.root)}</div>
      </div>
      {progress && (
        <div className="text-xs text-app-text-secondary mt-2" role="status">
          Scanning: {progress.done.toLocaleString()} / {progress.total.toLocaleString()} books
          {progress.estimate_ms != null && ` · about ${Math.ceil(progress.estimate_ms / 1000)} s in all`}
          <button onClick={() => labApi.statsCancel()} className="ml-3 px-2 py-0.5 border border-app-border-medium rounded">
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div className="text-sm text-app-error mt-2" role="alert">
          {error}
        </div>
      )}
      <button
        onClick={build}
        disabled={!local || busy}
        title={local ? undefined : 'Building the snapshot needs a local corpus'}
        className="mt-3 px-3 py-1.5 text-sm border border-app-border-medium rounded hover:bg-app-surface-variant disabled:opacity-40"
      >
        {busy ? 'Building…' : 'Build frequency snapshot'}
      </button>
    </section>
  );
}

/** The stop list (spec §4.1): shipped default, editable, resettable. */
function StopwordSettings() {
  const [text, setText] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await labApi.getStopwords();
      setText(w.join('\n'));
      setCount(w.length);
    } catch (e) {
      setMsg(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    try {
      const n = await labApi.setStopwords(text.split(/\r?\n/));
      setCount(n);
      setMsg(`Saved ${n} stop words. They apply to the next statistic you run.`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const reset = async () => {
    try {
      const w = await labApi.resetStopwords();
      setText(w.join('\n'));
      setCount(w.length);
      setMsg('Reset to the shipped list.');
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <section>
      <h3 className="text-base font-semibold mb-2">Stop words</h3>
      <p className="text-xs text-app-text-secondary mb-2">
        One lemma per line, as the pipeline writes it (no tashkil). Applied on every layer when the
        Stats toggle is on. {count != null && `${count} entries.`}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        dir="rtl"
        aria-label="Stop words"
        className="w-full h-48 font-arabic text-base border border-app-border-medium rounded p-2"
      />
      <div className="flex items-center gap-2 mt-2 text-sm">
        <button onClick={save} className="px-3 py-1 bg-app-accent text-white rounded">
          Save
        </button>
        <button onClick={reset} className="px-3 py-1 border border-app-border-medium rounded">
          Reset to default
        </button>
        {msg && <span className="text-xs text-app-text-tertiary">{msg}</span>}
      </div>
    </section>
  );
}
