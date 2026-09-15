import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page, type PageRef, type PageSpan } from '../../api/lab';
import { useHeavyLimits } from '../../api/settings';
import { Pages, usePages } from '../../api/pages';
import {
  applyTracked,
  DEFAULT_PARAMS,
  emptyStack,
  isnadApi,
  layersFor,
  redoTracked,
  spansPages,
  undoTracked,
  type Confidence,
  type Group,
  type IsnadFilter,
  type IsnadRow,
  type Op,
  type OpStack,
  type Params,
  type PersonRow,
  type RunProgress,
  type RunSummary,
  type TokenClass,
  normalizeArabic,
  type TransmitterListRow,
} from '../../api/isnad';
import { Reader } from '../Reader';
import { GearButton, SettingsModal } from '../SettingsModal';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';
import { HeavyRunModal, IDLE_RUN, RunBar, isHeavy, type RunState } from '../ui/Running';
import { ScopePicker, WHOLE_BOOK, type Scope } from '../ui/ScopePicker';
import { Disambiguator } from './Disambiguator';

/**
 * The isnād workbench (spec §7.4): two panes.
 *
 * Left — the text: the reader with the current candidate emphasised (chain
 * outlined, each transmitter in its own colour, verbs in a shared colour,
 * the matn in a fourth) and the structured chain above it. Confirm/reject,
 * next/previous, matn boundary, split/merge transmitter, retag, "add to
 * lexicon after three", filters.
 *
 * Right — transmitters: every span in the book, searchable, sortable,
 * groupable by form, with suggestions shown dashed and never applied
 * without a click. Link, same person, rename, death year, split, notes,
 * accept-all-on-page.
 *
 * Every mutation goes through `applyTracked`, so Ctrl+Z / Ctrl+Y walk the
 * session stack of inverses; the backend logs each to equivalence_log.
 *
 * Keyboard map (documented in lab/README.md):
 *   c confirm · x reject · j next · k previous · l link · m merge/same person
 *   b matn-start mode · e matn-end mode · [ ] nudge boundary · s split mode
 *   r retag mode, then v/n/f/o · a accept suggestions on page · g group by form
 *   / search · Esc leave a mode · Ctrl+Z undo · Ctrl+Y redo
 */

type Mode = 'none' | 'matn-start' | 'matn-end' | 'split' | 'retag';

const CLASS_KEYS: Record<string, TokenClass> = { v: 'verb', n: 'name', f: 'formula', o: 'other' };
const ISNAD_SETTING_KEY = 'isnad.params';

export function IsnadWorkbench({ book, onChanged }: { book: BookMetadata | null; onChanged?: () => void }) {
  const bookId = book?.id ?? null;
  const [rows, setRows] = useState<IsnadRow[]>([]);
  const [index, setIndex] = useState(0);
  /** A row opened from the transmitter table that the filter does not list. */
  const [pinned, setPinned] = useState<IsnadRow | null>(null);
  /** The pages the current row runs over (start page first) and which one is shown. */
  const [spanPages, setSpanPages] = useState<Page[]>([]);
  const [spanOffset, setSpanOffset] = useState(0);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);
  const [pendingJump, setPendingJump] = useState<{ tok_start: number; tok_end: number } | null>(null);
  const [occurrences, setOccurrences] = useState<TransmitterListRow[] | null>(null);
  const [bookRefs, setBookRefs] = useState<PageRef[]>([]);
  const [classes, setClasses] = useState<[number, TokenClass][]>([]);
  const [filter, setFilter] = useState<IsnadFilter>({ status: 'candidate', min_confidence: 0.2 });
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [draft, setDraft] = useState<Params>(DEFAULT_PARAMS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [run$, setRun$] = useState<RunState>(IDLE_RUN);
  const [scope, setScope] = useState<Scope>(WHOLE_BOOK);
  const [pending, setPending] = useState<{ label: string; span: PageSpan | null; pages: number; tokens: number } | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('none');
  const [selectedTransmitter, setSelectedTransmitter] = useState<number | null>(null);
  const [selectedToken, setSelectedToken] = useState<number | null>(null);
  const [retagOffer, setRetagOffer] = useState<[string, TokenClass, number] | null>(null);
  /** The name disambiguator takes the panel over when it is open (10 A). */
  const [disambiguating, setDisambiguating] = useState(false);
  /** Bumped whenever the rows are re-read, so the disambiguator follows. */
  const [stamp, setStamp] = useState(0);
  const [table, setTable] = useState<TransmitterListRow[]>([]);
  const [persons, setPersons] = useState<PersonRow[]>([]);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [groupByForm, setGroupByForm] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [personMenu, setPersonMenu] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { limits } = useHeavyLimits();
  const labels = usePages(bookId, book?.parts);
  const stack = useRef<OpStack>(emptyStack());
  const searchRef = useRef<HTMLInputElement>(null);

  const current = pinned ?? rows[index] ?? null;
  const page = spanPages[spanOffset] ?? null;
  /** Stream offset of the shown page's token 0. */
  const offset = spanPages.slice(0, spanOffset).reduce((n, p) => n + p.tokens.length, 0);

  // ---------------------------------------------------------- loading ---

  const reload = useCallback(async () => {
    if (bookId == null) return;
    try {
      const r = await isnadApi.list(bookId, filter);
      setRows(r);
      setIndex((i) => Math.min(i, Math.max(0, r.length - 1)));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [bookId, filter]);

  const reloadTable = useCallback(async () => {
    if (bookId == null) return;
    try {
      const [t, p] = await Promise.all([isnadApi.transmitters(bookId, confirmedOnly), isnadApi.persons()]);
      setTable(t);
      setPersons(p);
      setStamp((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  }, [bookId, confirmedOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void reloadTable();
  }, [reloadTable]);

  useEffect(() => {
    setBookRefs([]);
    setPinned(null);
    if (bookId == null) return;
    labApi.listPageRefs(bookId).then(setBookRefs).catch(() => {});
  }, [bookId]);

  // The current candidate's pages — start page through the later of its
  // end page and its matn's end page (spec 1.4) — and its classes.
  useEffect(() => {
    if (!current) {
      setSpanPages([]);
      setSpanOffset(0);
      setClasses([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const refs = bookRefs.length ? bookRefs : await labApi.listPageRefs(current.book_id);
        const at = (p: number | null, g: number | null) => (p == null || g == null ? -1 : refs.findIndex((r) => r.part_index === p && r.page_id === g));
        const start = at(current.part_index, current.page_id);
        const end = Math.max(start, at(current.end_part_index, current.end_page_id), at(current.matn_end_part_index, current.matn_end_page_id));
        const wanted = start < 0 ? [{ book_id: current.book_id, part_index: current.part_index, page_id: current.page_id }] : refs.slice(start, end + 1);
        const [pages, c] = await Promise.all([
          Promise.all(wanted.map((r) => labApi.getPage(r.book_id, r.part_index, r.page_id))),
          isnadApi.classes(current.id),
        ]);
        if (alive) {
          setSpanPages(pages.filter((p): p is Page => p != null));
          setSpanOffset(0);
          setClasses(c);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [current?.id, current?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  // A jump requested from the transmitter table (fix 7): once the span's
  // pages are here, step to the page holding the span and highlight it.
  useEffect(() => {
    if (!pendingJump || !spanPages.length) return;
    let acc = 0;
    for (let k = 0; k < spanPages.length; k++) {
      const len = spanPages[k].tokens.length;
      if (pendingJump.tok_start < acc + len || k === spanPages.length - 1) {
        setSpanOffset(k);
        setHighlight([pendingJump.tok_start - acc, pendingJump.tok_end - acc]);
        break;
      }
      acc += len;
    }
    setPendingJump(null);
  }, [pendingJump, spanPages]);

  useEffect(() => {
    let un: (() => void) | undefined;
    isnadApi
      .onRunProgress((p) => {
        setProgress(p);
        // Rows as their pages finish (spec 1.5 G): the list fills while the
        // run goes, so confirming can start before it ends.
        if (p.rows?.length) setRows((rs) => [...rs, ...p.rows]);
      })
      .then((u) => (un = u))
      .catch(() => {});
    // The extraction parameters persist in lab_setting (spec 1.4, fix 9).
    labApi
      .getSetting(ISNAD_SETTING_KEY)
      .then((v) => {
        if (!v) return;
        try {
          const p = { ...DEFAULT_PARAMS, ...(JSON.parse(v) as Partial<Params>) };
          setParams(p);
          setDraft(p);
        } catch {
          /* a bad setting is ignored */
        }
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  const applySettings = async () => {
    const clean: Params = {
      ...draft,
      min_links: Math.max(1, Math.round(draft.min_links) || DEFAULT_PARAMS.min_links),
      lookahead: Math.min(5, Math.max(2, Math.round(draft.lookahead) || DEFAULT_PARAMS.lookahead)),
      groups: draft.groups.length ? draft.groups : DEFAULT_PARAMS.groups,
    };
    setParams(clean);
    setDraft(clean);
    setSettingsOpen(false);
    try {
      await labApi.setSetting(ISNAD_SETTING_KEY, JSON.stringify(clean));
    } catch (e) {
      setError(String(e));
    }
  };

  // ------------------------------------------------------------- run ---

  /** Ask before a run over the Settings thresholds (spec 1.5 F4). */
  const propose = async () => {
    if (bookId == null) return;
    setError(null);
    try {
      const size = await labApi.runSize(bookId, scope.span);
      if (isHeavy(size, limits)) {
        setPending({ label: scope.label, span: scope.span, pages: size.pages, tokens: size.tokens });
        return;
      }
    } catch (e) {
      // A size we cannot work out is not a reason to refuse the run.
      console.error('run_size failed', e);
    }
    void start(scope.span);
  };

  const start = async (span: PageSpan | null) => {
    if (bookId == null) return;
    setPending(null);
    setBusy(true);
    setRun$({ running: true, paused: false, cancelledAt: null });
    setError(null);
    setRows([]);
    setPinned(null);
    try {
      const s = await isnadApi.run(bookId, params, span);
      setSummary(s);
      await reload();
      await reloadTable();
      setRun$(
        s.cancelled
          ? { running: false, paused: false, cancelledAt: `${s.pages.toLocaleString()} pages read, ${s.candidates.toLocaleString()} candidates kept` }
          : IDLE_RUN
      );
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setRun$(IDLE_RUN);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const pause = (paused: boolean) => {
    setRun$((r) => ({ ...r, paused }));
    void labApi.statsPause(paused);
  };

  // ------------------------------------------------------------- ops ---

  /** Apply, then refresh the current row in place (or the whole list). */
  const doOp = useCallback(
    async (op: Op, opts: { whole?: boolean } = {}) => {
      try {
        await applyTracked(stack.current, op);
        if (opts.whole || !current) {
          await reload();
        } else {
          const fresh = await isnadApi.get(current.id).catch(() => null);
          setRows((rs) => (fresh ? rs.map((r) => (r.id === fresh.id ? fresh : r)) : rs.filter((r) => r.id !== current.id)));
        }
        await reloadTable();
        setError(null);
        onChanged?.();
      } catch (e) {
        setError(String(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, reload, reloadTable]
  );

  const undo = async () => {
    if (await undoTracked(stack.current)) {
      await reload();
      await reloadTable();
    }
  };
  const redo = async () => {
    if (await redoTracked(stack.current)) {
      await reload();
      await reloadTable();
    }
  };

  const setStatus = (status: 'confirmed' | 'rejected') => {
    if (!current) return;
    void doOp({ op: 'set_status', isnad_id: current.id, status });
  };
  const next = () => { setPinned(null); setHighlight(null); setIndex((i) => Math.min(i + 1, rows.length - 1)); };
  const prev = () => { setPinned(null); setHighlight(null); setIndex((i) => Math.max(i - 1, 0)); };

  /** Fix 7: open the reader at a transmitter's occurrence, name highlighted. */
  const jumpTo = useCallback(
    async (r: TransmitterListRow) => {
      setOccurrences(null);
      setSelectedRows([r.id]);
      const inList = rows.findIndex((x) => x.id === r.isnad_id);
      if (inList >= 0) {
        setPinned(null);
        setIndex(inList);
      } else {
        try {
          setPinned(await isnadApi.get(r.isnad_id));
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      setSelectedTransmitter(r.id);
      setPendingJump({ tok_start: r.tok_start, tok_end: r.tok_end });
    },
    [rows]
  );

  /** Fix 7: a row click — one occurrence jumps; a grouped row offers its occurrences. */
  const onRowClick = (r: TransmitterListRow) => {
    if (groupByForm) {
      const all = table.filter((x) => x.form_norm === r.form_norm);
      if (all.length > 1) {
        setOccurrences(all);
        setSelectedRows([r.id]);
        return;
      }
    }
    void jumpTo(r);
  };

  /** Fix 8: a background click or Escape in the reader clears the selection. */
  const onClearSelection = useCallback(() => {
    setSelectedTransmitter(null);
    setSelectedToken(null);
    setHighlight(null);
  }, []);

  const nudgeBoundary = (delta: number) => {
    if (!current || current.matn_tok_start == null) return;
    const start = Math.max(current.tok_start + 1, current.matn_tok_start + delta);
    void doOp({ op: 'set_matn', isnad_id: current.id, start, end: current.matn_tok_end });
  };

  const onTokenClick = (local: number) => {
    if (!current) return;
    const idx = local + offset;
    if (mode === 'matn-start') {
      void doOp({ op: 'set_matn', isnad_id: current.id, start: idx, end: current.matn_tok_end && current.matn_tok_end > idx ? current.matn_tok_end : null });
      setMode('none');
    } else if (mode === 'matn-end') {
      void doOp({ op: 'set_matn', isnad_id: current.id, start: current.matn_tok_start, end: idx + 1 });
      setMode('none');
    } else if (mode === 'split') {
      const t = current.transmitters.find((x) => x.id === selectedTransmitter);
      if (t && idx > t.tok_start && idx < t.tok_end) {
        void doOp({ op: 'split_transmitter', transmitter_id: t.id, at: idx });
      } else {
        setNotice('Click a word inside the selected transmitter to split there.');
      }
      setMode('none');
    } else {
      // Plain click: select the transmitter under it (for split/merge/link),
      // remember the token (for retag), and select its row on the right,
      // scrolled into view (fix 7).
      const t = current.transmitters.find((x) => idx >= x.tok_start && idx < x.tok_end);
      setSelectedTransmitter(t ? t.id : null);
      setSelectedToken(idx);
      if (t) {
        setSelectedRows([t.id]);
        setScrollToRow(t.id);
      }
    }
  };
  const [scrollToRow, setScrollToRow] = useState<number | null>(null);

  /** Clear whatever this word was retagged as (10 A). */
  const removeTag = async () => {
    if (!current || selectedToken == null) return;
    await doOp({ op: 'retag', isnad_id: current.id, tok: selectedToken, class: null });
  };

  const retag = async (cls: TokenClass) => {
    if (!current || selectedToken == null) return;
    await doOp({ op: 'retag', isnad_id: current.id, tok: selectedToken, class: cls });
    setMode('none');
    // The "add to lexicon" offer at three (spec §7.4).
    try {
      const counts = await isnadApi.retagCounts(current.book_id);
      const hit = counts.find(([, c, n]) => c === cls && n >= 3 && (cls === 'verb' || cls === 'formula'));
      setRetagOffer(hit ?? null);
    } catch {
      /* the offer is optional */
    }
  };

  const addToLexicon = async () => {
    if (!retagOffer) return;
    const [word, cls] = retagOffer;
    try {
      await isnadApi.lexiconAdd(cls === 'verb' ? 'transmission' : 'formula', cls === 'verb' ? 'core' : null, [word]);
      setNotice(`Added ${word} to the ${cls === 'verb' ? 'transmission' : 'formula'} lexicon. It applies on the next extraction run.`);
      setRetagOffer(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const mergeTransmitters = () => {
    if (!current || selectedTransmitter == null) return;
    const i = current.transmitters.findIndex((t) => t.id === selectedTransmitter);
    const right = current.transmitters[i + 1];
    if (i < 0 || !right) {
      setNotice('Select a transmitter that has a neighbour to its right.');
      return;
    }
    void doOp({ op: 'merge_transmitters', left_id: selectedTransmitter, right_id: right.id });
  };

  // ------------------------------------------------- transmitter table ---

  // --------------------------------------------------------- keyboard ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        void undo();
        return;
      }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        void redo();
        return;
      }
      if (typing) return;
      if (mode === 'retag' && CLASS_KEYS[e.key]) {
        void retag(CLASS_KEYS[e.key]);
        return;
      }
      switch (e.key) {
        case 'c': setStatus('confirmed'); break;
        case 'x': setStatus('rejected'); break;
        case 'j': next(); break;
        case 'k': prev(); break;
        case 'm': mergeTransmitters(); break;
        case 'b': setMode('matn-start'); break;
        case 'e': setMode('matn-end'); break;
        case '[': nudgeBoundary(-1); break;
        case ']': nudgeBoundary(1); break;
        case 's': setMode('split'); break;
        case 'r': setMode('retag'); break;
        case 'g': setGroupByForm((v) => !v); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case 'Escape': setMode('none'); setPersonMenu(null); setOccurrences(null); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------- render ---

  const layers = useMemo(() => (current ? layersFor(current, classes, offset) : new Map()), [current, classes, offset]);
  const transmitterIndex = useMemo(() => {
    const m = new Map<number, number>();
    current?.transmitters.forEach((t, i) => {
      for (let x = t.tok_start; x < t.tok_end; x++) m.set(x - offset, i);
    });
    return m;
  }, [current, offset]);
  const multiPage = current ? spansPages(current) || spanPages.length > 1 : false;

  const layerClass = useCallback(
    (idx: number) => {
      const l = layers.get(idx);
      if (!l) return null;
      if (l === 'transmitter') {
        const i = transmitterIndex.get(idx) ?? 0;
        const t = current?.transmitters[i];
        return `lay-t${i % 6}${t && t.id === selectedTransmitter ? ' lay-t-selected' : ''}${mode === 'split' && t && t.id === selectedTransmitter ? ' lay-split-pick' : ''}`;
      }
      return `lay-${l}`;
    },
    [layers, transmitterIndex, current, selectedTransmitter, mode]
  );

  const shownTable = useMemo(() => {
    const needle = normalizeArabic(search).trim();
    let rows = needle ? table.filter((r) => r.form_norm.includes(needle) || (r.person_name ?? '').includes(needle)) : table;
    if (groupByForm) {
      const seen = new Map<string, TransmitterListRow>();
      for (const r of rows) if (!seen.has(r.form_norm)) seen.set(r.form_norm, r);
      rows = [...seen.values()];
    }
    return rows;
  }, [table, search, groupByForm]);

  const tableColumns: Column<TransmitterListRow>[] = [
    { key: 'raw', label: 'Form', sortValue: (r) => r.raw, rtl: true, width: 'minmax(160px, 3fr)', render: (r) => <span className={selectedRows.includes(r.id) ? 'font-semibold' : ''}>{r.raw}</span> },
    { key: 'parts', label: 'Parsed', sortValue: (r) => [r.kunya, r.ism, r.nasab, r.nisba].filter(Boolean).join(' · '), rtl: true, width: '3fr', render: (r) => [r.kunya && `ك:${r.kunya}`, r.ism && `ا:${r.ism}`, r.nasab, r.nisba && `ن:${r.nisba}`, r.laqab && `ل:${r.laqab}`].filter(Boolean).join(' · ') },
    { key: 'count', label: '#', sortValue: (r) => r.form_count, align: 'right', width: '48px', render: (r) => fmt(r.form_count) },
    { key: 'person', label: 'Person', sortValue: (r) => r.person_name ?? r.suggested_person_name ?? '', rtl: true, width: '2fr', render: (r) => r.person_name ? <span>{r.person_name}</span> : r.suggested_person_name ? <span className="border border-dashed border-app-accent text-app-accent px-1 rounded" title="Suggested from a matching form; not linked">{r.suggested_person_name}?</span> : <span className="text-app-text-secondary">—</span> },
    { key: 'where', label: 'Page', sortValue: (r) => r.part_index * 1_000_000 + r.page_id, width: '70px', render: (r) => labels.label(r.part_index, r.page_id) },
  ];

  const conf: Confidence | null = current ? safeConf(current.confidence_json) : null;

  if (!book) {
    return <div className="p-6 text-sm text-app-text-secondary">Open a text from the workspace first.</div>;
  }

  if (disambiguating) {
    return (
      <Disambiguator
        book={book}
        labels={labels}
        version={stamp}
        onOp={async (op) => {
          await doOp(op, { whole: true });
        }}
        onOpen={(isnadId, transmitterId) => {
          setDisambiguating(false);
          void jumpTo({ id: transmitterId, isnad_id: isnadId } as TransmitterListRow);
        }}
        onClose={() => setDisambiguating(false)}
      />
    );
  }

  return (
    <div className="flex-1 min-w-0 flex min-h-0" data-testid="isnad-panel">
      {/* ------------------------------------------------ left: the text --- */}
      <section className="flex-1 min-w-0 flex flex-col border-r border-app-border-light">
        <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
          <button onClick={() => void propose()} disabled={busy} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
            {busy ? 'Extracting…' : 'Extract isnāds'}
          </button>
          <ScopePicker bookId={bookId} onChange={setScope} disabled={busy} />
          <GearButton onClick={() => { setDraft(params); setSettingsOpen(true); }} label="Extraction settings" />
          {summary && (
            <span className="text-app-text-secondary" data-testid="run-summary">
              {summary.candidates.toLocaleString()} candidates on {summary.pages.toLocaleString()} pages in {(summary.elapsed_ms / 1000).toFixed(1)} s
              {summary.kept_confirmed > 0 && ` · ${summary.kept_confirmed} decided rows kept`}
            </span>
          )}
        </div>

        <RunBar
          run={run$}
          done={progress?.done ?? 0}
          total={progress?.total ?? 0}
          found={progress?.found}
          foundLabel="found"
          estimateMs={progress?.estimate_ms ?? null}
          onPause={pause}
          onCancel={() => labApi.statsCancel()}
        />

        <div className="px-3 py-1.5 border-b border-app-border-light bg-app-surface-variant flex items-center gap-2 flex-wrap text-xs" data-testid="filter-bar">
          <select aria-label="Status" value={filter.status ?? ''} onChange={(e) => setFilter({ ...filter, status: (e.target.value || null) as IsnadFilter['status'] })} className="border border-app-border-medium rounded px-1">
            <option value="">any status</option>
            <option value="candidate">candidate</option>
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
            <option value="orphaned">orphaned</option>
          </select>
          <select aria-label="Kind" value={filter.kind ?? ''} onChange={(e) => setFilter({ ...filter, kind: (e.target.value || null) as IsnadFilter['kind'] })} className="border border-app-border-medium rounded px-1">
            <option value="">isnād + citation</option>
            <option value="isnad">isnād</option>
            <option value="citation">citation</option>
          </select>
          <label className="flex items-center gap-1">
            min conf
            <input type="number" step={0.05} min={0} max={1} value={filter.min_confidence ?? 0} onChange={(e) => setFilter({ ...filter, min_confidence: Number(e.target.value) })} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min confidence" />
          </label>
          <label className="flex items-center gap-1">
            min links
            <input type="number" min={1} value={filter.min_links ?? 1} onChange={(e) => setFilter({ ...filter, min_links: Math.max(1, Number(e.target.value) || 1) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Filter min links" />
          </label>
          <label className="flex items-center gap-1">
            pages
            <input type="number" min={0} placeholder="from" value={filter.page_from ?? ''} onChange={(e) => setFilter({ ...filter, page_from: e.target.value === '' ? null : Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Page from" />
            <input type="number" min={0} placeholder="to" value={filter.page_to ?? ''} onChange={(e) => setFilter({ ...filter, page_to: e.target.value === '' ? null : Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Page to" />
          </label>
          <span className="text-app-text-secondary ml-auto" data-testid="candidate-count">
            {rows.length ? `${index + 1} / ${rows.length}` : 'no candidates'}
          </span>
        </div>

        {current && (
          <div className="px-3 py-2 border-b border-app-border-light bg-app-surface text-sm" data-testid="chain-view">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-1.5 rounded text-xs ${current.status === 'confirmed' ? 'bg-app-highlight-lemma' : current.status === 'rejected' ? 'bg-red-100' : 'bg-app-surface-variant'}`}>{current.status}</span>
              <span className="text-xs text-app-text-secondary">
                {current.kind} · {current.links} links · {labels.label(current.part_index, current.page_id)}
                {multiPage && current.end_page_id != null && ` → ${labels.label(current.end_part_index ?? current.part_index, current.end_page_id)}`}
                {pinned && ' · opened from the table'}
              </span>
              <span className="text-xs" title={conf ? `links ${conf.links.toFixed(2)} · noun_prop ${conf.noun_prop.toFixed(2)} · terminal ${conf.terminal.toFixed(0)} · clean ${conf.clean.toFixed(2)}` : ''} data-testid="confidence">
                confidence {current.confidence.toFixed(2)}
                {conf && <span className="text-app-text-secondary"> (why: links {conf.links.toFixed(2)}, noun_prop {conf.noun_prop.toFixed(2)}, terminal {conf.terminal.toFixed(0)}, clean {conf.clean.toFixed(2)})</span>}
              </span>
            </div>
            <div className="font-arabic text-lg mt-1 flex flex-wrap gap-x-2 items-baseline" dir="rtl" data-testid="structured-chain">
              {current.transmitters.map((t, i) => (
                <span key={t.id} className="flex items-baseline gap-1">
                  <span className="text-xs text-app-text-secondary font-ui" dir="ltr">[{t.verb_before ?? '—'}]</span>
                  <button onClick={() => setSelectedTransmitter(t.id)} className={`lay-t${i % 6} px-1 rounded ${t.id === selectedTransmitter ? 'lay-t-selected' : ''}`} title={[t.kunya, t.ism, t.nasab, t.nisba, t.laqab, t.place && `place: ${t.place}`].filter(Boolean).join(' · ')}>
                    {t.raw}
                    {t.place && <span className="text-xs text-app-text-secondary"> ({t.place})</span>}
                  </button>
                  {i < current.transmitters.length - 1 && <span className="text-app-text-secondary">←</span>}
                </span>
              ))}
              {current.matn_tok_start != null && spanPages.length > 0 && (
                <span className="text-app-text-secondary">
                  ← <span className="lay-matn px-1">{spanPages.flatMap((p) => p.tokens).slice(current.matn_tok_start, Math.min(current.matn_tok_end ?? current.matn_tok_start + 12, current.matn_tok_start + 12)).map((t) => t.surface).join(' ')}…</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-2 flex-wrap text-xs">
              <button onClick={() => setStatus('confirmed')} className="px-2 py-0.5 border border-app-border-medium rounded hover:bg-app-highlight-lemma">Confirm (c)</button>
              <button onClick={() => setStatus('rejected')} className="px-2 py-0.5 border border-app-border-medium rounded hover:bg-red-100">Reject (x)</button>
              <button onClick={prev} disabled={index === 0} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">‹ Prev (k)</button>
              <button onClick={next} disabled={index >= rows.length - 1} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Next (j) ›</button>
              <span className="mx-1 text-app-border-medium">|</span>
              <button onClick={() => setMode(mode === 'matn-start' ? 'none' : 'matn-start')} className={`px-2 py-0.5 border rounded ${mode === 'matn-start' ? 'bg-app-accent text-white' : 'border-app-border-medium'}`}>Matn starts at… (b)</button>
              <button onClick={() => setMode(mode === 'matn-end' ? 'none' : 'matn-end')} className={`px-2 py-0.5 border rounded ${mode === 'matn-end' ? 'bg-app-accent text-white' : 'border-app-border-medium'}`}>Matn ends at… (e)</button>
              <button onClick={() => nudgeBoundary(-1)} className="px-2 py-0.5 border border-app-border-medium rounded" title="Move the isnād/matn boundary one word left">[</button>
              <button onClick={() => nudgeBoundary(1)} className="px-2 py-0.5 border border-app-border-medium rounded" title="Move the boundary one word right">]</button>
              <span className="mx-1 text-app-border-medium">|</span>
              <button onClick={() => setMode(mode === 'split' ? 'none' : 'split')} disabled={selectedTransmitter == null} className={`px-2 py-0.5 border rounded disabled:opacity-40 ${mode === 'split' ? 'bg-app-accent text-white' : 'border-app-border-medium'}`}>Split (s)</button>
              <button onClick={mergeTransmitters} disabled={selectedTransmitter == null} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Merge → (m)</button>
              <button onClick={() => setMode(mode === 'retag' ? 'none' : 'retag')} disabled={selectedToken == null} className={`px-2 py-0.5 border rounded disabled:opacity-40 ${mode === 'retag' ? 'bg-app-accent text-white' : 'border-app-border-medium'}`}>Retag (r)</button>
              {mode === 'retag' && (
                <span className="flex gap-1">
                  {(['verb', 'name', 'formula', 'other'] as TokenClass[]).map((c) => (
                    <button key={c} onClick={() => retag(c)} className="px-2 py-0.5 border border-app-border-medium rounded">{c} ({c[0]})</button>
                  ))}
                  {/* A retag has to be undoable in place, not only through the
                      undo stack: clearing it puts the word back as extracted. */}
                  <button onClick={() => removeTag()} className="px-2 py-0.5 border border-app-border-medium rounded" data-testid="remove-tag">
                    Remove tag
                  </button>
                </span>
              )}
              {retagOffer && (
                <button onClick={addToLexicon} className="px-2 py-0.5 border border-app-accent text-app-accent rounded" data-testid="lexicon-offer">
                  Add “{retagOffer[0]}” to the lexicon as {retagOffer[1]} ({retagOffer[2]}× retagged)
                </button>
              )}
              {mode !== 'none' && <span className="text-app-accent">mode: {mode} — click a word, Esc to leave</span>}
            </div>
          </div>
        )}

        <SettingsModal title="Isnād extraction" open={settingsOpen} onClose={() => setSettingsOpen(false)} onApply={() => void applySettings()} onReset={() => setDraft(DEFAULT_PARAMS)}>
          <label className="flex items-center justify-between gap-2">
            <span title="Links an isnād needs (spec §4.2: 2; a citation needs 1)">Minimum links</span>
            <input type="number" min={1} max={10} value={draft.min_links} onChange={(e) => setDraft({ ...draft, min_links: Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Min links" />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span title="Tokens the boundary lookahead inspects (spec §4.2: 3; 2–5)">Lookahead</span>
            <input type="number" min={2} max={5} value={draft.lookahead} onChange={(e) => setDraft({ ...draft, lookahead: Number(e.target.value) })} className="w-16 border border-app-border-medium rounded px-1" aria-label="Lookahead" />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span title="Transmission-lexicon groups in play (spec §4.2)">Lexicon groups</span>
            <span className="flex gap-2">
              {(['core', 'history', 'written', 'citation'] as Group[]).map((g) => (
                <label key={g} className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.groups.includes(g)} onChange={(e) => setDraft({ ...draft, groups: e.target.checked ? [...draft.groups, g] : draft.groups.filter((x) => x !== g) })} aria-label={`Group ${g}`} />
                  {g}
                </label>
              ))}
            </span>
          </div>
          <p className="text-xs text-app-text-secondary">Defaults are the spec's (§4.2). Applied to the next extraction; kept between sessions.</p>
        </SettingsModal>

        <HeavyRunModal
          open={!!pending}
          what={`Extract isnāds from ${pending?.label ?? ''}`}
          pages={pending?.pages ?? 0}
          tokens={pending?.tokens ?? 0}
          onContinue={() => pending && void start(pending.span)}
          onCancel={() => setPending(null)}
        />
        {notice && (
          <div className="px-3 py-1 text-xs text-app-text-secondary bg-app-surface-variant border-b border-app-border-light flex justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        {error && (
          <div className="px-3 py-1 text-xs text-app-error" role="alert">{error}</div>
        )}

        {multiPage && spanPages.length > 1 && (
          <div className="px-3 py-1 text-xs bg-app-accent-light border-b border-app-border-light flex items-center gap-2" data-testid="span-pages">
            <span>This isnād runs over {spanPages.length} pages — showing page {spanOffset + 1} of {spanPages.length} ({page ? labels.label(page.part_index, page.page_id) : '—'}).</span>
            <button onClick={() => setSpanOffset((k) => Math.max(0, k - 1))} disabled={spanOffset === 0} className="px-2 border border-app-border-medium rounded disabled:opacity-40">‹ previous page</button>
            <button onClick={() => setSpanOffset((k) => Math.min(spanPages.length - 1, k + 1))} disabled={spanOffset >= spanPages.length - 1} className="px-2 border border-app-border-medium rounded disabled:opacity-40">next page ›</button>
            {spanOffset < spanPages.length - 1 && <span className="text-app-text-secondary">⤵ continues on the next page</span>}
            {spanOffset > 0 && <span className="text-app-text-secondary">⤴ continued from the previous page</span>}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Reader page={page} pages={[]} index={0} onNavigate={() => {}} highlight={highlight} layerClass={layerClass} onTokenClick={onTokenClick} onClearSelection={onClearSelection} loading={false} error={null} />
        </div>
      </section>

      {/* -------------------------------------------- right: transmitters --- */}
      <aside className="w-[38rem] flex flex-col min-h-0 bg-app-surface">
        <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2 flex-wrap text-xs">
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names… (/)" aria-label="Search transmitters" dir="auto" className="input-bilingual px-2 py-1 border border-app-border-medium rounded-lg font-arabic text-lg w-48" />
          <label className="flex items-center gap-1"><input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} /> confirmed only</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={groupByForm} onChange={(e) => setGroupByForm(e.target.checked)} /> group by form (g)</label>
          <span className="text-app-text-secondary" data-testid="table-count">{shownTable.length.toLocaleString()} rows</span>
        </div>
        <div className="px-3 py-1.5 border-b border-app-border-light flex items-center gap-1 flex-wrap text-xs">
          <button onClick={() => setDisambiguating(true)} className="px-2 py-0.5 border border-app-border-medium rounded" data-testid="open-disambiguator">
            Name disambiguator
          </button>
          <button onClick={() => { const r = table.find((x) => x.id === selectedRows[0]); if (r?.person_id != null) setPersonMenu(r.person_id); else setNotice('Select a linked row.'); }} disabled={selectedRows.length !== 1} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Person… (p)</button>
          <span className="ml-auto flex gap-1">
            <button onClick={undo} className="px-2 py-0.5 border border-app-border-medium rounded">Undo</button>
            <button onClick={redo} className="px-2 py-0.5 border border-app-border-medium rounded">Redo</button>
            <ExportIsnads bookId={book.id} />
          </span>
        </div>

        {personMenu != null && (
          <PersonEditor person={persons.find((p) => p.id === personMenu) ?? null} table={table} labels={labels} onClose={() => setPersonMenu(null)} onOp={(op) => doOp(op, { whole: true })} />
        )}

        {occurrences && (
          <div className="px-3 py-2 border-b border-app-border-light bg-app-accent-light text-xs" data-testid="occurrences">
            <div className="mb-1 flex items-center">
              <span className="font-arabic" dir="rtl">{occurrences[0].raw}</span>
              <span className="ml-2 text-app-text-secondary">{occurrences.length} occurrences — choose one</span>
              <button onClick={() => setOccurrences(null)} className="ml-auto">×</button>
            </div>
            <ul className="max-h-32 overflow-y-auto">
              {occurrences.map((o) => (
                <li key={o.id}>
                  <button onClick={() => void jumpTo(o)} className="text-app-accent underline">
                    {labels.label(o.part_index, o.page_id)} · [{o.tok_start}–{o.tok_end}) · {o.isnad_status}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          <VirtualTable
            columns={tableColumns}
            rows={shownTable}
            rowKey={(r) => r.id}
            height={640}
            onRowClick={onRowClick}
            onRowCtrlClick={(r) => setSelectedRows((sel) => (sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel.slice(-1), r.id]))}
            scrollToKey={scrollToRow}
            emptyText={table.length ? 'No transmitter matches.' : 'Run the extractor to fill this table.'}
            testId="transmitter-table"
          />
        </div>
      </aside>
    </div>
  );
}

function safeConf(json: string): Confidence | null {
  try {
    return JSON.parse(json) as Confidence;
  } catch {
    return null;
  }
}

/** Rename, death year, notes, split (spec §7.4 "Right-click a person"). */
function PersonEditor({ person, table, labels, onClose, onOp }: { person: PersonRow | null; table: TransmitterListRow[]; labels: Pages; onClose: () => void; onOp: (op: Op) => Promise<void> }) {
  const [name, setName] = useState(person?.canonical_name ?? '');
  const [death, setDeath] = useState(person?.death_ah?.toString() ?? '');
  const [notes, setNotes] = useState(person?.notes ?? '');
  const [splitIds, setSplitIds] = useState<number[]>([]);
  const [splitName, setSplitName] = useState('');
  if (!person) return null;
  const mine = table.filter((t) => t.person_id === person.id);
  return (
    <div className="px-3 py-2 border-b border-app-border-light bg-app-surface-variant text-xs space-y-2" data-testid="person-editor">
      <div className="flex items-center gap-2">
        <strong className="font-arabic text-base" dir="rtl">{person.canonical_name}</strong>
        <span className="text-app-text-secondary">{person.linked} linked · {person.forms.length} forms</span>
        <button onClick={onClose} className="ml-auto">×</button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Canonical name" dir="rtl" className="px-2 py-1 border border-app-border-medium rounded font-arabic w-56" />
        <button onClick={() => onOp({ op: 'rename_person', person_id: person.id, canonical_name: name })} className="px-2 py-0.5 border border-app-border-medium rounded">Rename</button>
        <input value={death} onChange={(e) => setDeath(e.target.value)} placeholder="d. AH" aria-label="Death year" className="px-2 py-1 border border-app-border-medium rounded w-20" />
        <button onClick={() => onOp({ op: 'set_death', person_id: person.id, death_ah: death.trim() === '' ? null : Number(death) })} className="px-2 py-0.5 border border-app-border-medium rounded">Set death year</button>
      </div>
      <div className="flex items-center gap-2">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="notes" aria-label="Notes" className="px-2 py-1 border border-app-border-medium rounded flex-1" />
        <button onClick={() => onOp({ op: 'set_notes', person_id: person.id, notes: notes || null })} className="px-2 py-0.5 border border-app-border-medium rounded">Save notes</button>
      </div>
      <div>
        <div className="mb-1">Forms: {person.forms.map((f) => <span key={f.id} className="font-arabic mr-2" dir="rtl">{f.form}</span>)}</div>
        <div className="mb-1">Split off:</div>
        <div className="flex flex-wrap gap-1 mb-1">
          {mine.map((t) => (
            <label key={t.id} className="font-arabic flex items-center gap-1" dir="rtl">
              <input type="checkbox" checked={splitIds.includes(t.id)} onChange={(e) => setSplitIds(e.target.checked ? [...splitIds, t.id] : splitIds.filter((x) => x !== t.id))} />
              {t.raw} <span className="text-app-text-secondary font-ui" dir="ltr">{labels.label(t.part_index, t.page_id)}</span>
            </label>
          ))}
        </div>
        <input value={splitName} onChange={(e) => setSplitName(e.target.value)} placeholder="new person's name" aria-label="New person name" dir="rtl" className="px-2 py-1 border border-app-border-medium rounded font-arabic w-56 mr-2" />
        <button disabled={!splitIds.length || !splitName.trim()} onClick={() => onOp({ op: 'split_person', person_id: person.id, transmitter_ids: splitIds, canonical_name: splitName.trim() })} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Split</button>
      </div>
    </div>
  );
}

/** Isnād and authority exports (§6.6). */
function ExportIsnads({ bookId }: { bookId: number }) {
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (name: string, contents: string) => {
    try {
      const path = await labApi.saveExport(name, contents);
      setMsg(`Saved ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const run = async (what: 'flat-csv' | 'nested-json' | 'authority-csv' | 'authority-json') => {
    try {
      switch (what) {
        case 'flat-csv': await save(`book${bookId}-isnads-flat.csv`, await isnadApi.exportIsnads(bookId, 'csv', 'flat')); break;
        case 'nested-json': await save(`book${bookId}-isnads-nested.json`, await isnadApi.exportIsnads(bookId, 'json', 'nested')); break;
        case 'authority-csv': await save('authority.csv', await isnadApi.exportAuthority('csv')); break;
        case 'authority-json': await save('authority.json', await isnadApi.exportAuthority('json')); break;
      }
    } catch (e) {
      setMsg(String(e));
    }
  };
  return (
    <span className="flex items-center gap-1">
      <select aria-label="Export" defaultValue="" onChange={(e) => { const v = e.target.value as Parameters<typeof run>[0] | ''; if (v) void run(v); e.target.value = ''; }} className="border border-app-border-medium rounded px-1">
        <option value="">Export…</option>
        <option value="flat-csv">isnāds, one row per transmitter (CSV)</option>
        <option value="nested-json">isnāds, nested (JSON)</option>
        <option value="authority-csv">authority file (CSV)</option>
        <option value="authority-json">authority file (JSON)</option>
      </select>
      {msg && <span className="text-app-text-secondary truncate max-w-[12rem]" title={msg}>{msg}</span>}
    </span>
  );
}

