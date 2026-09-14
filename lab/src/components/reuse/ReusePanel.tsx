import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page, type PageRef } from '../../api/lab';
import {
  DEFAULT_REUSE_PARAMS,
  fmtDuration,
  reuseApi,
  typeRank,
  type BookAggRow,
  type BookRunSummary,
  type Estimate,
  type LayerSpan,
  type MatchRow,
  type MatchType,
  type PassageResult,
  type ReuseParams,
  type ReuseProgress,
  type RunRow,
  type Zone,
} from '../../api/reuse';
import { Reader } from '../Reader';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';

/**
 * The reuse panel (spec §7.5).
 *
 * Left — the reader over the current book with page navigation. Select a
 * range and "Find reuse" (passage mode, both modes); or "Analyse whole book"
 * (book mode, local only) after the time estimate. Stored matches of the
 * shown run draw as a layer on the page.
 *
 * Right — the results: grouped by target book (passage) or a ranked
 * source-book table with per-book match lists (book), each match with its
 * score, type, components, the aligned target text with matching tokens
 * emphasised, a side-by-side aligned view, and confirm/reject. The
 * threshold slider, type filter and banality slider re-score without
 * re-running (`reuse_rescore`).
 */

const TYPES: MatchType[] = ['verbatim', 'inflected', 'paraphrase', 'weak', 'formulaic'];

interface Props {
  book: BookMetadata | null;
  /** Whether the source is the local corpus (book mode needs it). */
  local: boolean;
}

export function ReusePanel({ book, local }: Props) {
  const bookId = book?.id ?? null;

  // ------------------------------------------------------------ reader ---
  const [refs, setRefs] = useState<PageRef[]>([]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);

  useEffect(() => {
    setRefs([]);
    setIndex(0);
    setPage(null);
    setSelection(null);
    setResult(null);
    setBookRun(null);
    setLayer([]);
    if (bookId == null) return;
    let alive = true;
    labApi
      .listPageRefs(bookId)
      .then((r) => {
        if (alive) setRefs(r);
      })
      .catch((e) => setError(String(e)));
    reuseApi
      .runs(bookId)
      .then((r) => {
        if (alive) setRuns(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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

  const onSelectRange = useCallback((r: [number, number] | null) => setSelection(r), []);

  // ------------------------------------------------------------- state ---
  const [params, setParams] = useState<ReuseParams>(DEFAULT_REUSE_PARAMS);
  const [excludeSameBook, setExcludeSameBook] = useState(false);
  const [result, setResult] = useState<PassageResult | null>(null);
  const [bookRun, setBookRun] = useState<BookRunSummary | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [shownRun, setShownRun] = useState<number | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [busy, setBusy] = useState<'passage' | 'estimate' | 'book' | 'rescore' | null>(null);
  const [progress, setProgress] = useState<ReuseProgress | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [layer, setLayer] = useState<LayerSpan[]>([]);

  // Display filters (§7.5): the threshold and banality sliders re-score
  // through Rust; the type filter and "show formulaic" are local.
  const [threshold, setThreshold] = useState(DEFAULT_REUSE_PARAMS.threshold);
  const [banalityScale, setBanalityScale] = useState(DEFAULT_REUSE_PARAMS.banality_scale);
  const [typeFilter, setTypeFilter] = useState<Set<MatchType>>(new Set(['verbatim', 'inflected', 'paraphrase', 'weak']));
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selectedBook, setSelectedBook] = useState<number | null>(null);
  const [targetPages, setTargetPages] = useState<Map<string, Page>>(new Map());

  useEffect(() => {
    let un: (() => void) | undefined;
    reuseApi.onProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  // The reader layer for the shown run on the current page.
  useEffect(() => {
    if (shownRun == null || !page) {
      setLayer([]);
      return;
    }
    let alive = true;
    reuseApi
      .pageLayer(shownRun, page.part_index, page.page_id, threshold)
      .then((l) => {
        if (alive) setLayer(l);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [shownRun, page, threshold, matches]);

  // ---------------------------------------------------------- actions ---
  const findReuse = async () => {
    if (!page || !selection) return;
    setBusy('passage');
    setError(null);
    setMessage(null);
    setProgress(null);
    try {
      const r = await reuseApi.passage({
        book_id: page.book_id,
        part_index: page.part_index,
        page_id: page.page_id,
        tok_start: selection[0],
        tok_end: selection[1],
        params: { ...params, threshold, banality_scale: banalityScale },
        exclude_same_book: excludeSameBook,
      });
      setResult(r);
      setBookRun(null);
      setShownRun(r.run_id);
      setMatches(r.matches);
      setExpanded(null);
      setSelectedBook(null);
      setMessage(
        `${r.anchors.length} anchors · ${r.candidates} candidate pages · ${r.matches.length} matches (${r.matches.filter((m) => m.score >= threshold).length} at threshold) · ${r.non_banal}/${r.tokens} non-banal tokens · ${r.elapsed_ms} ms${r.cancelled ? ' · cancelled' : ''}`
      );
      if (bookId != null) setRuns(await reuseApi.runs(bookId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const askEstimate = async () => {
    if (bookId == null) return;
    setBusy('estimate');
    setError(null);
    setEstimate(null);
    try {
      setEstimate(await reuseApi.estimate(bookId, { ...params, threshold, banality_scale: banalityScale }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const analyseBook = async () => {
    if (bookId == null) return;
    setEstimate(null);
    setBusy('book');
    setError(null);
    setMessage(null);
    setProgress(null);
    try {
      const s = await reuseApi.book(bookId, { ...params, threshold, banality_scale: banalityScale });
      setBookRun(s);
      setResult(null);
      setShownRun(s.run_id);
      setMatches(await reuseApi.matches(s.run_id));
      setExpanded(null);
      setSelectedBook(null);
      setMessage(
        `${s.pages_done}/${s.pages} pages · ${s.windows_done}/${s.windows} windows · ${s.matches} matches · ${s.aggregates.length} source books · ${fmtDuration(s.elapsed_ms)}${s.cancelled ? ' · cancelled, completed pages kept' : ''}`
      );
      setRuns(await reuseApi.runs(bookId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => {
    void labApi.statsCancel();
  };

  const openRun = async (r: RunRow) => {
    setError(null);
    try {
      const m = await reuseApi.matches(r.id);
      setShownRun(r.id);
      setMatches(m);
      setThreshold(r.params.threshold);
      setBanalityScale(r.params.banality_scale);
      setResult(null);
      setBookRun(r.mode === 'book' ? { run_id: r.id, book_id: r.book_id, pages: 0, pages_done: 0, windows: 0, windows_done: 0, matches: m.length, aggregates: aggregate(m, r.params.threshold), elapsed_ms: 0, cancelled: r.status === 'cancelled', params: r.params } : null);
      setExpanded(null);
      setSelectedBook(null);
      setMessage(`Run ${r.id} (${r.mode}, ${r.status}, ${r.started_at.slice(0, 16).replace('T', ' ')}): ${m.length} matches`);
    } catch (e) {
      setError(String(e));
    }
  };

  // Re-score through Rust when the banality slider settles.
  const rescoreTimer = useRef<number | null>(null);
  const onBanality = (v: number) => {
    setBanalityScale(v);
    if (shownRun == null) return;
    if (rescoreTimer.current) window.clearTimeout(rescoreTimer.current);
    rescoreTimer.current = window.setTimeout(async () => {
      setBusy('rescore');
      try {
        const rows = await reuseApi.rescore(shownRun, { ...params, threshold, banality_scale: v });
        setMatches(rows);
        if (bookRun) setBookRun({ ...bookRun, aggregates: aggregate(rows, threshold) });
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    }, 250);
  };

  const verdict = async (m: MatchRow, v: 'confirmed' | 'rejected') => {
    try {
      const next = v === m.user_verdict ? null : v;
      const row = await reuseApi.verdict(m.id, next);
      setMatches((rows) => rows.map((r) => (r.id === row.id ? row : r)));
    } catch (e) {
      setError(String(e));
    }
  };

  const exportRun = async (format: 'csv' | 'json') => {
    if (shownRun == null) return;
    try {
      setMessage(`Exported to ${await reuseApi.export(shownRun, format)}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const targetPage = useCallback(
    async (ref: PageRef): Promise<Page | null> => {
      const key = `${ref.book_id}:${ref.part_index}:${ref.page_id}`;
      const cached = targetPages.get(key);
      if (cached) return cached;
      const p = await labApi.getPage(ref.book_id, ref.part_index, ref.page_id);
      if (p) setTargetPages((m) => new Map(m).set(key, p));
      return p;
    },
    [targetPages]
  );

  // ----------------------------------------------------------- derived ---
  const visible = useMemo(
    () => matches.filter((m) => m.score >= threshold && typeFilter.has(m.kind)).sort((a, b) => b.score - a.score || typeRank(a.kind) - typeRank(b.kind)),
    [matches, threshold, typeFilter]
  );

  const grouped = useMemo(() => {
    const g = new Map<number, MatchRow[]>();
    for (const m of visible) {
      const list = g.get(m.target.book_id) ?? [];
      list.push(m);
      g.set(m.target.book_id, list);
    }
    return [...g.entries()].sort((a, b) => b[1][0].score - a[1][0].score);
  }, [visible]);

  const aggregates = useMemo(() => (bookRun ? aggregate(matches, threshold) : []), [bookRun, matches, threshold]);

  const zoneOf = useMemo(() => {
    const z = result?.zones ?? [];
    return (idx: number): Zone | null => z[idx] ?? null;
  }, [result]);

  const layerClass = useCallback(
    (idx: number) => {
      const classes: string[] = [];
      const span = layer.find((s) => idx >= s.tok_start && idx < s.tok_end);
      if (span) classes.push(span.user_verdict === 'confirmed' ? 'lay-reuse-confirmed' : span.user_verdict === 'rejected' ? 'lay-reuse-rejected' : 'lay-reuse');
      if (result && result.matches.length && page && page.book_id === result.matches[0]?.book_id) {
        const z = zoneOf(idx);
        if (z) classes.push(`lay-zone-${z}`);
      }
      return classes.length ? classes.join(' ') : null;
    },
    [layer, result, page, zoneOf]
  );

  const onTokenClick = useCallback(
    (idx: number) => {
      const span = layer.find((s) => idx >= s.tok_start && idx < s.tok_end);
      if (span) setExpanded(span.id);
    },
    [layer]
  );

  const aggColumns: Column<BookAggRow>[] = [
    { key: 'title', label: 'Source book', sortValue: (r) => r.title ?? String(r.book_id), rtl: true, width: 'minmax(180px, 3fr)', render: (r) => r.title ?? `book ${r.book_id}` },
    { key: 'death', label: 'd. AH', sortValue: (r) => r.death_ah, align: 'right', width: '60px', render: (r) => (r.death_ah == null ? '—' : String(r.death_ah)) },
    { key: 'tokens', label: 'Aligned tokens', sortValue: (r) => r.aligned_tokens, align: 'right', width: '110px', defaultSort: 'desc', render: (r) => fmt(r.aligned_tokens) },
    { key: 'matches', label: 'Matches', sortValue: (r) => r.matches, align: 'right', width: '80px', render: (r) => fmt(r.matches) },
    { key: 'best', label: 'Best', sortValue: (r) => r.best_score, align: 'right', width: '60px', render: (r) => r.best_score.toFixed(2) },
    { key: 'types', label: 'Type mix', sortValue: (r) => Object.keys(r.types).length, width: '2fr', render: (r) => TYPES.filter((t) => r.types[t]).map((t) => `${t} ${r.types[t]}`).join(' · ') },
  ];

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Choose a book in Books first.</div>;
  }

  const selectionText = selection && page ? page.tokens.slice(selection[0], selection[1]).map((t) => t.surface).join(' ') : '';

  return (
    <div className="flex h-full min-h-0">
      {/* ----------------------------------------------- left: the text --- */}
      <section className="flex-1 min-w-0 flex flex-col border-r border-app-border-light">
        <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
          <button onClick={findReuse} disabled={!!busy || !selection} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40" title="Passage mode (§4.3): the selected range against the corpus">
            {busy === 'passage' ? 'Searching…' : 'Find reuse'}
          </button>
          <label className="flex items-center gap-1" title="Leave out the query's own book">
            <input type="checkbox" checked={excludeSameBook} onChange={(e) => setExcludeSameBook(e.target.checked)} />
            exclude this book
          </label>
          <span className="mx-1 text-app-border-medium">|</span>
          <button
            onClick={askEstimate}
            disabled={!!busy || !local}
            className="px-3 py-1 text-sm border border-app-accent text-app-accent rounded disabled:opacity-40"
            title={local ? 'Book mode (§4.3): every 60-token window of the book, after a time estimate' : 'Whole-book reuse needs the local corpus (spec §4.3)'}
          >
            {busy === 'estimate' ? 'Estimating…' : busy === 'book' ? 'Analysing…' : 'Analyse whole book'}
          </button>
          {busy && (
            <button onClick={cancel} className="px-2 py-1 border border-app-border-medium rounded">
              Cancel
            </button>
          )}
          {!local && <span className="text-app-text-tertiary">book mode: local only</span>}
          <label className="flex items-center gap-1 ml-auto" title="Lemma rank at or below which a token is banal (§4.3). Changing it needs a re-run.">
            banality rank
            <input type="number" min={0} max={5000} step={50} value={params.banality_rank} onChange={(e) => setParams({ ...params, banality_rank: Math.max(0, Number(e.target.value) || 0) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Banality rank" />
          </label>
          <label className="flex items-center gap-1" title="Aligned pairs a match needs">
            min aligned
            <input type="number" min={2} max={40} value={params.min_aligned} onChange={(e) => setParams({ ...params, min_aligned: Math.max(2, Number(e.target.value) || 6) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Min aligned" />
          </label>
        </div>

        {progress && busy && (
          <div className="px-3 py-1 text-xs bg-app-surface-variant border-b border-app-border-light" role="status">
            {progress.stage === 'book' ? `page ${progress.done}/${progress.total} · ${progress.found} matches` : progress.stage === 'align' ? `aligning candidate ${progress.done}` : progress.stage}
            {progress.estimate_ms != null && progress.total > 0 && ` · about ${fmtDuration(progress.estimate_ms)}`}
          </div>
        )}

        {estimate && (
          <div className="px-3 py-2 text-xs bg-app-accent-light border-b border-app-border-light flex items-center gap-3 flex-wrap" role="dialog" aria-label="Estimate">
            <span>
              {estimate.windows.toLocaleString()} windows over {estimate.pages.toLocaleString()} pages; {estimate.sampled} sampled in {estimate.sample_ms} ms ({estimate.sample_matches} matches) → about <b>{fmtDuration(estimate.estimate_ms)}</b>.
            </span>
            <button onClick={analyseBook} className="px-3 py-1 bg-app-accent text-white rounded">
              Start
            </button>
            <button onClick={() => setEstimate(null)} className="px-2 py-1 border border-app-border-medium rounded">
              Not now
            </button>
          </div>
        )}

        {selection && page && (
          <div className="px-3 py-1 text-xs border-b border-app-border-light flex items-center gap-2">
            <span className="text-app-text-tertiary">
              selected [{selection[0]}, {selection[1]}) · {selection[1] - selection[0]} tokens
            </span>
            <span className="font-arabic truncate" dir="rtl" title={selectionText}>
              {selectionText.slice(0, 80)}
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0">
          <Reader page={page} pages={refs} index={index} onNavigate={(i) => goTo(i)} onSelectRange={onSelectRange} highlight={highlight} layerClass={layerClass} onTokenClick={onTokenClick} loading={pageLoading} error={null} />
        </div>
      </section>

      {/* ------------------------------------------------ right: results --- */}
      <section className="w-[46%] min-w-[420px] flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-app-border-light bg-app-surface text-xs flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1" title="Display threshold on score (§4.3); no re-run">
            threshold
            <input type="range" min={0} max={1} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Threshold" />
            <span className="w-8 tabular-nums">{threshold.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-1" title="banality_scale (§4.3): how fast the penalty grows with the banal share above the corpus baseline; re-scores stored matches">
            banality
            <input type="range" min={0.05} max={1} step={0.05} value={banalityScale} onChange={(e) => onBanality(Number(e.target.value))} aria-label="Banality scale" />
            <span className="w-8 tabular-nums">{banalityScale.toFixed(2)}</span>
          </label>
          <span className="flex items-center gap-1">
            {TYPES.map((t) => (
              <label key={t} className={`flex items-center gap-0.5 ${t === 'formulaic' ? 'text-app-text-tertiary' : ''}`}>
                <input
                  type="checkbox"
                  checked={typeFilter.has(t)}
                  onChange={(e) => {
                    const s = new Set(typeFilter);
                    if (e.target.checked) s.add(t);
                    else s.delete(t);
                    setTypeFilter(s);
                  }}
                  aria-label={`Show ${t}`}
                />
                {t}
              </label>
            ))}
          </span>
          {shownRun != null && (
            <span className="ml-auto flex items-center gap-1">
              <button onClick={() => exportRun('csv')} className="px-2 py-0.5 border border-app-border-medium rounded">
                CSV
              </button>
              <button onClick={() => exportRun('json')} className="px-2 py-0.5 border border-app-border-medium rounded">
                JSON
              </button>
            </span>
          )}
        </div>

        {(error || message) && (
          <div className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`} role={error ? 'alert' : 'status'}>
            {error ?? message}
          </div>
        )}

        {runs.length > 0 && (
          <div className="px-3 py-1 text-xs border-b border-app-border-light flex items-center gap-2">
            <span className="text-app-text-tertiary">runs:</span>
            <select value={shownRun ?? ''} onChange={(e) => { const r = runs.find((x) => x.id === Number(e.target.value)); if (r) void openRun(r); }} className="border border-app-border-medium rounded px-1" aria-label="Stored runs">
              <option value="">—</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} {r.mode} {r.status} · {r.matches} · {r.started_at.slice(0, 16).replace('T', ' ')}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {result && (
            <div className="px-3 py-2 text-xs border-b border-app-border-light">
              <div className="text-app-text-tertiary mb-1">
                anchors ({result.anchors.length}):{' '}
                {result.anchors.map((a) => (
                  <span key={a.start} className="font-arabic mx-1" dir="rtl" title={`rank sum ${a.rank_sum}`}>
                    {a.terms.join(' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {bookRun && (
            <div className="border-b border-app-border-light">
              <div className="px-3 py-1 text-xs text-app-text-tertiary">Source books ranked by aligned tokens at the threshold; click one for its matches.</div>
              <VirtualTable columns={aggColumns} rows={aggregates} rowKey={(r) => r.book_id} onRowClick={(r) => setSelectedBook(r.book_id === selectedBook ? null : r.book_id)} height={220} emptyText="No source books at this threshold." testId="reuse-aggregates" />
            </div>
          )}

          {visible.length === 0 && shownRun != null && <div className="p-4 text-sm text-app-text-tertiary">No matches at this threshold.</div>}
          {shownRun == null && !busy && <div className="p-4 text-sm text-app-text-tertiary">Select a passage in the reader and press "Find reuse", or analyse the whole book.</div>}

          {grouped
            .filter(([b]) => selectedBook == null || b === selectedBook)
            .map(([b, list]) => (
              <div key={b} className="border-b border-app-border-light">
                <div className="px-3 py-1 text-xs bg-app-surface-variant flex items-center gap-2">
                  <span className="font-arabic font-medium" dir="rtl">
                    {list[0].target_title ?? `book ${b}`}
                  </span>
                  <span className="text-app-text-tertiary">
                    {list[0].target_death_ah != null && `d. ${list[0].target_death_ah} · `}
                    {list.length} match{list.length === 1 ? '' : 'es'}
                  </span>
                </div>
                {list.map((m) => (
                  <MatchCard key={m.id} m={m} expanded={expanded === m.id} onToggle={() => setExpanded(expanded === m.id ? null : m.id)} onVerdict={verdict} targetPage={targetPage} queryPage={page && page.part_index === m.part_index && page.page_id === m.page_id ? page : null} onShowQuery={() => { const i = refs.findIndex((r) => r.part_index === m.part_index && r.page_id === m.page_id); if (i >= 0) void goTo(i, [m.tok_start, m.tok_end]); }} />
                ))}
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}

/** Per-book aggregate for a stored run, mirroring `reuse::aggregate`. */
function aggregate(rows: MatchRow[], threshold: number): BookAggRow[] {
  const by = new Map<number, BookAggRow>();
  for (const m of rows) {
    if (m.score < threshold) continue;
    const a = by.get(m.target.book_id) ?? { book_id: m.target.book_id, matches: 0, aligned_tokens: 0, best_score: 0, types: {}, title: m.target_title, author_id: m.target_author, death_ah: m.target_death_ah };
    a.matches += 1;
    a.aligned_tokens += m.components.aligned;
    a.best_score = Math.max(a.best_score, m.score);
    a.types[m.kind] = (a.types[m.kind] ?? 0) + 1;
    by.set(m.target.book_id, a);
  }
  return [...by.values()].sort((x, y) => y.aligned_tokens - x.aligned_tokens || y.matches - x.matches);
}

function MatchCard({
  m,
  expanded,
  onToggle,
  onVerdict,
  targetPage,
  queryPage,
  onShowQuery,
}: {
  m: MatchRow;
  expanded: boolean;
  onToggle: () => void;
  onVerdict: (m: MatchRow, v: 'confirmed' | 'rejected') => void;
  targetPage: (ref: PageRef) => Promise<Page | null>;
  queryPage: Page | null;
  onShowQuery: () => void;
}) {
  const [target, setTarget] = useState<Page | null>(null);
  const [query, setQuery] = useState<Page | null>(queryPage);
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    targetPage(m.target).then((p) => alive && setTarget(p)).catch(() => {});
    if (!queryPage) targetPage({ book_id: m.book_id, part_index: m.part_index, page_id: m.page_id }).then((p) => alive && setQuery(p)).catch(() => {});
    else setQuery(queryPage);
    return () => {
      alive = false;
    };
  }, [expanded, m, targetPage, queryPage]);

  const c = m.components;
  const qPair = new Map<number, number>();
  const tPair = new Map<number, number>();
  m.pairs.forEach(([q, t], i) => {
    qPair.set(q, i);
    tPair.set(t, i);
  });
  const qSurface = (i: number) => query?.tokens[i]?.surface ?? '';

  return (
    <div className={`px-3 py-2 border-t border-app-border-light text-xs ${m.user_verdict === 'rejected' ? 'opacity-60' : ''}`} data-testid={`match-${m.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={onToggle} className="font-mono text-app-accent" aria-expanded={expanded}>
          {expanded ? '▾' : '▸'}
        </button>
        <span className="font-semibold tabular-nums">{m.score.toFixed(3)}</span>
        <span className={`px-1 rounded type-${m.kind}`}>{m.kind}</span>
        {m.zone && <span className="px-1 rounded bg-app-surface-variant" title="Zone of the query span (§4.3)">{m.zone}</span>}
        <span className="text-app-text-tertiary" title="coverage · lemma · root · surface · banal share → factor · aligned pairs">
          cov {c.coverage.toFixed(2)} · lem {c.lemma_agree.toFixed(2)} · root {c.root_agree.toFixed(2)} · surf {c.surface_agree.toFixed(2)} · banal {c.banal_share.toFixed(2)}→{c.banality_factor.toFixed(2)} · {c.aligned} pairs
        </span>
        <span className="text-app-text-tertiary">
          {m.target.part_index}:{m.target.page_id} [{m.t_start}–{m.t_end})
        </span>
        <button onClick={onShowQuery} className="text-app-accent underline" title="Show the query span in the reader">
          {m.part_index}:{m.page_id} [{m.tok_start}–{m.tok_end})
        </button>
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => onVerdict(m, 'confirmed')} className={`px-2 py-0.5 rounded border ${m.user_verdict === 'confirmed' ? 'bg-green-600 text-white border-green-600' : 'border-app-border-medium'}`} aria-label={`Confirm match ${m.id}`}>
            ✓
          </button>
          <button onClick={() => onVerdict(m, 'rejected')} className={`px-2 py-0.5 rounded border ${m.user_verdict === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'border-app-border-medium'}`} aria-label={`Reject match ${m.id}`}>
            ✗
          </button>
        </span>
      </div>
      <div className="font-arabic mt-1 leading-7" dir="rtl">
        {target ? (
          target.tokens.slice(m.t_start, m.t_end).map((t, k) => {
            const i = m.t_start + k;
            const pi = tPair.get(i);
            const q = pi != null ? m.pairs[pi][0] : null;
            const same = q != null && query && normalizeArabic(qSurface(q)) === normalizeArabic(t.surface);
            return (
              <span key={i} className={pi != null ? (same ? 'tok-aligned-same' : 'tok-aligned') : 'text-app-text-tertiary'}>
                {t.surface}{' '}
              </span>
            );
          })
        ) : (
          <span className="text-app-text-tertiary">{expanded ? 'loading…' : m.snapshot.slice(0, 120)}</span>
        )}
      </div>
      {expanded && query && target && (
        <div className="grid grid-cols-2 gap-3 mt-2 font-arabic leading-7 border-t border-app-border-light pt-2" dir="rtl" data-testid="side-by-side">
          <div>
            <div className="text-[10px] text-app-text-tertiary mb-1" dir="ltr">
              query
            </div>
            {query.tokens.slice(m.tok_start, m.tok_end).map((t, k) => {
              const i = m.tok_start + k;
              const pi = qPair.get(i);
              return (
                <span key={i} className={pi != null ? `lay-pair-${pi % 8}` : 'text-app-text-tertiary'}>
                  {t.surface}{' '}
                </span>
              );
            })}
          </div>
          <div>
            <div className="text-[10px] text-app-text-tertiary mb-1" dir="ltr">
              target
            </div>
            {target.tokens.slice(m.t_start, m.t_end).map((t, k) => {
              const i = m.t_start + k;
              const pi = tPair.get(i);
              return (
                <span key={i} className={pi != null ? `lay-pair-${pi % 8}` : 'text-app-text-tertiary'}>
                  {t.surface}{' '}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Enough of `normalize_arabic` for "same surface" emphasis: alef forms,
 *  tāʾ marbūṭa, alef maqṣūra, tashkil. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}
