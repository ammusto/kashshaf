import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page, type PageRef } from '../../api/lab';
import { usePages } from '../../api/pages';
import { useHeavyLimits } from '../../api/settings';
import { HeavyRunModal, IDLE_RUN, RunBar, isHeavy, type RunState } from '../ui/Running';
import { DEFAULT_QURAN_PARAMS, fmtDuration, quranApi, type AyaContext, type QuranMatchRow, type QuranParams, type QuranProgress, type QuranRunSummary, type QuranStatus } from '../../api/reuse';
import { Reader } from '../Reader';
import { GearButton, SettingsModal } from '../SettingsModal';
import { VirtualTable, type Column } from '../stats/VirtualTable';

/**
 * The Qurʾān panel (spec §7.6, amended 1.4): "Detect quotations" over the
 * current book with progress and cancel, its parameters behind a gear
 * (persisted in `lab_setting`); the results as a virtualised table by
 * Qurʾān reference — page, the text as quoted, the āya — with an ⓘ per row
 * that opens a detail view in the right pane (tokens, agreement, cue, the
 * ambiguous readings, the āya with one āya of context in imlāʾī or
 * Uthmani); the current page's quotations as a reader layer; confirm and
 * reject; export.
 */

const SETTING_KEY = 'quran.params';

interface Props {
  book: BookMetadata | null;
  /** A verdict was given: the workspace folder is behind (spec 1.5 A2). */
  onChanged?: () => void;
}

export function QuranPanel({ book, onChanged }: Props) {
  const bookId = book?.id ?? null;
  const labels = usePages(bookId, book?.parts);
  const [status, setStatus] = useState<QuranStatus | null>(null);
  const [params, setParams] = useState<QuranParams>(DEFAULT_QURAN_PARAMS);
  const [draft, setDraft] = useState<QuranParams>(DEFAULT_QURAN_PARAMS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rows, setRows] = useState<QuranMatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<QuranProgress | null>(null);
  const [run$, setRun$] = useState<RunState>(IDLE_RUN);
  const [pending, setPending] = useState<{ pages: number; tokens: number } | null>(null);
  const { limits } = useHeavyLimits();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'cued' | 'uncued' | 'confirmed' | 'open' | 'ambiguous'>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<QuranMatchRow | null>(null);
  const [context, setContext] = useState<AyaContext | null>(null);
  const [uthmani, setUthmani] = useState(false);

  const [refs, setRefs] = useState<PageRef[]>([]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);

  useEffect(() => {
    quranApi.status().then(setStatus).catch((e) => setError(String(e)));
    labApi
      .getSetting(SETTING_KEY)
      .then((v) => {
        if (!v) return;
        try {
          const p = { ...DEFAULT_QURAN_PARAMS, ...(JSON.parse(v) as Partial<QuranParams>) };
          setParams(p);
          setDraft(p);
        } catch {
          /* a bad setting is ignored */
        }
      })
      .catch(() => {});
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
    setSelected(null);
    setDetail(null);
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

  // The detail view's context, fetched when a row is opened.
  useEffect(() => {
    if (!detail) {
      setContext(null);
      return;
    }
    let alive = true;
    quranApi
      .context(detail.sura, detail.aya_start, detail.aya_end)
      .then((c) => alive && setContext(c))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [detail]);

  /** Ask before a run over the Settings thresholds (spec 1.5 F4). */
  const propose = async () => {
    if (bookId == null) return;
    setError(null);
    try {
      const size = await labApi.runSize(bookId, null);
      if (isHeavy(size, limits)) {
        setPending({ pages: size.pages, tokens: size.tokens });
        return;
      }
    } catch (e) {
      // A size we cannot work out is not a reason to refuse the run.
      console.error('run_size failed', e);
    }
    void run();
  };

  const run = async () => {
    if (bookId == null) return;
    setPending(null);
    setBusy(true);
    setRun$({ running: true, paused: false, cancelledAt: null });
    setError(null);
    setMessage(null);
    setProgress(null);
    try {
      const s: QuranRunSummary = await quranApi.run(bookId, params);
      setMessage(`${s.hits} quotations over ${s.pages_done.toLocaleString()} pages · ${s.kept_judged} judged rows kept · ${fmtDuration(s.elapsed_ms)}`);
      setRun$(
        s.cancelled
          ? { running: false, paused: false, cancelledAt: `${s.pages_done.toLocaleString()} of ${s.pages.toLocaleString()} pages, ${s.hits} quotations kept` }
          : IDLE_RUN
      );
      await reload();
    } catch (e) {
      setError(String(e));
      setRun$(IDLE_RUN);
    } finally {
      setBusy(false);
    }
  };

  const pause = (paused: boolean) => {
    setRun$((r) => ({ ...r, paused }));
    void labApi.statsPause(paused);
  };

  const applySettings = async () => {
    const clean: QuranParams = {
      ...draft,
      min_tokens: Math.max(2, Math.round(draft.min_tokens) || DEFAULT_QURAN_PARAMS.min_tokens),
      cued_min_tokens: Math.max(2, Math.round(draft.cued_min_tokens) || DEFAULT_QURAN_PARAMS.cued_min_tokens),
      min_lemma_agree: Math.min(1, Math.max(0.5, Number(draft.min_lemma_agree) || DEFAULT_QURAN_PARAMS.min_lemma_agree)),
    };
    setParams(clean);
    setDraft(clean);
    setSettingsOpen(false);
    try {
      await labApi.setSetting(SETTING_KEY, JSON.stringify(clean));
    } catch (e) {
      setError(String(e));
    }
  };

  const resetSettings = () => setDraft(DEFAULT_QURAN_PARAMS);

  const verdict = async (r: QuranMatchRow, v: 'confirmed' | 'rejected') => {
    try {
      const row = await quranApi.verdict(r.id, v === r.user_verdict ? null : v);
      setRows((rs) => rs.map((x) => (x.id === row.id ? row : x)));
      if (detail?.id === row.id) setDetail(row);
      onChanged?.();
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
          case 'ambiguous':
            return r.also.length > 0;
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

  const refOf = (r: { sura: number; aya_start: number; aya_end: number }) => `${r.sura}:${r.aya_start}${r.aya_end !== r.aya_start ? `–${r.aya_end}` : ''}`;

  const columns: Column<QuranMatchRow>[] = [
    {
      key: 'ref',
      label: 'Qurʾān',
      sortValue: (r) => r.sura * 1000 + r.aya_start,
      width: '150px',
      render: (r) => (
        <span className={r.id === selected ? 'font-semibold' : ''}>
          {refOf(r)} <span className="font-arabic">{r.sura_name}</span>
          {r.also.length > 0 && (
            <span className="ml-1 text-[10px] px-1 rounded bg-app-surface-variant text-app-text-secondary" title={`Aligns equally to ${r.also.length + 1} āyāt`}>
              ambiguous: {r.also.length + 1} āyāt
            </span>
          )}
        </span>
      ),
    },
    // Spec 1.5 I: the list reads the way the book does, page by page, not
    // sura by sura -- what is being read is the book, not the Qur'an.
    {
      key: 'page',
      label: 'Page',
      sortValue: (r) => r.part_index * 1_000_000 + r.page_id,
      width: '70px',
      defaultSort: 'asc',
      render: (r) => labels.label(r.part_index, r.page_id),
    },
    { key: 'text', label: 'Text', sortValue: (r) => r.snapshot, rtl: true, width: 'minmax(200px, 3fr)', render: (r) => r.snapshot },
    { key: 'aya', label: 'Āya', sortValue: (r) => r.aya_text, rtl: true, width: 'minmax(200px, 3fr)', render: (r) => <span className="text-app-text-secondary">{r.aya_text}</span> },
    {
      key: 'info',
      label: '',
      sortValue: () => 0,
      width: '32px',
      render: (r) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setDetail(r);
            setSelected(r.id);
          }}
          className="px-1 rounded border border-app-border-medium text-app-accent"
          aria-label={`Details of quotation ${r.id}`}
          title="Details"
        >
          ⓘ
        </button>
      ),
    },
    {
      key: 'verdict',
      label: '',
      sortValue: (r) => r.user_verdict ?? '',
      width: '70px',
      render: (r) => <VerdictButtons r={r} onVerdict={verdict} />,
    },
  ];

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Open a text from the workspace first.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
        <button onClick={() => void propose()} disabled={busy || !status?.available} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40" title="Whole-book run (§4.4)">
          {busy ? 'Detecting…' : 'Detect quotations'}
        </button>
        <GearButton onClick={() => { setDraft(params); setSettingsOpen(true); }} label="Detection settings" />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="border border-app-border-medium rounded px-1" aria-label="Filter">
          <option value="all">all</option>
          <option value="cued">cued</option>
          <option value="uncued">uncued</option>
          <option value="ambiguous">ambiguous</option>
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

      <SettingsModal title="Qurʾān detection" open={settingsOpen} onClose={() => setSettingsOpen(false)} onApply={() => void applySettings()} onReset={resetSettings}>
        <label className="flex items-center justify-between gap-2">
          <span title="Aligned tokens a quotation needs without a cue (spec §4.4: 4)">Minimum tokens</span>
          <input type="number" min={2} max={12} value={draft.min_tokens} onChange={(e) => setDraft({ ...draft, min_tokens: Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Min tokens" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span title="With a ﴿ ﴾, «» or قال تعالى cue within 3 tokens (spec §4.4: 3)">Minimum tokens, cued</span>
          <input type="number" min={2} max={12} value={draft.cued_min_tokens} onChange={(e) => setDraft({ ...draft, cued_min_tokens: Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Cued min tokens" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span title="Lemma agreement a quotation needs (spec §4.4: 0.8)">Lemma agreement ≥</span>
          <input type="number" min={0.5} max={1} step={0.05} value={draft.min_lemma_agree} onChange={(e) => setDraft({ ...draft, min_lemma_agree: Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Min lemma agreement" />
        </label>
        <p className="text-xs text-app-text-tertiary">Defaults are the spec's (§4.4). Applied to the next run; kept between sessions.</p>
      </SettingsModal>

      <RunBar
        run={run$}
        done={progress?.done ?? 0}
        total={progress?.total ?? 0}
        found={progress?.found}
        foundLabel="quotations"
        estimateMs={progress?.estimate_ms ?? null}
        onPause={pause}
        onCancel={() => void labApi.statsCancel()}
      />

      <HeavyRunModal
        open={!!pending}
        what="Detect Qurʾān quotations"
        pages={pending?.pages ?? 0}
        tokens={pending?.tokens ?? 0}
        onContinue={() => void run()}
        onCancel={() => setPending(null)}
      />
      {(error || message) && (
        <div className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`} role={error ? 'alert' : 'status'}>
          {error ?? message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <section className="flex-1 min-w-0 border-r border-app-border-light">
          <Reader page={page} pages={refs} index={index} onNavigate={(i) => goTo(i)} highlight={highlight} layerClass={layerClass} onTokenClick={onTokenClick} onClearSelection={() => setSelected(null)} loading={pageLoading} error={null} />
        </section>
        <section className="w-[52%] min-w-[460px] min-h-0 flex flex-col">
          {detail ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 text-sm" data-testid="quran-detail">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold">{refOf(detail)}</span>
                <span className="font-arabic text-base">{detail.sura_name}</span>
                <span className="text-app-text-tertiary text-xs">{labels.label(detail.part_index, detail.page_id)}</span>
                <button onClick={() => show(detail)} className="text-xs text-app-accent underline">
                  show in reader
                </button>
                <button onClick={() => setDetail(null)} className="ml-auto px-2 text-app-text-tertiary" aria-label="Close details">
                  ×
                </button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs mb-3">
                <dt className="text-app-text-tertiary">Tokens</dt>
                <dd>{detail.aligned}</dd>
                <dt className="text-app-text-tertiary">Lemma</dt>
                <dd>{detail.lemma_agree.toFixed(2)}</dd>
                <dt className="text-app-text-tertiary">Surface</dt>
                <dd>
                  {detail.surface_agree.toFixed(2)} <span className="text-app-text-tertiary">({detail.surface_agree >= 0.9 ? 'verbatim' : 'paraphrased or inflected'})</span>
                </dd>
                <dt className="text-app-text-tertiary">Cue</dt>
                <dd>{detail.cue ?? '—'}</dd>
                <dt className="text-app-text-tertiary">Verdict</dt>
                <dd>
                  <VerdictButtons r={detail} onVerdict={verdict} />
                </dd>
              </dl>
              <div className="font-arabic page-body text-base mb-3" dir="rtl">
                <span className="text-app-text-tertiary text-xs font-ui" dir="ltr">
                  as quoted:{' '}
                </span>
                {detail.snapshot}
              </div>
              {detail.also.length > 0 && (
                <div className="text-xs mb-3" data-testid="quran-ambiguous">
                  <div className="text-app-text-tertiary mb-1">Aligns equally to {detail.also.length + 1} āyāt — every reading:</div>
                  <div className="flex flex-wrap gap-1">
                    <span className="px-1 rounded bg-app-accent-light">{refOf(detail)}</span>
                    {detail.also.map((a) => (
                      <span key={`${a.sura}:${a.aya_start}`} className="px-1 rounded bg-app-surface-variant">
                        {refOf(a)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs mb-1">
                <span className="text-app-text-tertiary">Āya with context</span>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={uthmani} onChange={(e) => setUthmani(e.target.checked)} /> Uthmani
                </label>
              </div>
              {context ? (
                <div className="font-arabic page-body text-lg leading-9" dir="rtl" data-testid="quran-context">
                  {context.before && <span className="text-app-text-tertiary">{uthmani ? context.before.text_uthmani : context.before.text} ﴿{context.before.aya}﴾ </span>}
                  {context.ayas.map((a) => (
                    <span key={a.aya} className="bg-app-accent-light rounded px-0.5">
                      {uthmani ? a.text_uthmani : a.text} ﴿{a.aya}﴾{' '}
                    </span>
                  ))}
                  {context.after && <span className="text-app-text-tertiary">{uthmani ? context.after.text_uthmani : context.after.text} ﴿{context.after.aya}﴾</span>}
                </div>
              ) : (
                <div className="text-xs text-app-text-tertiary">loading…</div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 p-2">
              <VirtualTable columns={columns} rows={shown} rowKey={(r) => r.id} onRowClick={show} height="fill" emptyText={rows.length ? 'Nothing matches the filter.' : 'No quotations yet — press "Detect quotations".'} testId="quran-table" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function VerdictButtons({ r, onVerdict }: { r: QuranMatchRow; onVerdict: (r: QuranMatchRow, v: 'confirmed' | 'rejected') => void }) {
  return (
    <span className="flex gap-1">
      <button onClick={(e) => { e.stopPropagation(); onVerdict(r, 'confirmed'); }} className={`px-1 rounded border ${r.user_verdict === 'confirmed' ? 'bg-green-600 text-white border-green-600' : 'border-app-border-medium'}`} aria-label={`Confirm quotation ${r.id}`}>
        ✓
      </button>
      <button onClick={(e) => { e.stopPropagation(); onVerdict(r, 'rejected'); }} className={`px-1 rounded border ${r.user_verdict === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'border-app-border-medium'}`} aria-label={`Reject quotation ${r.id}`}>
        ✗
      </button>
    </span>
  );
}
