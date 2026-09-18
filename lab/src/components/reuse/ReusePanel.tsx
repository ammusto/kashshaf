import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BookMetadata, Token } from '@kashshaf/shared';
import { labApi, type Page, type PageSpan } from '../../api/lab';
import { plainPageLabel, type At } from '../../api/pages';
import type { PageRef } from '../../api/lab';
import { tocApi, type TocRow } from '../../api/workspace';
import {
  DEFAULT_REUSE_PARAMS,
  fmtDuration,
  reuseApi,
  typeRank,
  type BookAggRow,
  type BookRunSummary,
  type Estimate,
  type MatchRow,
  type MatchType,
  type ReuseParams,
  type ReuseProgress,
  type RunRow,
} from '../../api/reuse';
import { ReadPanel } from '../read/ReadPanel';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';
import { HeavyRunModal, IDLE_RUN, LoadingOverlay, Notice, RunBar, isHeavy, type RunState } from '../ui/Running';
import { useHeavyLimits } from '../../api/settings';
import { BookPicker } from '../ui/BookPicker';

/**
 * The reuse panel (spec §7.5, restructured by 1.5 §H).
 *
 * Left is the Read panel itself (§H1) — the whole reader, its navigation, its
 * contents and its selection — so finding reuse is something you do while
 * reading rather than in a second, lesser reader.
 *
 * Right is the answer to one question: who else has this passage. Three
 * columns, read right to left: which book, the words themselves in their
 * context, and the page. The parameters that shape the run live behind the
 * gear, out of the way of the result.
 *
 * Clicking a row opens the other book in a second reader of the same kind,
 * in place of the table (8 D). Two texts, side by side, each scrolling on
 * its own: the passage you asked about in green on the left, the passage
 * someone else has in red on the right. Those two colours mean the same
 * thing everywhere in the panel.
 */

const TYPES: MatchType[] = ['verbatim', 'inflected', 'paraphrase', 'weak', 'formulaic'];
const CONTEXT = 5;
/** Target pages fetched for context; beyond this the phrase shows alone. */
const CONTEXT_BUDGET = 120;

interface Props {
  book: BookMetadata | null;
  /** Whether the source is the local corpus (book mode needs it). */
  local: boolean;
  /** The page to open at, from "Find reuse on this page" (7 B). */
  from?: At | null;
  /** Something was confirmed or rejected: the workspace folder is behind. */
  onChanged?: () => void;
}

export function ReusePanel({ book, local, from, onChanged }: Props) {
  const bookId = book?.id ?? null;

  const [params, setParams] = useState<ReuseParams>(DEFAULT_REUSE_PARAMS);
  const [excludeSameBook, setExcludeSameBook] = useState(false);
  const [bookRun, setBookRun] = useState<BookRunSummary | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [shownRun, setShownRun] = useState<number | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [busy, setBusy] = useState<'passage' | 'estimate' | 'book' | 'rescore' | null>(null);
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const [progress, setProgress] = useState<ReuseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [threshold, setThreshold] = useState(DEFAULT_REUSE_PARAMS.threshold);
  const [banalityScale, setBanalityScale] = useState(DEFAULT_REUSE_PARAMS.banality_scale);
  const [typeFilter, setTypeFilter] = useState<Set<MatchType>>(new Set(['verbatim', 'inflected', 'paraphrase', 'weak']));
  // Rows under the mode's view cutoff are behind a toggle, not gone: the
  // same mechanism as the formulaic type.
  const [showLow, setShowLow] = useState(false);
  const [showProbable, setShowProbable] = useState(false);
  const [messageDetail, setMessageDetail] = useState<string | null>(null);
  // A passage found in many texts reads as a transmission history when
  // the list is in order of the authors' deaths.
  const [sortBy, setSortBy] = useState<'score' | 'death'>('score');
  const [gear, setGear] = useState(false);

  const [section, setSection] = useState<TocRow | null>(null);
  const [pending, setPending] = useState<{ what: string; span: PageSpan | null; pages: number; tokens: number; estimateMs: number | null } | null>(null);

  /** What the reader has selected, for "Find in selection" (7 C1). */
  const [selection, setSelection] = useState<{ at: At; range: [number, number]; text: string } | null>(null);
  /** Where the left reader sits, and the span it marks green (8 D). */
  const [queryAt, setQueryAt] = useState<At | null>(from ?? null);
  const [querySpan, setQuerySpan] = useState<[number, number] | null>(null);
  /** The row whose text is open in the right reader (7 C3, 8 D). */
  const [open, setOpen] = useState<MatchRow | null>(null);
  /** The right reader's page, by the C1 rule, for its header. */
  const [targetLabel, setTargetLabel] = useState('');
  const [openPages, setOpenPages] = useState<Page[]>([]);
  /** The query span's pages, when it runs over a break. */
  const [querySpanPages, setQuerySpanPages] = useState<Page[]>([]);
  const [sideBySide, setSideBySide] = useState(false);
  const [queryPages, setQueryPages] = useState<Map<string, Page>>(new Map());
  const [contexts, setContexts] = useState<Map<number, Context>>(new Map());
  const [contextBusy, setContextBusy] = useState(false);

  const { limits } = useHeavyLimits();

  useEffect(() => {
    let un: (() => void) | undefined;
    reuseApi.onProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  // "Find reuse on this page" moves the left reader; nothing else does.
  useEffect(() => {
    if (from) setQueryAt(from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.part_index, from?.page_id]);

  useEffect(() => {
    setBookRun(null);
    setMatches([]);
    setShownRun(null);
    setOpen(null);
    setContexts(new Map());
    if (bookId == null) return;
    reuseApi.runs(bookId).then(setRuns).catch(() => setRuns([]));
  }, [bookId]);

  // ---------------------------------------------------------- the runs ---

  const findReuse = useCallback(
    async (at: At, range: [number, number]) => {
      if (bookId == null) return;
      setBusy('passage');
      setQueryAt(at);
      setQuerySpan(range);
      setRun({ running: true, paused: false, cancelledAt: null });
      setError(null);
      setMessage(null);
      setProgress(null);
      setOpen(null);
      try {
        const r = await reuseApi.passage({
          book_id: bookId,
          part_index: at.part_index,
          page_id: at.page_id,
          tok_start: range[0],
          tok_end: range[1],
          params: { ...params, threshold, banality_scale: banalityScale },
          exclude_same_book: excludeSameBook,
        });
        setBookRun(null);
        setShownRun(r.run_id);
        setMatches(r.matches);
        // The reader's terms: phrases that reached a page, and matches. The
        // candidate count is implementation detail, kept in the tooltip.
        const phrases = (r.phrase?.reaching ?? 0) + r.anchors.length;
        setMessage(`${r.matches.length} matches · ${phrases} distinctive ${phrases === 1 ? 'phrase' : 'phrases'} · ${r.elapsed_ms} ms`);
        setMessageDetail(`${r.candidates.toLocaleString()} candidate pages read · ${r.non_banal}/${r.tokens} non-banal words`);
        setRuns(await reuseApi.runs(bookId));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
        setRun(IDLE_RUN);
      }
    },
    [bookId, params, threshold, banalityScale, excludeSameBook]
  );

  /** Ask first when the run is heavy (spec §F4), then start it. */
  const proposeRun = useCallback(
    async (what: string, span: PageSpan | null) => {
      if (bookId == null) return;
      setError(null);
      setBusy('estimate');
      try {
        const [size, est] = await Promise.all([
          labApi.runSize(bookId, span),
          reuseApi.estimate(bookId, { ...params, threshold, banality_scale: banalityScale }, span).catch(() => null as Estimate | null),
        ]);
        const p = { what, span, pages: size.pages, tokens: size.tokens, estimateMs: est?.estimate_ms ?? null };
        if (isHeavy(size, limits)) setPending(p);
        else void startBook(span, what);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookId, params, threshold, banalityScale, limits]
  );

  /** The section the reader is in, as a page span (spec §H3). */
  const analyseSection = useCallback(async () => {
    if (!section || bookId == null) return;
    const range = await tocApi.sectionRange(bookId, section.id).catch(() => null);
    if (!range) {
      setError('That heading has no range in the table of contents.');
      return;
    }
    await proposeRun(`Analysing ${section.title}`, { start: range.start, end: range.end });
  }, [section, bookId, proposeRun]);

  const startBook = useCallback(
    async (span: PageSpan | null, what: string) => {
      if (bookId == null) return;
      setPending(null);
      setBusy('book');
      setRun({ running: true, paused: false, cancelledAt: null });
      setError(null);
      setMessage(null);
      setProgress(null);
      setOpen(null);
      try {
        const s = await reuseApi.book(bookId, { ...params, threshold, banality_scale: banalityScale }, span);
        setBookRun(s);
        setShownRun(s.run_id);
        setMatches(await reuseApi.matches(s.run_id));
        setMessage(
          `${what}: ${s.matches.toLocaleString()} matches over ${s.pages_done.toLocaleString()} pages from ${s.aggregates.length} books · ${fmtDuration(s.elapsed_ms)}`
        );
        setRun(s.cancelled ? { running: false, paused: false, cancelledAt: `${s.pages_done.toLocaleString()} of ${s.pages.toLocaleString()} pages, ${s.matches.toLocaleString()} matches kept` } : IDLE_RUN);
        setRuns(await reuseApi.runs(bookId));
      } catch (e) {
        setError(String(e));
        setRun(IDLE_RUN);
      } finally {
        setBusy(null);
      }
    },
    [bookId, params, threshold, banalityScale]
  );

  const pause = (paused: boolean) => {
    setRun((r) => ({ ...r, paused }));
    void labApi.statsPause(paused);
  };
  const cancel = () => void labApi.statsCancel();

  const openRun = async (r: RunRow) => {
    setError(null);
    try {
      const m = await reuseApi.matches(r.id);
      setShownRun(r.id);
      setMatches(m);
      setThreshold(r.params.threshold);
      setBanalityScale(r.params.banality_scale);
        setBookRun(null);
      setOpen(null);
      setMessage(`Run ${r.id} (${r.mode}, ${r.status}, ${r.started_at.slice(0, 16).replace('T', ' ')}): ${m.length} matches`);
    } catch (e) {
      setError(String(e));
    }
  };

  const rescoreTimer = useRef<number | null>(null);
  const onBanality = (v: number) => {
    setBanalityScale(v);
    if (shownRun == null) return;
    if (rescoreTimer.current) window.clearTimeout(rescoreTimer.current);
    rescoreTimer.current = window.setTimeout(async () => {
      setBusy('rescore');
      try {
        setMatches(await reuseApi.rescore(shownRun, { ...params, threshold, banality_scale: v }));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    }, 250);
  };

  const verdict = async (m: MatchRow, v: 'confirmed' | 'rejected') => {
    try {
      const row = await reuseApi.verdict(m.id, v === m.user_verdict ? null : v);
      setMatches((rows) => rows.map((r) => (r.id === row.id ? row : r)));
      if (open?.id === row.id) setOpen(row);
      onChanged?.();
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

  // -------------------------------------------------------- the result ---

  const visible = useMemo(
    () =>
      matches
        .filter((m) => m.score >= threshold && typeFilter.has(m.kind))
        .sort((a, b) =>
          sortBy === 'death'
            ? (a.target_death_ah ?? Number.MAX_SAFE_INTEGER) - (b.target_death_ah ?? Number.MAX_SAFE_INTEGER) || b.score - a.score
            : b.score - a.score || (a.target_title ?? '').localeCompare(b.target_title ?? '', 'ar') || typeRank(a.kind) - typeRank(b.kind)
        ),
    [matches, threshold, typeFilter, sortBy]
  );
  const textsMatched = useMemo(() => new Set(visible.map((m) => m.target.book_id)).size, [visible]);
  // The default view's cutoff, per mode, from the shown run's settings. A
  // threshold the reader has dragged under the run's own is an explicit
  // ask for more, and the line follows it.
  const [viewCutoff, viewProbable] = useMemo(() => {
    const p = { ...DEFAULT_REUSE_PARAMS, ...(runs.find((r) => r.id === shownRun)?.params ?? params) };
    if (threshold < (p.threshold ?? DEFAULT_REUSE_PARAMS.threshold)) return [threshold, threshold];
    const text = (p.target_books ?? []).length;
    const cutoff = Math.max(threshold, text ? p.view_cutoff_text : p.view_cutoff_corpus);
    const probable = Math.min(cutoff, Math.max(threshold, text ? p.view_probable_text : p.view_probable_corpus));
    return [cutoff, probable];
  }, [runs, shownRun, params, threshold]);
  const confident = useMemo(() => visible.filter((m) => m.score >= viewCutoff), [visible, viewCutoff]);
  const probable = useMemo(() => visible.filter((m) => m.score >= viewProbable && m.score < viewCutoff), [visible, viewCutoff, viewProbable]);
  const lowCount = visible.length - confident.length - probable.length;
  const shown = useMemo(
    () => (showLow ? visible : showProbable ? visible.filter((m) => m.score >= viewProbable) : confident),
    [showLow, showProbable, visible, confident, viewProbable]
  );

  // The phrase with its context needs the target pages. Fetch the distinct
  // ones the visible rows land on, up to a budget: a run over a whole book can
  // match thousands of pages, and no reader reads a thousand rows.
  useEffect(() => {
    let live = true;
    const wanted = visible.slice(0, CONTEXT_BUDGET).filter((m) => !contexts.has(m.id));
    if (wanted.length === 0) return;
    setContextBusy(true);
    (async () => {
      const byPage = new Map<string, Page | null>();
      const next = new Map(contexts);
      for (const m of wanted) {
        if (!live) return;
        const key = `${m.target.book_id}:${m.target.part_index}:${m.target.page_id}`;
        let p = byPage.get(key);
        if (p === undefined) {
          p = await labApi.getPage(m.target.book_id, m.target.part_index, m.target.page_id).catch(() => null);
          byPage.set(key, p);
        }
        next.set(m.id, contextOf(p, m));
      }
      if (live) {
        setContexts(next);
        setContextBusy(false);
      }
    })();
    return () => {
      live = false;
      setContextBusy(false);
    };
    // `contexts` is written by this effect; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const openTarget = async (m: MatchRow) => {
    setOpen(m);
    setOpenPages([]);
    setQuerySpanPages([]);
    // The alignment is the point of opening a match, so it starts on (10 H).
    setSideBySide(true);
    // The left reader goes to this match's own page and marks its words; the
    // right one is about to open the other book at the other page.
    setQueryAt({ part_index: m.part_index, page_id: m.page_id });
    setQuerySpan([m.tok_start, m.tok_end]);
    setQuerySpanPages((await loadSpan(m.book_id, { part_index: m.part_index, page_id: m.page_id }, m.query_end)).filter((x): x is Page => x != null));
    setTargetLabel(plainPageLabel(m.target.part_index, m.target.page_id, m.target_parts, contexts.get(m.id)?.pageNumber ?? null));
    setOpenPages((await loadSpan(m.target.book_id, m.target, m.target_end)).filter((x): x is Page => x != null));
    if (!queryPages.has(`${m.part_index}:${m.page_id}`)) {
      const q = await labApi.getPage(m.book_id, m.part_index, m.page_id).catch(() => null);
      if (q) setQueryPages((map) => new Map(map).set(`${m.part_index}:${m.page_id}`, q));
    }
  };

  /**
 * Every page the target span covers, in reading order.
 *
 * Usually one. When the quotation runs over a break the match names the page
 * it starts on and the page it ends on, and the pages between come from the
 * book's own page list, which is the only thing that knows the order.
 */
async function loadSpan(bookId: number, from: { part_index: number; page_id: number }, to: PageRef | null): Promise<(Page | null)[]> {
  const one = () => labApi.getPage(bookId, from.part_index, from.page_id).catch(() => null);
  if (!to || (to.part_index === from.part_index && to.page_id === from.page_id)) return [await one()];
  const refs = await labApi.listPageRefs(bookId).catch(() => []);
  const at = (r: { part_index: number; page_id: number }) => refs.findIndex((x) => x.part_index === r.part_index && x.page_id === r.page_id);
  const a = at(from);
  const b = at(to);
  if (a < 0 || b < a) return [await one()];
  return Promise.all(refs.slice(a, b + 1).map((r) => labApi.getPage(r.book_id, r.part_index, r.page_id).catch(() => null)));
}

/** Enough of a book for the reader: the rest it loads for itself. */
  const targetBook: BookMetadata | null = useMemo(
    () =>
      open
        ? {
            id: open.target.book_id,
            title: open.target_title ?? `book ${open.target.book_id}`,
            death_ah: open.target_death_ah ?? undefined,
            parts: open.target_parts ?? undefined,
            in_corpus: true,
          }
        : null,
    [open]
  );

  const aggregates = useMemo(() => (bookRun ? aggregate(matches, threshold) : []), [bookRun, matches, threshold]);
  const aggColumns: Column<BookAggRow>[] = useMemo(
    () => [
      { key: 'title', label: 'Source book', sortValue: (r) => r.title ?? String(r.book_id), rtl: true, width: 'minmax(180px, 3fr)', render: (r) => r.title ?? `book ${r.book_id}` },
      { key: 'death', label: 'd. AH', sortValue: (r) => r.death_ah, align: 'right', width: '60px', render: (r) => (r.death_ah == null ? '—' : String(r.death_ah)) },
      { key: 'tokens', label: 'Aligned words', sortValue: (r) => r.aligned_tokens, align: 'right', width: '110px', defaultSort: 'desc', render: (r) => fmt(r.aligned_tokens) },
      { key: 'matches', label: 'Matches', sortValue: (r) => r.matches, align: 'right', width: '80px', render: (r) => fmt(r.matches) },
      { key: 'best', label: 'Best', sortValue: (r) => r.best_score, align: 'right', width: '60px', render: (r) => r.best_score.toFixed(2) },
    ],
    []
  );

  if (!book) return <div className="flex-1 p-6 text-sm text-app-text-secondary">Open a text from the workspace first.</div>;

  return (
    <div className="flex-1 min-w-0 flex min-h-0" data-testid="reuse-panel">
      <section className="flex-1 min-w-0 overflow-hidden flex border-r border-app-border-light">
        <ReadPanel
          book={book}
          initialAt={queryAt}
          highlight={querySpan}
          showToc={false}
          showSearch={false}
          onSectionChange={setSection}
          onSelectionChange={setSelection}
        />
      </section>

      <section className="w-[46%] min-w-[420px] flex flex-col min-h-0 relative">
        <div className="px-3 py-1.5 border-b border-app-border-light bg-app-surface text-xs flex items-center gap-2 flex-wrap">
          <span className="font-semibold">Reuse</span>
          <button
            onClick={() => selection && void findReuse(selection.at, selection.range)}
            disabled={!selection || !!busy}
            title={selection ? `Look for the ${selection.range[1] - selection.range[0]} selected words elsewhere` : 'Select some words in the text first'}
            className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
            data-testid="analyse-selected"
          >
            Find in selection
          </button>
          <button
            onClick={() => void analyseSection()}
            disabled={!local || !!busy || !section}
            title={
              !local
                ? 'Whole-book and section reuse need the local corpus (spec §4.3)'
                : section
                  ? `Every window of ${section.title}`
                  : 'Move the reader into a section first'
            }
            className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
            data-testid="analyse-section"
          >
            Find in section
          </button>
          <button
            onClick={() => void proposeRun('Analysing the whole text', null)}
            disabled={!local || !!busy || !(params.target_books ?? []).length}
            title={
              !local
                ? 'Whole-book reuse needs the local corpus (spec §4.3)'
                : (params.target_books ?? []).length
                  ? 'Every window of the text, against the named texts'
                  : 'A whole text against the whole corpus is hours to days on a laptop. Search from a section, or name a text in the gear.'
            }
            className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
            data-testid="analyse-whole"
          >
            Find in whole text
          </button>

          {runs.length > 0 && (
            <select
              value={shownRun ?? ''}
              onChange={(e) => {
                const r = runs.find((x) => x.id === Number(e.target.value));
                if (r) void openRun(r);
              }}
              className="border border-app-border-medium rounded px-1 py-0.5 max-w-[10rem]"
              aria-label="Stored runs"
            >
              <option value="">Past runs…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} {r.mode} · {r.matches} · {r.started_at.slice(0, 16).replace('T', ' ')}
                </option>
              ))}
            </select>
          )}

          <span className="ltr:ml-auto flex items-center gap-1">
            {shownRun != null && (
              <>
                <button onClick={() => void exportRun('csv')} className="px-2 py-0.5 border border-app-border-medium rounded">
                  CSV
                </button>
                <button onClick={() => void exportRun('json')} className="px-2 py-0.5 border border-app-border-medium rounded">
                  JSON
                </button>
              </>
            )}
            <button onClick={() => setGear(true)} title="Parameters" aria-label="Reuse parameters" className="px-2 py-0.5 border border-app-border-medium rounded" data-testid="reuse-gear">
              ⚙
            </button>
          </span>
        </div>

        <RunBar
          run={run}
          done={progress?.done ?? 0}
          total={progress?.total ?? 0}
          found={progress?.found}
          foundLabel="matches"
          estimateMs={progress?.estimate_ms ?? null}
          onPause={pause}
          onCancel={cancel}
        />
        <div title={messageDetail ?? undefined} data-testid="run-status">
          <Notice error={error} message={message} />
        </div>

        {open && targetBook ? (
          <>
            <OpenMatch
              m={open}
              label={targetLabel}
              pages={openPages}
              queryPages={querySpanPages.length ? querySpanPages : [queryPages.get(`${open.part_index}:${open.page_id}`)].filter((x): x is Page => !!x)}
              sideBySide={sideBySide}
              onToggleSideBySide={() => setSideBySide((v) => !v)}
              onBack={() => setOpen(null)}
              onVerdict={verdict}
            />
            {/* The same reader as the left one, on the other book: its own
                pages, its own contents, its own scroll. */}
            <ReadPanel
              book={targetBook}
              initialAt={{ part_index: open.target.part_index, page_id: open.target.page_id }}
              highlight={[open.t_start, open.t_end]}
              highlightClass="tok-match"
              showToc={false}
              showSearch={false}
              onPageChange={(_at, label) => setTargetLabel(label)}
            />
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {!bookRun && textsMatched > 30 && (
              <div className="flex items-center gap-3 px-2 py-1 text-sm border-b border-app-border-light" data-testid="many-texts">
                <span>This passage appears in {textsMatched} texts</span>
                <label className="text-xs text-app-text-secondary flex items-center gap-1">
                  sort by
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'score' | 'death')} aria-label="Sort matches" className="border border-app-border-medium rounded px-1">
                    <option value="score">score</option>
                    <option value="death">author's death</option>
                  </select>
                </label>
              </div>
            )}
            {bookRun && aggregates.length > 0 && (
              <div className="border-b border-app-border-light">
                <VirtualTable
                  columns={aggColumns}
                  rows={aggregates}
                  rowKey={(r) => r.book_id}
                  height={160}
                  emptyText="No source books at this threshold."
                  testId="reuse-aggregates"
                />
              </div>
            )}

            <div
              className="flex items-center gap-3 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide
                         text-app-text-secondary border-b border-app-border-light bg-app-surface-variant"
              dir="rtl"
            >
              <span className="w-16 shrink-0">Page</span>
              <span className="flex-[2] min-w-0">Text</span>
              <span className="flex-1 min-w-0">Book</span>
              <span className="shrink-0 normal-case tracking-normal font-normal" dir="ltr" data-testid="run-mode">
                {((runs.find((r) => r.id === shownRun)?.params ?? params).target_books ?? []).length
                  ? 'in named texts, read whole'
                  : 'in the corpus, by anchor'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto">
              {shown.map((m) => (
                <ResultRow key={m.id} m={m} ctx={contexts.get(m.id)} onClick={() => void openTarget(m)} />
              ))}
              {probable.length > 0 && (
                <button
                  onClick={() => setShowProbable((v) => !v)}
                  className="w-full p-2 text-xs text-app-text-secondary border-t border-app-border-light hover:bg-app-bg-hover"
                  title={`Scoring ${viewProbable.toFixed(2)}-${viewCutoff.toFixed(2)}: about six in ten read as genuine on the calibration pair`}
                  data-testid="show-probable"
                >
                  {showProbable || showLow ? 'Hide' : 'Show'} {probable.length} probable {probable.length === 1 ? 'match' : 'matches'}
                </button>
              )}
              {lowCount > 0 && (
                <button
                  onClick={() => setShowLow((v) => !v)}
                  className="w-full p-2 text-xs text-app-text-secondary border-t border-app-border-light hover:bg-app-bg-hover"
                  title={`Scoring under ${viewProbable.toFixed(2)}, where about a third read as genuine on the calibration pair`}
                  data-testid="show-low"
                >
                  {showLow ? 'Hide' : 'Show'} {lowCount} lower-confidence {lowCount === 1 ? 'match' : 'matches'}
                </button>
              )}
              {visible.length === 0 && shownRun != null && <p className="p-4 text-sm text-app-text-secondary">No matches at this threshold.</p>}
              {shownRun == null && !busy && (
                <p className="p-4 text-sm text-app-text-secondary">
                  Select words in the text and press Find in selection, or look through the section the reader is in,
                  or the whole text.
                </p>
              )}
              {contextBusy && visible.length > 0 && (
                <p className="p-2 text-xs text-app-text-secondary">Fetching the surrounding words…</p>
              )}
            </div>
          </div>
        )}

        {busy === 'passage' && <LoadingOverlay step={{ label: 'Searching the corpus for this passage…' }} onCancel={cancel} />}
        {busy === 'estimate' && <LoadingOverlay step={{ label: 'Working out how long that would take…' }} onCancel={cancel} />}
      </section>

      <HeavyRunModal
        open={!!pending}
        what={pending?.what ?? ''}
        pages={pending?.pages ?? 0}
        tokens={pending?.tokens ?? 0}
        estimateMs={pending?.estimateMs ?? null}
        onContinue={() => pending && void startBook(pending.span, pending.what)}
        onCancel={() => setPending(null)}
      />

      {gear && (
        <GearModal
          params={params}
          setParams={setParams}
          threshold={threshold}
          setThreshold={setThreshold}
          banalityScale={banalityScale}
          onBanality={onBanality}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          excludeSameBook={excludeSameBook}
          setExcludeSameBook={setExcludeSameBook}
          onClose={() => setGear(false)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- a result ---

interface Context {
  before: string;
  phrase: string;
  after: string;
  pageNumber: string | null;
}

function contextOf(page: Page | null, m: MatchRow): Context {
  if (!page) return { before: '', phrase: m.snapshot, after: '', pageNumber: null };
  // Token indices are offsets from the start page and may run past its end
  // into the next one, which the row does not have: slicing stops there, and
  // the reader below shows the whole of it.
  const words = (a: number, b: number) =>
    page.tokens
      .slice(Math.max(0, a), Math.max(0, b))
      .map((t) => t.surface)
      .join(' ');
  return {
    before: words(Math.max(0, m.t_start - CONTEXT), m.t_start),
    phrase: words(m.t_start, m.t_end),
    after: words(m.t_end, m.t_end + CONTEXT),
    pageNumber: page.page_number,
  };
}

/**
 * One match, read right to left: whose book, what it says, where. The score
 * and the kind sit under the title, small, because they qualify the row
 * rather than being what the reader came for.
 */
function ResultRow({ m, ctx, onClick }: { m: MatchRow; ctx?: Context; onClick: () => void }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const title = m.target_title ?? `book ${m.target.book_id}`;
  return (
    <>
      <div
        onClick={onClick}
        dir="rtl"
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-right border-b border-app-border-light
                    cursor-pointer hover:bg-app-surface-variant transition-colors ${
                      m.user_verdict === 'rejected' ? 'opacity-50' : ''
                    }`}
        data-testid="reuse-row"
      >
        <span className="w-16 shrink-0 text-sm text-app-text-primary tabular-nums" dir="ltr">
          {plainPageLabel(m.target.part_index, m.target.page_id, m.target_parts, ctx?.pageNumber)}
        </span>

        <span className="flex-[2] min-w-0 font-arabic text-lg leading-8 truncate">
          {ctx ? (
            <>
              <span className="text-app-text-secondary">{ctx.before} </span>
              <span className="reuse-phrase">{ctx.phrase}</span>
              <span className="text-app-text-secondary"> {ctx.after}</span>
            </>
          ) : (
            <span className="reuse-phrase">{m.snapshot}</span>
          )}
        </span>

        <span
          className="flex-1 min-w-0"
          onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setTip(null)}
        >
          <span className="block font-arabic text-lg font-medium text-app-accent truncate">{title}</span>
          <span className="block text-xs text-app-text-secondary" dir="ltr">
            {m.score.toFixed(2)} · {m.kind}
            {m.user_verdict === 'confirmed' && ' · confirmed'}
          </span>
        </span>
      </div>

      {tip &&
        createPortal(
          <div
            className="fixed z-50 max-w-sm px-3 py-2 rounded-lg bg-app-surface border border-app-border-medium
                       shadow-lg text-sm pointer-events-none"
            style={{ left: tip.x + 14, top: tip.y + 14 }}
          >
            <p className="font-arabic text-base" dir="rtl">
              {title}
            </p>
            {m.target_author_name && (
              <p className="font-arabic text-sm text-app-text-secondary mt-0.5" dir="rtl">
                {m.target_author_name}
              </p>
            )}
            {m.target_death_ah != null && (
              <p className="text-xs text-app-text-secondary mt-0.5">died {m.target_death_ah} AH</p>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

/**
 * The right reader's header: whose book this is, who wrote it, which page,
 * and the way back to the table (7 C3, 8 D). The alignment of the two
 * passages stays here as a toggle, above both texts.
 */
function OpenMatch({
  m,
  label,
  pages,
  queryPages,
  sideBySide,
  onToggleSideBySide,
  onBack,
  onVerdict,
}: {
  m: MatchRow;
  /** The target page by the C1 rule, from the reader below. */
  label: string;
  /** Every page the target span covers, in reading order. */
  pages: Page[];
  /** The same on the query side. */
  queryPages: Page[];

  sideBySide: boolean;
  onToggleSideBySide: () => void;
  onBack: () => void;
  onVerdict: (m: MatchRow, v: 'confirmed' | 'rejected') => void;
}) {
  const pairs = useMemo(() => {
    const q = new Map<number, number>();
    const t = new Map<number, number>();
    m.pairs.forEach(([a, b], i) => {
      q.set(a, i);
      t.set(b, i);
    });
    return { q, t };
  }, [m.pairs]);

  // The span as one stream, with the page each word sits on, so a quotation
  // that runs over a break reads as the one passage it is.
  const span = useMemo(() => {
    const out: { tok: Token; page: Page; first: boolean }[] = [];
    for (const p of pages) {
      p.tokens.forEach((tok, i) => out.push({ tok, page: p, first: i === 0 }));
    }
    return out;
  }, [pages]);
  const page = pages[0] ?? null;
  const qspan = useMemo(() => {
    const out: { tok: Token; page: Page; first: boolean }[] = [];
    for (const p of queryPages) {
      p.tokens.forEach((tok, i) => out.push({ tok, page: p, first: i === 0 }));
    }
    return out;
  }, [queryPages]);
  const queryPage = queryPages[0] ?? null;

  return (
    <div className="flex-shrink-0 flex flex-col" data-testid="reuse-target">
      <div className="px-3 py-1.5 border-b border-app-border-light bg-app-surface-variant flex items-center gap-2 text-xs">
        <button onClick={onBack} className="px-2 py-1 border border-app-border-medium rounded" data-testid="back-to-results">
          ‹ Back to results
        </button>
        <span className="flex-1 min-w-0 text-right" dir="rtl" title={m.target_title ?? undefined}>
          <span className="font-arabic truncate">{m.target_title ?? `book ${m.target.book_id}`}</span>
          {m.target_author_name && <span className="font-arabic text-app-text-secondary">{' · '}{m.target_author_name}</span>}
        </span>
        <span className="tabular-nums text-app-text-secondary" data-testid="target-page">
          {label || '…'}
          {m.target_end && (
            <span className="text-app-accent" data-testid="target-span">
              {' → '}
              {plainPageLabel(m.target_end.part_index, m.target_end.page_id, m.target_parts, null)}
            </span>
          )}
        </span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sideBySide} onChange={onToggleSideBySide} />
          Side by side
        </label>
        <button
          onClick={() => onVerdict(m, 'confirmed')}
          className={`px-2 py-0.5 rounded border ${m.user_verdict === 'confirmed' ? 'bg-green-600 text-white border-green-600' : 'border-app-border-medium'}`}
          aria-label="Confirm this match"
        >
          ✓
        </button>
        <button
          onClick={() => onVerdict(m, 'rejected')}
          className={`px-2 py-0.5 rounded border ${m.user_verdict === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'border-app-border-medium'}`}
          aria-label="Reject this match"
        >
          ✗
        </button>
      </div>

      <div className="px-3 py-1 text-xs text-app-text-secondary border-b border-app-border-light">
        score {m.score.toFixed(3)} · {m.kind} · coverage {m.components.coverage.toFixed(2)} · lemma {m.components.lemma_agree.toFixed(2)} · root{' '}
        {m.components.root_agree.toFixed(2)} · surface {m.components.surface_agree.toFixed(2)} · banal {m.components.banal_share.toFixed(2)} →{' '}
        {m.components.banality_factor.toFixed(2)} · {m.components.aligned} aligned
      </div>

      {sideBySide && queryPage && page && span.length > 0 && (
        <div className="max-h-56 overflow-y-auto grid grid-cols-2 gap-3 p-4 font-arabic text-lg leading-8 border-b border-app-border-light" dir="rtl" data-testid="side-by-side">
          <div>
            <div className="text-xs text-app-text-secondary mb-1 flex items-center gap-1" dir="ltr">
              <span className="inline-block w-2 h-2 rounded-sm bg-[#D4EDDA] border border-[#28A745]" />
              this text
            </div>
            {qspan.slice(m.tok_start, m.tok_end).map((w, k) => {
              const idx = m.tok_start + k;
              return (
                <span key={idx}>
                  {w.first && k > 0 && (
                    <span className="mx-1 px-1 text-xs font-ui text-app-accent border border-app-accent rounded align-middle" dir="ltr" data-testid="query-page-break">
                      {plainPageLabel(w.page.part_index, w.page.page_id, null, w.page.page_number)}
                    </span>
                  )}
                  <span className={pairs.q.has(idx) ? `lay-pair-${pairs.q.get(idx)! % 8}` : 'text-app-text-secondary'}>
                    {w.tok.surface}{' '}
                  </span>
                </span>
              );
            })}
          </div>
          <div>
            <div className="text-xs text-app-text-secondary mb-1 flex items-center gap-1" dir="ltr">
              <span className="inline-block w-2 h-2 rounded-sm bg-[#FDE2E2] border border-[#DC3545]" />
              the other
            </div>
            {span.slice(m.t_start, m.t_end).map((w, k) => {
              const idx = m.t_start + k;
              return (
                <span key={idx}>
                  {w.first && k > 0 && (
                    <span className="mx-1 px-1 text-xs font-ui text-app-accent border border-app-accent rounded align-middle" dir="ltr" data-testid="page-break">
                      {plainPageLabel(w.page.part_index, w.page.page_id, m.target_parts, w.page.page_number)}
                    </span>
                  )}
                  <span className={pairs.t.has(idx) ? `lay-pair-${pairs.t.get(idx)! % 8}` : 'text-app-text-secondary'}>
                    {w.tok.surface}{' '}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- the gear ---

function GearModal({
  params,
  setParams,
  threshold,
  setThreshold,
  banalityScale,
  onBanality,
  typeFilter,
  setTypeFilter,
  excludeSameBook,
  setExcludeSameBook,
  onClose,
}: {
  params: ReuseParams;
  setParams: (p: ReuseParams) => void;
  threshold: number;
  setThreshold: (v: number) => void;
  banalityScale: number;
  onBanality: (v: number) => void;
  typeFilter: Set<MatchType>;
  setTypeFilter: (s: Set<MatchType>) => void;
  excludeSameBook: boolean;
  setExcludeSameBook: (v: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Reuse parameters"
        className="bg-app-surface rounded-2xl shadow-lg border border-app-border-light w-[30rem] max-w-[95vw] p-4 text-sm space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="reuse-gear-modal"
      >
        <h2 className="font-semibold">Reuse parameters</h2>

        <label className="flex items-center gap-2">
          <span className="w-28 text-xs text-app-text-secondary">Threshold</span>
          <input type="range" min={0} max={1} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="flex-1" aria-label="Threshold" />
          <span className="w-10 tabular-nums text-right">{threshold.toFixed(2)}</span>
        </label>
        <p className="text-[11px] text-app-text-secondary -mt-2 ltr:ml-[7.5rem]">Hides rows below this score. No re-run.</p>

        <label className="flex items-center gap-2">
          <span className="w-28 text-xs text-app-text-secondary">Banality</span>
          <input type="range" min={0.05} max={1} step={0.05} value={banalityScale} onChange={(e) => onBanality(Number(e.target.value))} className="flex-1" aria-label="Banality scale" />
          <span className="w-10 tabular-nums text-right">{banalityScale.toFixed(2)}</span>
        </label>
        <p className="text-[11px] text-app-text-secondary -mt-2 ltr:ml-[7.5rem]">
          How hard a passage of common words is penalised. Re-scores what is already found.
        </p>

        <div>
          <span className="block text-xs text-app-text-secondary mb-1">Kinds of match shown</span>
          <div className="flex flex-wrap gap-3">
            {TYPES.map((t) => (
              <label key={t} className={`flex items-center gap-1 ${t === 'formulaic' ? 'text-app-text-secondary' : ''}`}>
                <input
                  type="checkbox"
                  checked={typeFilter.has(t)}
                  onChange={(e) => {
                    const s = new Set(typeFilter);
                    if (e.target.checked) s.add(t);
                    else s.delete(t);
                    setTypeFilter(s);
                  }}
                />
                {t}
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={excludeSameBook} onChange={(e) => setExcludeSameBook(e.target.checked)} />
          <span>Exclude this book</span>
        </label>

        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <span className="w-28 text-xs text-app-text-secondary pt-1.5">Search in</span>
            <BookPicker value={params.target_books ?? []} onChange={(ids) => setParams({ ...params, target_books: ids })} placeholder="the whole corpus" max={50} />
          </div>
          <p className="text-[11px] text-app-text-secondary ltr:ml-[7.5rem]" data-testid="target-books-note">
            {(params.target_books ?? []).length
              ? `${(params.target_books ?? []).length} text${(params.target_books ?? []).length > 1 ? 's' : ''}, read into memory: every phrase of every window is looked up, which finds short quotations the corpus search cannot reach. Up to about four million tokens between them.`
              : 'The whole corpus, by anchor: a few rare phrases of each window are looked up on the index. Name a text or a few to read them instead.'}
          </p>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-xs text-app-text-secondary">Banality rank</span>
            <input
              type="number"
              min={0}
              max={5000}
              step={50}
              value={params.banality_rank}
              onChange={(e) => setParams({ ...params, banality_rank: Math.max(0, Number(e.target.value) || 0) })}
              className="w-20 border border-app-border-medium rounded px-1 py-0.5"
              aria-label="Banality rank"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-app-text-secondary">Least aligned words</span>
            <input
              type="number"
              min={2}
              max={40}
              value={params.min_aligned}
              onChange={(e) => setParams({ ...params, min_aligned: Math.max(2, Number(e.target.value) || 6) })}
              className="w-16 border border-app-border-medium rounded px-1 py-0.5"
              aria-label="Min aligned"
            />
          </label>
        </div>
        <p className="text-[11px] text-app-text-secondary">Both of these change what a run finds, so they take effect on the next run.</p>

        <div className="text-right">
          <button onClick={onClose} className="px-3 py-1 border border-app-border-medium rounded">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Per-book aggregate for a stored run, mirroring `reuse::aggregate`. */
function aggregate(rows: MatchRow[], threshold: number): BookAggRow[] {
  const by = new Map<number, BookAggRow>();
  for (const m of rows) {
    if (m.score < threshold) continue;
    const a =
      by.get(m.target.book_id) ??
      ({ book_id: m.target.book_id, matches: 0, aligned_tokens: 0, best_score: 0, types: {}, title: m.target_title, author_id: m.target_author, death_ah: m.target_death_ah } as BookAggRow);
    a.matches += 1;
    a.aligned_tokens += m.components.aligned;
    a.best_score = Math.max(a.best_score, m.score);
    a.types[m.kind] = (a.types[m.kind] ?? 0) + 1;
    by.set(m.target.book_id, a);
  }
  return [...by.values()].sort((x, y) => y.aligned_tokens - x.aligned_tokens || y.matches - x.matches);
}

/** Enough of `normalize_arabic` for "same surface" emphasis. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}
