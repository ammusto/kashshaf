import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import {
  labApi,
  type Collocations,
  type ConcordanceLine,
  type DispersionResponse,
  type FreqResponse,
  type KeyItem,
  type KeynessResponse,
  type Layer,
  type LoadSummary,
  type NgramRow,
  type Progress,
  type RefSpec,
  type Scope,
  type Section,
  type SortBy,
} from '../../api/lab';
import { exportTable, type ExportColumn, type ExportFormat } from '../../utils/exportTable';
import { VirtualTable, fmt, type Column } from './VirtualTable';
import { Pages, usePages } from '../../api/pages';

/**
 * The Stats panel (spec §7.3): six tabs over the current book, each with a
 * layer selector, the stop-word toggle, filters, a virtualised table and an
 * Export button. Concordance rows click through to the reader with the hit
 * highlighted.
 *
 * Every number comes from a backend command that calls one pure function in
 * `analysis/`; this file only asks and renders.
 */

export interface HitRef {
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
}

type Tab = 'frequencies' | 'concordance' | 'keyness' | 'dispersion' | 'collocations';

const TABS: { id: Tab; label: string }[] = [
  { id: 'frequencies', label: 'Frequencies' },
  { id: 'concordance', label: 'Concordance' },
  { id: 'keyness', label: 'Keyness' },
  { id: 'dispersion', label: 'Dispersion' },
  { id: 'collocations', label: 'Collocations' },
];

/** Per-book panel state kept in memory across book switches (spec §7.1). */
interface Remembered {
  tab: Tab;
  layer: Layer;
  stop: boolean;
  section: number | null;
  query: string;
  node: string;
  term: string;
}

const memory = new Map<number, Remembered>();

/** Forget every book's panel state — for tests, which share one module. */
export function resetStatsMemory() {
  memory.clear();
}

function remembered(bookId: number): Remembered {
  return (
    memory.get(bookId) ?? { tab: 'frequencies', layer: 'lemma', stop: true, section: null, query: '', node: '', term: '' }
  );
}

export function StatsPanel({ book, onShowHit }: { book: BookMetadata | null; onShowHit: (hit: HitRef) => void }) {
  const bookId = book?.id ?? null;
  const [mem, setMem] = useState<Remembered>(() => (bookId ? remembered(bookId) : remembered(-1)));
  const [summary, setSummary] = useState<LoadSummary | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);

  // Switching books swaps the remembered state in and loads the book.
  useEffect(() => {
    if (bookId == null) return;
    setMem(remembered(bookId));
    setSummary(null);
    setLoadError(null);
    setSections([]);
    let alive = true;
    (async () => {
      try {
        const s = await labApi.statsLoadBook(bookId);
        if (!alive) return;
        setSummary(s);
        const secs = await labApi.statsSections(bookId);
        if (alive) setSections(secs.sections);
      } catch (e) {
        if (alive) setLoadError(String(e));
      } finally {
        if (alive) setProgress(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bookId]);

  useEffect(() => {
    if (bookId != null) memory.set(bookId, mem);
  }, [bookId, mem]);

  useEffect(() => {
    let un: (() => void) | undefined;
    labApi.onStatsProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  const update = (patch: Partial<Remembered>) => setMem((m) => ({ ...m, ...patch }));

  const scope: Scope | null = useMemo(
    () => (bookId == null ? null : { book_id: bookId, layer: mem.layer, stop: mem.stop, section: mem.section }),
    [bookId, mem.layer, mem.stop, mem.section]
  );

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Open a text from the workspace first.</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-4 flex-wrap">
        <div className="flex gap-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mem.tab === t.id}
              onClick={() => update({ tab: t.id })}
              className={`px-3 py-1 text-sm rounded ${
                mem.tab === t.id ? 'bg-app-accent-light text-app-accent font-medium' : 'hover:bg-app-surface-variant'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-app-text-tertiary ml-auto" data-testid="stats-summary">
          {summary
            ? `${summary.tokens.toLocaleString()} tokens · ${summary.pages.toLocaleString()} pages · ${
                summary.sections
              } sections${summary.cached ? '' : ` · loaded in ${(summary.load_ms / 1000).toFixed(1)} s`}`
            : loadError
              ? ''
              : 'Loading book…'}
        </span>
      </div>

      {progress && (
        <ProgressBar progress={progress} onCancel={() => labApi.statsCancel().catch(() => {})} />
      )}
      {loadError && (
        <div className="px-4 py-2 text-sm text-app-error" role="alert">
          {loadError}
        </div>
      )}

      {scope && summary && <ScopeBar mem={mem} update={update} sections={sections} />}

      <div className="flex-1 min-h-0 flex flex-col p-4 gap-2 overflow-hidden">
        {scope && summary && (
          <>
            {mem.tab === 'frequencies' && <FrequenciesTab scope={scope} book={book} />}
            {mem.tab === 'concordance' && (
              <ConcordanceTab
                scope={scope}
                book={book}
                query={mem.query}
                onQuery={(query) => update({ query })}
                onShowHit={onShowHit}
              />
            )}
            {mem.tab === 'keyness' && <KeynessTab scope={scope} book={book} />}
            {mem.tab === 'dispersion' && (
              <DispersionTab scope={scope} book={book} term={mem.term} onTerm={(term) => update({ term })} onShowHit={onShowHit} />
            )}
            {mem.tab === 'collocations' && (
              <CollocationsTab scope={scope} book={book} node={mem.node} onNode={(node) => update({ node })} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shared ---

/**
 * The layer, the stop list and the section (spec 1.5 §E).
 *
 * These are not properties of the panel; they qualify the statistic under
 * them, and they belong next to it. Section is a filter here, which is why
 * the Sections tab is gone: what a reader wanted from it was to look at one
 * section, and now every tab does.
 */
function ScopeBar({
  mem,
  update,
  sections,
}: {
  mem: Remembered;
  update: (patch: Partial<Remembered>) => void;
  sections: Section[];
}) {
  return (
    <div className="px-4 py-1.5 border-b border-app-border-light bg-app-surface-variant flex items-center gap-4 flex-wrap text-xs text-app-text-secondary">
      <label className="flex items-center gap-1">
        Layer
        <select
          aria-label="Layer"
          value={mem.layer}
          onChange={(e) => update({ layer: e.target.value as Layer })}
          className="border border-app-border-medium rounded px-1 py-0.5"
        >
          <option value="surface">surface</option>
          <option value="lemma">lemma</option>
          <option value="root">root</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={mem.stop} onChange={(e) => update({ stop: e.target.checked })} />
        Stop words off
      </label>
      <label className="flex items-center gap-1">
        Section
        <select
          aria-label="Section"
          value={mem.section ?? ''}
          onChange={(e) => update({ section: e.target.value === '' ? null : Number(e.target.value) })}
          className="border border-app-border-medium rounded px-1 py-0.5 font-arabic text-sm max-w-md"
          dir="rtl"
        >
          <option value="">whole text</option>
          {sections.map((sec) => (
            <option key={sec.id} value={sec.id}>
              {'  '.repeat(sec.depth)}
              {sec.title.slice(0, 80)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ProgressBar({ progress, onCancel }: { progress: Progress; onCancel: () => void }) {
  const pct = progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  const label =
    progress.stage === 'load' ? 'Loading pages' : progress.stage === 'reference' ? 'Reading reference books' : progress.stage === 'freq' ? 'Scanning the corpus' : progress.stage;
  return (
    <div className="px-4 py-2 border-b border-app-border-light bg-app-surface-variant flex items-center gap-3 text-xs" role="status">
      <span>
        {label}: {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
        {progress.estimate_ms != null && ` · about ${Math.ceil(progress.estimate_ms / 1000)} s in all`}
      </span>
      <div className="flex-1 h-1.5 bg-app-border-light rounded overflow-hidden">
        <div className="h-full bg-app-accent" style={{ width: `${pct}%` }} />
      </div>
      <button onClick={onCancel} className="px-2 py-0.5 border border-app-border-medium rounded hover:bg-app-surface">
        Cancel
      </button>
    </div>
  );
}

function ExportButton<T>({ name, columns, rows }: { name: string; columns: ExportColumn<T>[]; rows: T[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (format: ExportFormat) => {
    try {
      const r = await exportTable(name, format, columns, rows);
      setMsg(`Saved to ${r.savedAs ?? r.path}`);
    } catch (e) {
      setMsg(`Export failed: ${e}`);
    }
  };
  return (
    <span className="flex items-center gap-2 text-xs">
      <button
        onClick={() => run('csv')}
        disabled={rows.length === 0}
        className="px-2 py-1 border border-app-border-medium rounded hover:bg-app-surface-variant disabled:opacity-40"
        data-testid="export-button"
      >
        Export CSV
      </button>
      <button
        onClick={() => run('json')}
        disabled={rows.length === 0}
        className="px-2 py-1 border border-app-border-medium rounded hover:bg-app-surface-variant disabled:opacity-40"
      >
        JSON
      </button>
      {msg && <span className="text-app-text-tertiary truncate max-w-md">{msg}</span>}
    </span>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <div className="text-sm text-app-error my-2" role="alert">
      {error}
    </div>
  ) : null;
}

function slug(book: BookMetadata, ...parts: (string | number)[]): string {
  return [`book${book.id}`, ...parts].join('-').replace(/\s+/g, '_');
}

/** A note that a column is empty and why — never a silent blank (ground rule 5). */
function Note({ text }: { text: string | null }) {
  return text ? (
    <div className="text-xs text-app-text-secondary bg-app-surface-variant rounded px-2 py-1 my-2" data-testid="corpus-note">
      {text}
    </div>
  ) : null;
}

// ----------------------------------------------------------- frequencies ---

function FrequenciesTab({ scope, book }: { scope: Scope; book: BookMetadata }) {
  const [data, setData] = useState<FreqResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let alive = true;
    setError(null);
    labApi
      .statsFrequencies(scope)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [scope]);

  const rows = useMemo(() => {
    if (!data) return [];
    return filter ? data.list.rows.filter((r) => r.key.includes(filter)) : data.list.rows;
  }, [data, filter]);

  const columns: Column<FreqResponse['list']['rows'][number]>[] = [
    { key: 'key', label: scope.layer, sortValue: (r) => r.key, rtl: true, width: 'minmax(160px, 2fr)' },
    { key: 'count', label: 'Count', sortValue: (r) => r.count, align: 'right', defaultSort: 'desc', render: (r) => fmt(r.count) },
    { key: 'pm', label: 'Per million', sortValue: (r) => r.per_million, align: 'right', render: (r) => fmt(r.per_million) },
    { key: 'cc', label: 'Corpus count', sortValue: (r) => r.corpus_count, align: 'right', render: (r) => fmt(r.corpus_count) },
    { key: 'cr', label: 'Corpus rank', sortValue: (r) => r.corpus_rank, align: 'right', render: (r) => fmt(r.corpus_rank) },
    { key: 'cpm', label: 'Corpus per million', sortValue: (r) => r.corpus_per_million, align: 'right', render: (r) => fmt(r.corpus_per_million) },
  ];
  const exportCols: ExportColumn<(typeof rows)[number]>[] = columns.map((c) => ({ key: c.key, label: c.label, value: c.sortValue }));

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter"
          dir="rtl"
          className="px-2 py-1 border border-app-border-medium rounded font-arabic text-lg"
        />
        <span className="text-xs text-app-text-tertiary" data-testid="freq-summary">
          {data ? `${data.list.distinct.toLocaleString()} distinct · ${data.list.total.toLocaleString()} tokens` : 'Computing…'}
        </span>
        <span className="ml-auto">
          <ExportButton name={slug(book, 'frequencies', scope.layer)} columns={exportCols} rows={rows} />
        </span>
      </div>
      <Note text={data?.corpus_note ?? null} />
      <ErrorLine error={error} />
      <VirtualTable columns={columns} rows={rows} rowKey={(r) => r.key} testId="freq-table" />
    </div>
  );
}

// ----------------------------------------------------------- concordance ---

function ConcordanceTab({
  scope,
  book,
  query,
  onQuery,
  onShowHit,
}: {
  scope: Scope;
  book: BookMetadata;
  query: string;
  onQuery: (q: string) => void;
  onShowHit: (hit: HitRef) => void;
}) {
  const pages = usePages(book.id, book.parts);
  const [clitics, setClitics] = useState(true);
  const [context, setContext] = useState(8);
  const [sort, setSort] = useState<SortBy>('position');
  const [lines, setLines] = useState<ConcordanceLine[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const PAGE = 200;

  const run = useCallback(
    async (offset: number) => {
      if (!query.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const r = await labApi.statsConcordance({ scope, query, clitics, context, sort, offset, limit: PAGE });
        setTotal(r.total);
        setLines((prev) => (offset === 0 ? r.lines : [...prev, ...r.lines]));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [scope, query, clitics, context, sort]
  );

  // Re-run when the scope or sort changes and there is a query.
  useEffect(() => {
    if (query.trim()) void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, sort, context, clitics]);

  // Right to left, as the text reads (spec 1.5 §E): the words before the
  // hit sit to its right, the words after it to its left, and the hit itself
  // takes only the width it needs so the two contexts meet at it.
  const columns: Column<ConcordanceLine>[] = [
    {
      key: 'left',
      label: 'Preceding',
      sortValue: (l) => l.left.join(' '),
      rtl: true,
      render: (l) => l.left.join(' '),
      width: 'minmax(0, 1fr)',
      align: 'right',
    },
    {
      key: 'node',
      label: 'Hit',
      sortValue: (l) => l.node.join(' '),
      rtl: true,
      render: (l) => <span className="tok-selected px-1">{l.node.join(' ')}</span>,
      width: 'max-content',
    },
    {
      key: 'right',
      label: 'Following',
      sortValue: (l) => l.right.join(' '),
      rtl: true,
      render: (l) => l.right.join(' '),
      width: 'minmax(0, 1fr)',
      align: 'left',
    },
    { key: 'loc', label: 'Page', sortValue: (l) => l.global, render: (l) => pages.label(l.part_index, l.page_id), width: '90px', align: 'right' },
  ];
  const exportCols: ExportColumn<ConcordanceLine>[] = [
    { key: 'part', label: 'Part', value: (l) => l.part_label },
    { key: 'page', label: 'Page', value: (l) => l.page_number },
    { key: 'tok_start', label: 'Token start', value: (l) => l.tok_start },
    { key: 'tok_end', label: 'Token end', value: (l) => l.tok_end },
    { key: 'left', label: 'Left', value: (l) => l.left.join(' ') },
    { key: 'node', label: 'Hit', value: (l) => l.node.join(' ') },
    { key: 'right', label: 'Right', value: (l) => l.right.join(' ') },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <form
        className="flex items-center gap-3 mb-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void run(0);
        }}
      >
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={scope.layer === 'root' ? 'root, e.g. قول' : scope.layer === 'lemma' ? 'lemma or phrase' : 'word or phrase, * allowed'}
          aria-label="Query"
          dir="rtl"
          className="px-2 py-1 border border-app-border-medium rounded font-arabic text-lg w-64"
        />
        <button type="submit" disabled={busy || !query.trim()} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
          Search
        </button>
        {scope.layer === 'surface' && (
          <label className="text-xs flex items-center gap-1">
            <input type="checkbox" checked={clitics} onChange={(e) => setClitics(e.target.checked)} /> clitics
          </label>
        )}
        <label className="text-xs flex items-center gap-1">
          context
          <input
            type="number"
            min={3}
            max={25}
            value={context}
            onChange={(e) => setContext(Math.min(25, Math.max(3, Number(e.target.value) || 8)))}
            className="w-14 border border-app-border-medium rounded px-1"
            aria-label="Context"
          />
        </label>
        <label className="text-xs flex items-center gap-1">
          sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortBy)} className="border border-app-border-medium rounded px-1" aria-label="Sort">
            <option value="position">position</option>
            <option value="left">left context</option>
            <option value="right">right context</option>
          </select>
        </label>
        <span className="text-xs text-app-text-tertiary" data-testid="conc-summary">
          {total != null && `${total.toLocaleString()} hits`}
        </span>
        <span className="ml-auto">
          <ExportButton name={slug(book, 'concordance', scope.layer, query)} columns={exportCols} rows={lines} />
        </span>
      </form>
      <ErrorLine error={error} />
      <div className="flex-1 min-h-0">
        <VirtualTable
          columns={columns}
          rows={lines}
          rowKey={(l) => `${l.page}:${l.tok_start}`}
          onRowClick={(l) => onShowHit({ part_index: l.part_index, page_id: l.page_id, tok_start: l.tok_start, tok_end: l.tok_end })}
          height="fill"
          dir="rtl"
          emptyText={query.trim() ? (total === 0 ? 'No hits.' : 'Press Search.') : 'Type a query.'}
          testId="conc-table"
        />
      </div>
      {total != null && lines.length < total && (
        <button onClick={() => run(lines.length)} disabled={busy} className="mt-2 px-3 py-1 text-sm border border-app-border-medium rounded">
          Load {Math.min(PAGE, total - lines.length)} more
        </button>
      )}
    </div>
  );
}

// --------------------------------------------------------------- keyness ---

function KeynessTab({ scope, book }: { scope: Scope; book: BookMetadata }) {
  const [refKind, setRefKind] = useState<RefSpec['kind']>('corpus');
  const [ids, setIds] = useState('');
  const [minFreq, setMinFreq] = useState(3);
  const [minBic, setMinBic] = useState(2);
  const [direction, setDirection] = useState<'all' | 'positive' | 'negative'>('all');
  const [data, setData] = useState<KeynessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reference: RefSpec = useMemo(() => {
    if (refKind === 'books') {
      const parsed = ids.split(/[\s,]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
      return { kind: 'books', ids: parsed };
    }
    return { kind: refKind } as RefSpec;
  }, [refKind, ids]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await labApi.statsKeyness({ scope, reference, min_freq: minFreq, min_bic: minBic }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => (data ? data.items.filter((i) => direction === 'all' || i.direction === direction) : []), [data, direction]);

  const columns: Column<KeyItem>[] = [
    { key: 'key', label: scope.layer, sortValue: (r) => r.key, rtl: true, width: 'minmax(140px, 2fr)' },
    { key: 'dir', label: '±', sortValue: (r) => (r.direction === 'positive' ? 1 : 0), render: (r) => (r.direction === 'positive' ? '+' : '−'), width: '36px' },
    { key: 'bc', label: 'Book', sortValue: (r) => r.book_count, align: 'right', render: (r) => fmt(r.book_count) },
    { key: 'bpm', label: 'Book /M', sortValue: (r) => r.book_per_million, align: 'right', render: (r) => fmt(r.book_per_million) },
    { key: 'rc', label: 'Ref', sortValue: (r) => r.ref_count, align: 'right', render: (r) => fmt(r.ref_count) },
    { key: 'rpm', label: 'Ref /M', sortValue: (r) => r.ref_per_million, align: 'right', render: (r) => fmt(r.ref_per_million) },
    { key: 'g2', label: 'G²', sortValue: (r) => r.g2, align: 'right', render: (r) => fmt(r.g2, 2) },
    { key: 'bic', label: 'BIC', sortValue: (r) => r.bic, align: 'right', defaultSort: 'desc', render: (r) => fmt(r.bic, 2) },
    { key: 'lr', label: 'Log Ratio', sortValue: (r) => r.log_ratio, align: 'right', render: (r) => fmt(r.log_ratio, 2) },
  ];
  const exportCols: ExportColumn<KeyItem>[] = columns.map((c) => ({ key: c.key, label: c.label, value: c.sortValue }));

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap text-xs">
        <label className="flex items-center gap-1">
          reference
          <select value={refKind} onChange={(e) => setRefKind(e.target.value as RefSpec['kind'])} className="border border-app-border-medium rounded px-1 text-sm" aria-label="Reference">
            <option value="corpus">whole corpus (rest of)</option>
            <option value="author">same author</option>
            <option value="genre">same genre</option>
            <option value="century">same century</option>
            <option value="books">chosen books</option>
          </select>
        </label>
        {refKind === 'books' && (
          <input
            value={ids}
            onChange={(e) => setIds(e.target.value)}
            placeholder="book ids, e.g. 12, 340 (a Kashshaf collection's book_ids)"
            aria-label="Book ids"
            className="px-2 py-1 border border-app-border-medium rounded w-80"
          />
        )}
        <label className="flex items-center gap-1">
          min freq
          <input type="number" min={1} value={minFreq} onChange={(e) => setMinFreq(Math.max(1, Number(e.target.value) || 1))} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min freq" />
        </label>
        <label className="flex items-center gap-1">
          min BIC
          <input type="number" step={1} value={minBic} onChange={(e) => setMinBic(Number(e.target.value) || 0)} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min BIC" />
        </label>
        <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className="border border-app-border-medium rounded px-1 text-sm" aria-label="Direction">
          <option value="all">positive and negative</option>
          <option value="positive">positive (over-used)</option>
          <option value="negative">negative (under-used)</option>
        </select>
        <button onClick={run} disabled={busy} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
          Compute
        </button>
        <span className="text-app-text-tertiary" data-testid="key-summary">
          {data && `${rows.length.toLocaleString()} key items · book ${data.book_total.toLocaleString()} vs reference ${data.ref_total.toLocaleString()} tokens${data.ref_books ? ` (${data.ref_books} books)` : ''}`}
        </span>
        <span className="ml-auto">
          <ExportButton name={slug(book, 'keyness', scope.layer, refKind)} columns={exportCols} rows={rows} />
        </span>
      </div>
      <Note text={scope.layer === 'surface' && refKind === 'corpus' ? 'Keyness against the corpus runs on the lemma or root layer: corpus frequencies are shipped for those two (spec §3.4).' : null} />
      <ErrorLine error={error} />
      <VirtualTable columns={columns} rows={rows} rowKey={(r) => r.key} emptyText={data ? 'No key items at these thresholds.' : 'Choose a reference and press Compute.'} testId="key-table" />
    </div>
  );
}

// ------------------------------------------------------------ dispersion ---

function DispersionTab({
  scope,
  book,
  term,
  onTerm,
  onShowHit,
}: {
  scope: Scope;
  book: BookMetadata;
  term: string;
  onTerm: (t: string) => void;
  onShowHit: (hit: HitRef) => void;
}) {
  const pages = usePages(book.id, book.parts);
  const [data, setData] = useState<DispersionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!term.trim()) return;
    setError(null);
    try {
      setData(await labApi.statsDispersion(scope, term.trim()));
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (term.trim()) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const d = data?.dispersion;
  const bySection = data?.by_section ?? [];
  const exportCols: ExportColumn<[Section, number]>[] = [
    { key: 'section', label: 'Section', value: ([s]) => s.title },
    { key: 'depth', label: 'Depth', value: ([s]) => s.depth },
    { key: 'tokens', label: 'Tokens', value: ([s]) => s.tokens },
    { key: 'count', label: 'Occurrences', value: ([, n]) => n },
  ];
  const columns: Column<[Section, number]>[] = [
    { key: 'section', label: 'Section', sortValue: ([s]) => s.title, rtl: true, render: ([s]) => `${'— '.repeat(s.depth)}${s.title}`, width: '3fr' },
    { key: 'tokens', label: 'Tokens', sortValue: ([s]) => s.tokens, align: 'right', render: ([s]) => fmt(s.tokens) },
    { key: 'count', label: 'Occurrences', sortValue: ([, n]) => n, align: 'right', defaultSort: 'desc', render: ([, n]) => fmt(n) },
    { key: 'pm', label: 'Per million', sortValue: ([s, n]) => (s.tokens ? (n * 1e6) / s.tokens : 0), align: 'right', render: ([s, n]) => fmt(s.tokens ? (n * 1e6) / s.tokens : 0) },
  ];

  return (
    <div>
      <form
        className="flex items-center gap-3 mb-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input value={term} onChange={(e) => onTerm(e.target.value)} placeholder={`${scope.layer} to plot`} aria-label="Term" dir="rtl" className="px-2 py-1 border border-app-border-medium rounded font-arabic text-lg w-56" />
        <button type="submit" disabled={!term.trim()} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
          Plot
        </button>
        {d && (
          <span className="text-xs text-app-text-secondary" data-testid="disp-summary">
            {d.occurrences.toLocaleString()} occurrences · DP {d.dp.toFixed(3)} · DP<sub>norm</sub> {d.dp_norm.toFixed(3)}
          </span>
        )}
        <span className="ml-auto">
          <ExportButton name={slug(book, 'dispersion', scope.layer, term)} columns={exportCols} rows={bySection} />
        </span>
      </form>
      <ErrorLine error={error} />
      {d && data && <StripPlot data={data} pages={pages} onShowHit={onShowHit} />}
      {data && <VirtualTable columns={columns} rows={bySection} rowKey={([s]) => s.id} height={260} emptyText="This book has no <title> sections." />}
    </div>
  );
}

/** Occurrences along the book, one tick per hit, page axis labelled by part/page. */
function StripPlot({ data, pages, onShowHit }: { data: DispersionResponse; pages: Pages; onShowHit: (hit: HitRef) => void }) {
  const total = Math.max(1, data.dispersion.total);
  const starts = useMemo(() => {
    const s: number[] = [];
    let acc = 0;
    for (const p of data.pages) {
      s.push(acc);
      acc += p.tokens;
    }
    return s;
  }, [data.pages]);
  const partTicks = useMemo(() => {
    const t: { x: number; label: string }[] = [];
    let last: number | null = null;
    data.pages.forEach((p, i) => {
      if (p.part_index !== last) {
        // Parts are counted from one for the reader, whatever the corpus
        // calls them (spec 1.5 §C1).
        t.push({ x: (starts[i] / total) * 100, label: p.part_label || `${p.part_index + 1}` });
        last = p.part_index;
      }
    });
    return t;
  }, [data.pages, starts, total]);

  return (
    <div className="my-3" data-testid="strip-plot">
      <div className="relative h-10 bg-app-surface-variant rounded border border-app-border-light overflow-hidden">
        {data.dispersion.positions.map((pos, i) => {
          const g = starts[pos.page] + pos.idx;
          const p = data.pages[pos.page];
          return (
            <button
              key={i}
              title={`${pages.label(p.part_index, p.page_id)} · word ${pos.idx}`}
              onClick={() => onShowHit({ part_index: p.part_index, page_id: p.page_id, tok_start: pos.idx, tok_end: pos.idx + 1 })}
              className="absolute top-1 bottom-1 w-px bg-app-accent hover:w-0.5"
              style={{ left: `${(g / total) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="relative h-5 text-[10px] text-app-text-tertiary">
        {partTicks.map((t, i) => (
          <span key={i} className="absolute" style={{ left: `${t.x}%` }} dir="rtl">
            |{t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- collocations ---

function CollocationsTab({ scope, book, node, onNode }: { scope: Scope; book: BookMetadata; node: string; onNode: (n: string) => void }) {
  const [mode, setMode] = useState<'collocates' | 'ngrams'>('collocates');
  const [left, setLeft] = useState(5);
  const [right, setRight] = useState(5);
  const [spanAware, setSpanAware] = useState(true);
  const [minFreq, setMinFreq] = useState(3);
  const [n, setN] = useState(2);
  const [coll, setColl] = useState<Collocations | null>(null);
  const [grams, setGrams] = useState<NgramRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'collocates') {
        if (!node.trim()) return;
        setColl(await labApi.statsCollocations({ scope, node: node.trim(), left, right, span_aware: spanAware, min_freq: minFreq }));
      } else {
        setGrams(await labApi.statsNgrams({ scope, n, span_aware: spanAware, min_count: minFreq }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const collColumns: Column<Collocations['rows'][number]>[] = [
    { key: 'key', label: 'Collocate', sortValue: (r) => r.key, rtl: true, width: 'minmax(140px, 2fr)' },
    { key: 'o', label: 'Observed', sortValue: (r) => r.observed, align: 'right', render: (r) => fmt(r.observed) },
    { key: 'e', label: 'Expected', sortValue: (r) => r.expected, align: 'right', render: (r) => fmt(r.expected, 2) },
    { key: 'f', label: 'Freq', sortValue: (r) => r.freq, align: 'right', render: (r) => fmt(r.freq) },
    { key: 'mi', label: 'MI', sortValue: (r) => r.mi, align: 'right', render: (r) => fmt(r.mi, 2) },
    { key: 'll', label: 'LL', sortValue: (r) => r.log_likelihood, align: 'right', defaultSort: 'desc', render: (r) => fmt(r.log_likelihood, 2) },
    { key: 't', label: 't-score', sortValue: (r) => r.t_score, align: 'right', render: (r) => fmt(r.t_score, 2) },
  ];
  const gramColumns: Column<NgramRow>[] = [
    { key: 'gram', label: `${n}-gram`, sortValue: (r) => r.gram.join(' '), rtl: true, render: (r) => r.gram.join(' '), width: '3fr' },
    { key: 'count', label: 'Count', sortValue: (r) => r.count, align: 'right', defaultSort: 'desc', render: (r) => fmt(r.count) },
    { key: 'pm', label: 'Per million', sortValue: (r) => r.per_million, align: 'right', render: (r) => fmt(r.per_million) },
  ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap text-xs">
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="border border-app-border-medium rounded px-1 text-sm" aria-label="Mode">
          <option value="collocates">collocates of a node</option>
          <option value="ngrams">n-grams</option>
        </select>
        {mode === 'collocates' ? (
          <>
            <input value={node} onChange={(e) => onNode(e.target.value)} placeholder={`node ${scope.layer}`} aria-label="Node" dir="rtl" className="px-2 py-1 border border-app-border-medium rounded font-arabic text-lg w-48" />
            <label className="flex items-center gap-1">
              left
              <input type="number" min={0} max={50} value={left} onChange={(e) => setLeft(Math.max(0, Number(e.target.value) || 0))} className="w-12 border border-app-border-medium rounded px-1" aria-label="Left" />
            </label>
            <label className="flex items-center gap-1">
              right
              <input type="number" min={0} max={50} value={right} onChange={(e) => setRight(Math.max(0, Number(e.target.value) || 0))} className="w-12 border border-app-border-medium rounded px-1" aria-label="Right" />
            </label>
          </>
        ) : (
          <label className="flex items-center gap-1">
            n
            <select value={n} onChange={(e) => setN(Number(e.target.value))} className="border border-app-border-medium rounded px-1" aria-label="N">
              {[2, 3, 4, 5].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={spanAware} onChange={(e) => setSpanAware(e.target.checked)} /> span-aware
        </label>
        <label className="flex items-center gap-1">
          min freq
          <input type="number" min={1} value={minFreq} onChange={(e) => setMinFreq(Math.max(1, Number(e.target.value) || 1))} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min freq" />
        </label>
        <button onClick={run} disabled={busy || (mode === 'collocates' && !node.trim())} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
          Compute
        </button>
        <span className="text-app-text-tertiary" data-testid="coll-summary">
          {mode === 'collocates' && coll && `node ${coll.node_freq.toLocaleString()}× · ${coll.rows.length.toLocaleString()} collocates`}
          {mode === 'ngrams' && grams && `${grams.length.toLocaleString()} ${n}-grams`}
        </span>
        <span className="ml-auto">
          {mode === 'collocates' ? (
            <ExportButton name={slug(book, 'collocations', scope.layer, node)} columns={collColumns.map((c) => ({ key: c.key, label: c.label, value: c.sortValue }))} rows={coll?.rows ?? []} />
          ) : (
            <ExportButton name={slug(book, `${n}grams`, scope.layer)} columns={gramColumns.map((c) => ({ key: c.key, label: c.label, value: c.sortValue }))} rows={grams ?? []} />
          )}
        </span>
      </div>
      <ErrorLine error={error} />
      {mode === 'collocates' ? (
        <VirtualTable columns={collColumns} rows={coll?.rows ?? []} rowKey={(r) => r.key} emptyText={coll ? 'No collocates above the minimum.' : 'Enter a node and press Compute.'} testId="coll-table" />
      ) : (
        <VirtualTable columns={gramColumns} rows={grams ?? []} rowKey={(r) => r.gram.join(' ')} emptyText={grams ? 'No n-grams above the minimum.' : 'Press Compute.'} testId="gram-table" />
      )}
    </div>
  );
}
