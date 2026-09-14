import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page, type PageRef } from '../../api/lab';
import { DEFAULT_QURAN_PARAMS, fmtDuration, quranApi, type QuranMatchRow, type QuranParams, type QuranProgress, type QuranRunSummary, type QuranStatus } from '../../api/reuse';
import { Reader } from '../Reader';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';

/**
 * The Qurʾān panel (spec §7.6): "Detect quotations" over the current book
 * with progress and cancel; the results as a table by sūra:āya with the
 * page, the matched text, the āya text, agreement and cue; the current
 * page's quotations as a reader layer; confirm/reject per row; export.
 */

interface Props {
  book: BookMetadata | null;
}

export function QuranPanel({ book }: Props) {
  const bookId = book?.id ?? null;
  const [status, setStatus] = useState<QuranStatus | null>(null);
  const [params, setParams] = useState<QuranParams>(DEFAULT_QURAN_PARAMS);
  const [rows, setRows] = useState<QuranMatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<QuranProgress | null>(null);
  const [summary, setSummary] = useState<QuranRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'cued' | 'uncued' | 'confirmed' | 'open'>('all');
  const [selected, setSelected] = useState<number | null>(null);

  const [refs, setRefs] = useState<PageRef[]>([]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);

  useEffect(() => {
    quranApi.status().then(setStatus).catch((e) => setError(String(e)));
    let un: (() => void) | undefined;
    quranApi.onProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  const reload = useCallback(async () => {
    if (bookId == null) return;
    try {
      setRows(await quranApi.list(bookId));
    } catch (e) {
      setError(String(e));
    }
  }, [bookId]);

  useEffect(() => {
    setRows([]);
    setSummary(null);
    setSelected(null);
    setRefs([]);
    setPage(null);
    setIndex(0);
    if (bookId == null) return;
    void reload();
    labApi.listPageRefs(bookId).then(setRefs).catch((e) => setError(String(e)));
  }, [bookId, reload]);

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
      const s = await quranApi.run(bookId, params);
      setSummary(s);
      setMessage(`${s.pages_done}/${s.pages} pages · ${s.hits} quotations found · ${s.kept_judged} judged rows kept · ${fmtDuration(s.elapsed_ms)}${s.cancelled ? ' · cancelled, completed pages kept' : ''}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const verdict = async (r: QuranMatchRow, v: 'confirmed' | 'rejected') => {
    try {
      const row = await quranApi.verdict(r.id, v === r.user_verdict ? null : v);
      setRows((rs) => rs.map((x) => (x.id === row.id ? row : x)));
    } catch (e) {
      setError(String(e));
    }
  };

  const exportRows = async (format: 'csv' | 'json') => {
    if (bookId == null) return;
    try {
      setMessage(`Exported to ${await quranApi.export(bookId, format)}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const shown = useMemo(
    () =>
      rows.filter((r) => {
        switch (filter) {
          case 'cued':
            return r.cue != null;
          case 'uncued':
            return r.cue == null;
          case 'confirmed':
            return r.user_verdict === 'confirmed';
          case 'open':
            return r.user_verdict == null;
          default:
            return true;
        }
      }),
    [rows, filter]
  );

  const pageRows = useMemo(() => (page ? rows.filter((r) => r.part_index === page.part_index && r.page_id === page.page_id) : []), [rows, page]);

  const layerClass = useCallback(
    (idx: number) => {
      const r = pageRows.find((x) => idx >= x.tok_start && idx < x.tok_end);
      if (!r) return null;
      const base = r.user_verdict === 'confirmed' ? 'lay-quran-confirmed' : r.user_verdict === 'rejected' ? 'lay-quran-rejected' : 'lay-quran';
      return r.id === selected ? `${base} lay-t-selected` : base;
    },
    [pageRows, selected]
  );

  const onTokenClick = useCallback(
    (idx: number) => {
      const r = pageRows.find((x) => idx >= x.tok_start && idx < x.tok_end);
      if (r) setSelected(r.id);
    },
    [pageRows]
  );

  const show = (r: QuranMatchRow) => {
    setSelected(r.id);
    const i = refs.findIndex((x) => x.part_index === r.part_index && x.page_id === r.page_id);
    if (i >= 0) void goTo(i, [r.tok_start, r.tok_end]);
  };

  const columns: Column<QuranMatchRow>[] = [
    { key: 'ref', label: 'Sūra:āya', sortValue: (r) => r.sura * 1000 + r.aya_start, width: '120px', defaultSort: 'asc', render: (r) => <span className={r.id === selected ? 'font-semibold' : ''}>{r.sura}:{r.aya_start}{r.aya_end !== r.aya_start ? `–${r.aya_end}` : ''} <span className="font-arabic">{r.sura_name}</span></span> },
    { key: 'page', label: 'Page', sortValue: (r) => r.part_index * 1_000_000 + r.page_id, width: '70px', render: (r) => `${r.part_index}:${r.page_id}` },
    { key: 'text', label: 'Text', sortValue: (r) => r.snapshot, rtl: true, width: 'minmax(200px, 3fr)', render: (r) => r.snapshot },
    { key: 'aya', label: 'Āya', sortValue: (r) => r.aya_text, rtl: true, width: 'minmax(200px, 3fr)', render: (r) => <span className="text-app-text-secondary">{r.aya_text}</span> },
    { key: 'n', label: 'Tokens', sortValue: (r) => r.aligned, align: 'right', width: '60px', render: (r) => fmt(r.aligned) },
    { key: 'lemma', label: 'Lemma', sortValue: (r) => r.lemma_agree, align: 'right', width: '60px', render: (r) => r.lemma_agree.toFixed(2) },
    { key: 'surface', label: 'Surface', sortValue: (r) => r.surface_agree, align: 'right', width: '64px', render: (r) => <span title={r.surface_agree >= 0.9 ? 'verbatim' : 'paraphrased or inflected'}>{r.surface_agree.toFixed(2)}</span> },
    { key: 'cue', label: 'Cue', sortValue: (r) => r.cue ?? '', width: '80px', render: (r) => r.cue ?? '—' },
    {
      key: 'verdict',
      label: '',
      sortValue: (r) => r.user_verdict ?? '',
      width: '70px',
      render: (r) => (
        <span className="flex gap-1">
          <button onClick={(e) => { e.stopPropagation(); void verdict(r, 'confirmed'); }} className={`px-1 rounded border ${r.user_verdict === 'confirmed' ? 'bg-green-600 text-white border-green-600' : 'border-app-border-medium'}`} aria-label={`Confirm quotation ${r.id}`}>
            ✓
          </button>
          <button onClick={(e) => { e.stopPropagation(); void verdict(r, 'rejected'); }} className={`px-1 rounded border ${r.user_verdict === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'border-app-border-medium'}`} aria-label={`Reject quotation ${r.id}`}>
            ✗
          </button>
        </span>
      ),
    },
  ];

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Choose a book in Books first.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
        <button onClick={run} disabled={busy || !status?.available} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40" title="Whole-book run (§4.4)">
          {busy ? 'Detecting…' : 'Detect quotations'}
        </button>
        {busy && (
          <button onClick={() => void labApi.statsCancel()} className="px-2 py-1 border border-app-border-medium rounded">
            Cancel
          </button>
        )}
        <label className="flex items-center gap-1" title="Aligned tokens a quotation needs without a cue">
          min tokens
          <input type="number" min={2} max={12} value={params.min_tokens} onChange={(e) => setParams({ ...params, min_tokens: Math.max(2, Number(e.target.value) || 4) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Min tokens" />
        </label>
        <label className="flex items-center gap-1" title="With a ﴿ ﴾, «» or قال تعالى cue within 3 tokens">
          cued min
          <input type="number" min={2} max={12} value={params.cued_min_tokens} onChange={(e) => setParams({ ...params, cued_min_tokens: Math.max(2, Number(e.target.value) || 3) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Cued min tokens" />
        </label>
        <label className="flex items-center gap-1" title="Lemma agreement a quotation needs">
          lemma ≥
          <input type="number" min={0.5} max={1} step={0.05} value={params.min_lemma_agree} onChange={(e) => setParams({ ...params, min_lemma_agree: Math.min(1, Math.max(0.5, Number(e.target.value) || 0.8)) })} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min lemma agreement" />
        </label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="border border-app-border-medium rounded px-1" aria-label="Filter">
          <option value="all">all</option>
          <option value="cued">cued</option>
          <option value="uncued">uncued</option>
          <option value="confirmed">confirmed</option>
          <option value="open">open</option>
        </select>
        <span className="text-app-text-tertiary">
          {shown.length}/{rows.length} rows
        </span>
        {rows.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={() => exportRows('csv')} className="px-2 py-0.5 border border-app-border-medium rounded">
              CSV
            </button>
            <button onClick={() => exportRows('json')} className="px-2 py-0.5 border border-app-border-medium rounded">
              JSON
            </button>
          </span>
        )}
        {status && (
          <span className="text-app-text-tertiary" title={status.error ?? `${status.tokens.toLocaleString()} tokens, ${status.ayas} āyāt, ${status.trigrams.toLocaleString()} trigrams; ingest v${status.ingest_version}, detector ${status.detector_version}`}>
            {status.available ? `Qurʾān ${status.tokens.toLocaleString()} tokens · detector ${status.detector_version}` : `Qurʾān unavailable: ${status.error}`}
          </span>
        )}
      </div>

      {progress && busy && (
        <div className="px-3 py-1 text-xs bg-app-surface-variant border-b border-app-border-light" role="status">
          page {progress.done}/{progress.total} · {progress.found} quotations{progress.estimate_ms != null && ` · about ${fmtDuration(progress.estimate_ms)}`}
        </div>
      )}
      {(error || message) && (
        <div className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`} role={error ? 'alert' : 'status'}>
          {error ?? message}
        </div>
      )}
      {summary && !message && null}

      <div className="flex-1 min-h-0 flex">
        <section className="flex-1 min-w-0 border-r border-app-border-light">
          <Reader page={page} pages={refs} index={index} onNavigate={(i) => goTo(i)} highlight={highlight} layerClass={layerClass} onTokenClick={onTokenClick} loading={pageLoading} error={null} />
        </section>
        <section className="w-[52%] min-w-[460px] min-h-0 flex flex-col">
          <VirtualTable columns={columns} rows={shown} rowKey={(r) => r.id} onRowClick={show} height={9999} emptyText={rows.length ? 'Nothing matches the filter.' : 'No quotations yet — press "Detect quotations".'} testId="quran-table" />
        </section>
      </div>
    </div>
  );
}
