import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type LabStatus } from './api/lab';
import { workspaceApi, type WorkspaceEntry } from './api/workspace';
import type { At } from './api/pages';
import { UnavailableNotice } from './components/ModeBadge';
import { MenuBar } from './components/MenuBar';
import { PanelBoundary } from './components/ui/PanelBoundary';
import { WorkspaceView } from './components/workspace/WorkspaceView';
import { ReadPanel } from './components/read/ReadPanel';
import { SearchPanel } from './components/search/SearchPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatsPanel, type HitRef } from './components/stats/StatsPanel';
import { IsnadWorkbench } from './components/isnad/IsnadWorkbench';
import { ReusePanel } from './components/reuse/ReusePanel';
import { QuranPanel } from './components/quran/QuranPanel';
import { NetworkPanel } from './components/network/NetworkPanel';
import { PoetryPanel } from './components/poetry/PoetryPanel';

/**
 * The Lab shell (spec 1.5 §A3).
 *
 * Lab opens on the workspace, not on a panel: the unit of work is a text you
 * have chosen to work on, and the left rail is what you can do to the one that
 * is open. Everything about Lab itself — Settings, About, the way back to the
 * workspace — is in the menu bar above.
 */

const PANELS = [
  { id: 'read', label: 'Read' },
  { id: 'search', label: 'Search' },
  { id: 'stats', label: 'Stats' },
  { id: 'isnad', label: 'Isnād' },
  { id: 'reuse', label: 'Reuse' },
  { id: 'quran', label: 'Qurʾān' },
  { id: 'network', label: 'Network' },
  { id: 'poetry', label: 'Poetry (exp.)' },
] as const;

type PanelId = (typeof PANELS)[number]['id'];

export default function App() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [authors, setAuthors] = useState<Map<number, string>>(new Map());
  const [genres, setGenres] = useState<Map<number, string>>(new Map());
  const [booksLoading, setBooksLoading] = useState(false);
  const [booksError, setBooksError] = useState<string | null>(null);

  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [current, setCurrent] = useState<BookMetadata | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [view, setView] = useState<'workspace' | 'text'>('workspace');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<PanelId>('read');

  /** Where the Read panel should open, when another panel sends it there. */
  const [readAt, setReadAt] = useState<At | null>(null);
  const [readMark, setReadMark] = useState<[number, number] | null>(null);
  /** A passage handed to Reuse by "Find reuse" (spec §C4, §H1). */
  const [reuseFrom, setReuseFrom] = useState<{ at: At; range: [number, number] } | null>(null);

  const [dirty, setDirty] = useState(false);
  /**
   * Bumped whenever a panel changes what the database holds, so the network
   * follows the isnāds being confirmed rather than waiting to be reloaded
   * (spec 1.5 §J1).
   */
  const [dataVersion, setDataVersion] = useState(0);
  const [saveNote, setSaveNote] = useState<string | null>(null);

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
      const [bs, as, gs] = await Promise.all([labApi.listBooks(), labApi.listAuthors(), labApi.listGenres()]);
      setBooks(bs);
      setAuthors(new Map(as.map((a) => [a.id, a.name])));
      setGenres(new Map(gs.map((g) => [g.id, g.name])));
    } catch (e) {
      setBooks([]);
      setBooksError(String(e));
    } finally {
      setBooksLoading(false);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      setEntries(await workspaceApi.list());
    } catch (e) {
      console.error('workspace_list failed', e);
    }
  }, []);

  useEffect(() => {
    if (status && status.mode !== 'unavailable') {
      void loadBooks();
      void loadWorkspace();
    }
  }, [status, loadBooks, loadWorkspace]);

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

  /** Open a workspace text: the DB and the folder agree, then the panels load it. */
  const openText = useCallback(
    async (bookId: number) => {
      setOpenError(null);
      try {
        const opened = await workspaceApi.open(bookId);
        const book = books.find((b) => b.id === bookId) ?? (await labApi.getBook(bookId));
        setCurrent(book ?? null);
        setReadAt(opened.state.last_page ? { part_index: opened.state.last_page[0], page_id: opened.state.last_page[1] } : null);
        setReadMark(null);
        setReuseFrom(null);
        setView('text');
        setSettingsOpen(false);
        setPanel('read');
        void loadWorkspace();
        if (opened.imported && importedAnything(opened.imported)) {
          setSaveNote(
            `Read back from the folder: ${opened.imported.isnads} isnāds, ${opened.imported.reuse} reuse verdicts, ` +
              `${opened.imported.quran} Qurʾān verdicts, ${opened.imported.notes} notes` +
              (opened.imported.reanchored ? `, ${opened.imported.reanchored} re-anchored` : '') +
              (opened.imported.orphaned ? `, ${opened.imported.orphaned} that no longer fit the text` : '')
          );
        }
      } catch (e) {
        setOpenError(String(e));
      }
    },
    [books, loadWorkspace]
  );

  /** Ctrl+S: write everything about the open text out to its folder (§A2). */
  const saveAll = useCallback(async () => {
    if (!current) return;
    try {
      const report = await workspaceApi.export(current.id);
      setDirty(false);
      setSaveNote(
        report
          ? `Saved to ${report.dir}: ${report.confirmed_isnads} isnāds, ${report.transmitters} transmitters, ` +
              `${report.reuse_verdicts} reuse verdicts, ${report.quran_verdicts} Qurʾān verdicts, ${report.notes} notes.`
          : 'This text is not in the workspace, so there is no folder to save into.'
      );
    } catch (e) {
      setSaveNote(String(e));
    }
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveAll]);

  useEffect(() => {
    if (!saveNote) return;
    const t = setTimeout(() => setSaveNote(null), 8000);
    return () => clearTimeout(t);
  }, [saveNote]);

  /** A concordance row, a section heading, a search hit: read it there. */
  const showHit = useCallback((hit: HitRef) => {
    setReadAt({ part_index: hit.part_index, page_id: hit.page_id });
    setReadMark([hit.tok_start, hit.tok_end]);
    setPanel('read');
    setSettingsOpen(false);
    setView('text');
  }, []);

  const toWorkspace = useCallback(() => {
    setView('workspace');
    setSettingsOpen(false);
    void loadWorkspace();
  }, [loadWorkspace]);

  const title = current?.title ?? null;
  const panelLabel = PANELS.find((p) => p.id === panel)?.label ?? panel;
  const showRail = view === 'text' && !settingsOpen && status?.mode !== 'unavailable';

  const body = useMemo(() => {
    if (status?.mode === 'unavailable') {
      return (
        <main className="flex-1 overflow-y-auto">
          <UnavailableNotice status={status} />
        </main>
      );
    }
    if (settingsOpen) {
      return (
        <main className="flex-1 overflow-y-auto p-6">
          <SettingsPanel status={status} />
        </main>
      );
    }
    if (view === 'workspace') {
      return (
        <WorkspaceView
          entries={entries}
          currentId={current?.id ?? null}
          books={books}
          authors={authors}
          genres={genres}
          booksLoading={booksLoading}
          booksError={booksError}
          onOpen={(id) => void openText(id)}
          onChanged={() => void loadWorkspace()}
        />
      );
    }
    switch (panel) {
      case 'read':
        return (
          <ReadPanel
            book={current}
            initialAt={readAt}
            highlight={readMark}
            onFindReuse={(sel) => {
              setReuseFrom({ at: sel.at, range: sel.range });
              setPanel('reuse');
            }}
            onPageChange={(at) => {
              if (current) void workspaceApi.saveState(current.id, { last_page: [at.part_index, at.page_id], panels: {} }).catch(() => {});
            }}
            onNotesChanged={() => {
              setDirty(true);
              void loadWorkspace();
            }}
          />
        );
      case 'search':
        return (
          <SearchPanel
            book={current}
            onShowHit={(at, matched) => {
              setReadAt(at);
              setReadMark(matched.length > 0 ? [Math.min(...matched), Math.max(...matched) + 1] : null);
              setPanel('read');
            }}
          />
        );
      case 'stats':
        return <StatsPanel book={current} onShowHit={showHit} />;
      case 'isnad':
        return (
          <IsnadWorkbench
            book={current}
            onChanged={() => {
              setDirty(true);
              setDataVersion((v) => v + 1);
            }}
          />
        );
      case 'reuse':
        return <ReusePanel book={current} local={status?.mode === 'local'} from={reuseFrom} onChanged={() => setDirty(true)} />;
      case 'quran':
        return <QuranPanel book={current} onChanged={() => setDirty(true)} />;
      case 'network':
        return <NetworkPanel book={current} version={dataVersion} />;
      case 'poetry':
        return <PoetryPanel book={current} />;
    }
  }, [
    status,
    settingsOpen,
    view,
    entries,
    current,
    books,
    authors,
    genres,
    booksLoading,
    booksError,
    openText,
    loadWorkspace,
    panel,
    readAt,
    readMark,
    reuseFrom,
    showHit,
    dataVersion,
  ]);

  return (
    <div className="h-screen flex flex-col bg-app-bg text-app-text-primary">
      <MenuBar
        status={status}
        onRecheck={recheck}
        rechecking={rechecking}
        onWorkspace={toWorkspace}
        onSettings={() => setSettingsOpen((v) => !v)}
        inWorkspaceView={view === 'workspace' && !settingsOpen}
        settingsOpen={settingsOpen}
        currentTitle={title}
        dirty={dirty}
        onSave={() => void saveAll()}
      />

      {(saveNote || openError) && (
        <div className={`px-4 py-1 text-xs border-b border-app-border-light ${openError ? 'text-app-error' : 'text-app-text-secondary'}`} role="status">
          {openError ?? saveNote}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {showRail && (
          <nav className="w-36 shrink-0 border-r border-app-border-light bg-app-surface flex flex-col py-2" aria-label="Panels">
            {PANELS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPanel(p.id)}
                className={`text-left px-4 py-2 text-sm ${
                  panel === p.id ? 'bg-app-accent-light text-app-accent font-medium' : 'hover:bg-app-surface-variant'
                }`}
              >
                {p.label}
              </button>
            ))}
          </nav>
        )}
        {/* A panel that throws costs that panel, not the window (A1). */}
        <PanelBoundary name={settingsOpen ? 'Settings' : view === 'workspace' ? 'Workspace' : panelLabel}>
          {body}
        </PanelBoundary>
      </div>
    </div>
  );
}

function importedAnything(r: { isnads: number; reuse: number; quran: number; notes: number; transmitters: number }): boolean {
  return r.isnads + r.reuse + r.quran + r.notes + r.transmitters > 0;
}
