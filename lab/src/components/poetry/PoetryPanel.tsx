import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page, type PageRef } from '../../api/lab';
import { pageLabel } from '../../api/isnad';
import { meterLabel, poetryApi, type PoetryProgress, type PoetryScan, type VerseRow } from '../../api/phase4';
import { Reader } from '../Reader';
import { VirtualTable, type Column } from '../stats/VirtualTable';

/**
 * Poetry extraction (spec §4.6), labelled experimental: scan the current
 * book for verses (hemistich markers or two near-equal segments split by
 * wide whitespace), list them with their meter — from ʿarūḍ scansion of the
 * vowelled surface, `unknown` where the text is not vowelled or scans as
 * nothing, never a guess — first hemistich and page; the current page's
 * verses as a reader layer; CSV export.
 */

interface Props {
  book: BookMetadata | null;
}

export function PoetryPanel({ book }: Props) {
  const bookId = book?.id ?? null;
  const [scan, setScan] = useState<PoetryScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PoetryProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'metered' | 'unknown'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const [refs, setRefs] = useState<PageRef[]>([]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    poetryApi.onProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  useEffect(() => {
    setScan(null);
    setRefs([]);
    setPage(null);
    setIndex(0);
    setSelected(null);
    if (bookId == null) return;
    labApi.listPageRefs(bookId).then(setRefs).catch((e) => setError(String(e)));
  }, [bookId]);

  const goTo = useCallback(
    async (i: number, mark?: [number, number]) => {
      const r = refs[i];
      if (!r) return;
      setIndex(i);
      setPageLoading(true);
      setHighlight(mark ?? null);
      try {
        setPage(await labApi.getPage(r.book_id, r.part_index, r.page_id));
      } catch (e) {
        setError(String(e));
      } finally {
        setPageLoading(false);
      }
    },
    [refs]
  );

  useEffect(() => {
    if (refs.length && !page) void goTo(0);
  }, [refs, page, goTo]);

  const run = async () => {
    if (bookId == null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setProgress(null);
    try {
      const s = await poetryApi.scan(bookId);
      setScan(s);
      setMessage(`${s.pages_done}/${s.pages} pages · ${s.verses.length} verses · ${s.vowelled} vowelled · ${s.with_meter} with a meter · ${s.elapsed_ms} ms${s.cancelled ? ' · cancelled' : ''}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportRows = async () => {
    if (bookId == null || !scan) return;
    try {
      setMessage(`Exported to ${await poetryApi.export(bookId, scan.verses)}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const keyOf = (v: VerseRow) => `${v.part_index}:${v.page_id}:${v.line}`;
  const shown = useMemo(() => {
    const all = scan?.verses ?? [];
    return all.filter((v) => (filter === 'metered' ? v.meters.length > 0 : filter === 'unknown' ? v.meters.length === 0 : true));
  }, [scan, filter]);

  const pageRows = useMemo(() => (page && scan ? scan.verses.filter((v) => v.part_index === page.part_index && v.page_id === page.page_id) : []), [scan, page]);

  const layerClass = useCallback(
    (idx: number) => {
      const v = pageRows.find((x) => idx >= x.tok_start && idx < x.tok_end);
      if (!v) return null;
      const inH1 = idx >= v.h1[0] && idx < v.h1[1];
      const base = inH1 ? 'lay-verse-h1' : 'lay-verse-h2';
      return keyOf(v) === selected ? `${base} lay-t-selected` : base;
    },
    [pageRows, selected]
  );

  const show = (v: VerseRow) => {
    setSelected(keyOf(v));
    const i = refs.findIndex((x) => x.part_index === v.part_index && x.page_id === v.page_id);
    if (i >= 0) void goTo(i, [v.tok_start, v.tok_end]);
  };

  const columns: Column<VerseRow>[] = [
    { key: 'meter', label: 'Meter', sortValue: (r) => meterLabel(r), rtl: true, width: '150px', render: (r) => <span className={r.meters.length === 0 ? 'text-app-text-tertiary' : ''} title={r.pattern || (r.vowelled < 0.6 ? 'not vowelled enough to scan' : 'scans as no meter')}>{meterLabel(r)}</span> },
    { key: 'h1', label: 'First hemistich', sortValue: (r) => r.h1_text, rtl: true, width: 'minmax(220px, 4fr)', render: (r) => r.h1_text },
    { key: 'h2', label: 'Second', sortValue: (r) => r.h2_text, rtl: true, width: 'minmax(180px, 3fr)', render: (r) => <span className="text-app-text-secondary">{r.h2_text}</span> },
    { key: 'page', label: 'Page', sortValue: (r) => r.part_index * 1_000_000 + r.page_id, width: '70px', defaultSort: 'asc', render: (r) => pageLabel(r.part_index, r.page_id, book?.parts) },
    { key: 'marker', label: 'Split by', sortValue: (r) => r.marker, width: '80px', render: (r) => r.marker },
    { key: 'vow', label: 'Vowelled', sortValue: (r) => r.vowelled, align: 'right', width: '80px', render: (r) => `${Math.round(r.vowelled * 100)}%` },
  ];

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Choose a book in Books first.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
        <span className="px-1.5 py-0.5 rounded bg-app-surface-variant text-app-text-secondary" title="Spec §4.6: candidate verses and ʿarūḍ meter detection are experimental">
          experimental
        </span>
        <button onClick={run} disabled={busy} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
          {busy ? 'Scanning…' : 'Find verses'}
        </button>
        {busy && (
          <button onClick={() => void labApi.statsCancel()} className="px-2 py-1 border border-app-border-medium rounded">
            Cancel
          </button>
        )}
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="border border-app-border-medium rounded px-1" aria-label="Filter">
          <option value="all">all</option>
          <option value="metered">with a meter</option>
          <option value="unknown">meter unknown</option>
        </select>
        {scan && (
          <span className="text-app-text-tertiary">
            {shown.length}/{scan.verses.length} verses
          </span>
        )}
        {scan && scan.verses.length > 0 && (
          <button onClick={exportRows} className="ml-auto px-2 py-0.5 border border-app-border-medium rounded">
            CSV
          </button>
        )}
      </div>
      {progress && busy && (
        <div className="px-3 py-1 text-xs bg-app-surface-variant border-b border-app-border-light" role="status">
          page {progress.done}/{progress.total} · {progress.found} verses
        </div>
      )}
      {(error || message) && (
        <div className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`} role={error ? 'alert' : 'status'}>
          {error ?? message}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <section className="flex-1 min-w-0 border-r border-app-border-light">
          <Reader page={page} pages={refs} index={index} onNavigate={(i) => goTo(i)} highlight={highlight} layerClass={layerClass} onClearSelection={() => setSelected(null)} loading={pageLoading} error={null} />
        </section>
        <section className="w-[52%] min-w-[460px] min-h-0 flex flex-col p-2">
          <VirtualTable columns={columns} rows={shown} rowKey={keyOf} onRowClick={show} height="fill" emptyText={scan ? 'No verses found.' : 'Press "Find verses" to scan the book.'} testId="poetry-table" />
        </section>
      </div>
    </div>
  );
}
