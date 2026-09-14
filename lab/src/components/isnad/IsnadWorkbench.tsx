import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi, type Page } from '../../api/lab';
import {
  applyTracked,
  DEFAULT_PARAMS,
  emptyStack,
  isnadApi,
  layersFor,
  redoTracked,
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
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';

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

export function IsnadWorkbench({ book }: { book: BookMetadata | null }) {
  const bookId = book?.id ?? null;
  const [rows, setRows] = useState<IsnadRow[]>([]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [classes, setClasses] = useState<[number, TokenClass][]>([]);
  const [filter, setFilter] = useState<IsnadFilter>({ status: 'candidate', min_confidence: 0.2 });
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('none');
  const [selectedTransmitter, setSelectedTransmitter] = useState<number | null>(null);
  const [selectedToken, setSelectedToken] = useState<number | null>(null);
  const [retagOffer, setRetagOffer] = useState<[string, TokenClass, number] | null>(null);
  const [table, setTable] = useState<TransmitterListRow[]>([]);
  const [persons, setPersons] = useState<PersonRow[]>([]);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [groupByForm, setGroupByForm] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [personMenu, setPersonMenu] = useState<number | null>(null);
  const [pendingSuggestions, setPendingSuggestions] = useState<Op[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stack = useRef<OpStack>(emptyStack());
  const searchRef = useRef<HTMLInputElement>(null);

  const current = rows[index] ?? null;

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

  // The current candidate's page and classes.
  useEffect(() => {
    if (!current) {
      setPage(null);
      setClasses([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const [p, c] = await Promise.all([
          labApi.getPage(current.book_id, current.part_index, current.page_id),
          isnadApi.classes(current.id),
        ]);
        if (alive) {
          setPage(p);
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

  useEffect(() => {
    let un: (() => void) | undefined;
    isnadApi.onRunProgress((p) => setProgress(p)).then((u) => (un = u)).catch(() => {});
    return () => un?.();
  }, []);

  // ------------------------------------------------------------- run ---

  const run = async () => {
    if (bookId == null) return;
    setBusy(true);
    setError(null);
    try {
      const s = await isnadApi.run(bookId, params);
      setSummary(s);
      await reload();
      await reloadTable();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
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
      } catch (e) {
        setError(String(e));
      }
    },
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
  const next = () => setIndex((i) => Math.min(i + 1, rows.length - 1));
  const prev = () => setIndex((i) => Math.max(i - 1, 0));

  const nudgeBoundary = (delta: number) => {
    if (!current || current.matn_tok_start == null) return;
    const start = Math.max(current.tok_start + 1, current.matn_tok_start + delta);
    void doOp({ op: 'set_matn', isnad_id: current.id, start, end: current.matn_tok_end });
  };

  const onTokenClick = (idx: number) => {
    if (!current) return;
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
      // and remember the token (for retag).
      const t = current.transmitters.find((x) => idx >= x.tok_start && idx < x.tok_end);
      setSelectedTransmitter(t ? t.id : null);
      setSelectedToken(idx);
    }
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

  const link = () => {
    if (selectedTransmitter == null) {
      setNotice('Select a transmitter in the text first.');
      return;
    }
    const row = table.find((r) => r.id === selectedRows[0]);
    if (!row) {
      setNotice('Select a row on the right: a linked one to reuse its person, or an unlinked one to create a person from it.');
      return;
    }
    if (row.person_id != null) {
      void doOp({ op: 'link', transmitter_id: selectedTransmitter, person_id: row.person_id });
    } else if (row.id === selectedTransmitter) {
      void doOp({ op: 'link_new', transmitter_id: selectedTransmitter, canonical_name: null });
    } else {
      // Create a person from the row, then link both.
      void (async () => {
        const r = await applyTracked(stack.current, { op: 'link_new', transmitter_id: row.id, canonical_name: null });
        const pid = r.inverse.op === 'delete_person' ? r.inverse.person_id : null;
        if (pid != null) await applyTracked(stack.current, { op: 'link', transmitter_id: selectedTransmitter, person_id: pid });
        await reload();
        await reloadTable();
      })();
    }
  };

  const samePerson = () => {
    const [a, b] = selectedRows.map((id) => table.find((r) => r.id === id));
    if (!a || !b) {
      setNotice('Select two rows to declare them the same person.');
      return;
    }
    if (a.person_id != null && b.person_id != null && a.person_id !== b.person_id) {
      const pa = persons.find((p) => p.id === a.person_id);
      const pb = persons.find((p) => p.id === b.person_id);
      if (window.confirm(`Merge ${pb?.canonical_name} (${pb?.forms.length} forms) into ${pa?.canonical_name} (${pa?.forms.length} forms)?`)) {
        void doOp({ op: 'merge_persons', into: a.person_id, from: b.person_id }, { whole: true });
      }
    } else if (a.person_id != null) {
      void doOp({ op: 'link', transmitter_id: b.id, person_id: a.person_id });
    } else if (b.person_id != null) {
      void doOp({ op: 'link', transmitter_id: a.id, person_id: b.person_id });
    } else {
      void (async () => {
        const r = await applyTracked(stack.current, { op: 'link_new', transmitter_id: a.id, canonical_name: null });
        const pid = r.inverse.op === 'delete_person' ? r.inverse.person_id : null;
        if (pid != null) await applyTracked(stack.current, { op: 'link', transmitter_id: b.id, person_id: pid });
        await reloadTable();
      })();
    }
  };

  const acceptSuggestions = async () => {
    if (!current) return;
    try {
      const ops = await isnadApi.suggestionsForPage(current.book_id, current.part_index, current.page_id);
      if (ops.length === 0) {
        setNotice('No suggestions on this page.');
        return;
      }
      setPendingSuggestions(ops);
    } catch (e) {
      setError(String(e));
    }
  };

  const applySuggestions = () => {
    if (!pendingSuggestions) return;
    void doOp({ op: 'batch', ops: pendingSuggestions });
    setPendingSuggestions(null);
  };

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
        case 'l': link(); break;
        case 'm': selectedRows.length === 2 ? samePerson() : mergeTransmitters(); break;
        case 'b': setMode('matn-start'); break;
        case 'e': setMode('matn-end'); break;
        case '[': nudgeBoundary(-1); break;
        case ']': nudgeBoundary(1); break;
        case 's': setMode('split'); break;
        case 'r': setMode('retag'); break;
        case 'a': void acceptSuggestions(); break;
        case 'g': setGroupByForm((v) => !v); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case 'Escape': setMode('none'); setPersonMenu(null); setPendingSuggestions(null); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------- render ---

  const layers = useMemo(() => (current ? layersFor(current, classes) : new Map()), [current, classes]);
  const transmitterIndex = useMemo(() => {
    const m = new Map<number, number>();
    current?.transmitters.forEach((t, i) => {
      for (let x = t.tok_start; x < t.tok_end; x++) m.set(x, i);
    });
    return m;
  }, [current]);

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
    { key: 'person', label: 'Person', sortValue: (r) => r.person_name ?? r.suggested_person_name ?? '', rtl: true, width: '2fr', render: (r) => r.person_name ? <span>{r.person_name}</span> : r.suggested_person_name ? <span className="border border-dashed border-app-accent text-app-accent px-1 rounded" title="Suggested from a matching form; not linked">{r.suggested_person_name}?</span> : <span className="text-app-text-tertiary">—</span> },
    { key: 'where', label: 'Page', sortValue: (r) => r.page_id, width: '70px', render: (r) => `${r.part_index}:${r.page_id}` },
  ];

  const conf: Confidence | null = current ? safeConf(current.confidence_json) : null;

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Choose a book in Books first.</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------ left: the text --- */}
      <section className="flex-1 min-w-0 flex flex-col border-r border-app-border-light">
        <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
          <button onClick={run} disabled={busy} className="px-3 py-1 text-sm bg-app-accent text-white rounded disabled:opacity-40">
            {busy ? 'Extracting…' : 'Extract isnāds'}
          </button>
          <label className="flex items-center gap-1">
            min links
            <input type="number" min={1} max={10} value={params.min_links} onChange={(e) => setParams({ ...params, min_links: Math.max(1, Number(e.target.value) || 2) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Min links" />
          </label>
          <label className="flex items-center gap-1">
            lookahead
            <input type="number" min={2} max={5} value={params.lookahead} onChange={(e) => setParams({ ...params, lookahead: Math.min(5, Math.max(2, Number(e.target.value) || 3)) })} className="w-12 border border-app-border-medium rounded px-1" aria-label="Lookahead" />
          </label>
          {(['core', 'history', 'written', 'citation'] as Group[]).map((g) => (
            <label key={g} className="flex items-center gap-1">
              <input type="checkbox" checked={params.groups.includes(g)} onChange={(e) => setParams({ ...params, groups: e.target.checked ? [...params.groups, g] : params.groups.filter((x) => x !== g) })} />
              {g}
            </label>
          ))}
          {summary && (
            <span className="text-app-text-tertiary" data-testid="run-summary">
              {summary.candidates.toLocaleString()} candidates on {summary.pages.toLocaleString()} pages in {(summary.elapsed_ms / 1000).toFixed(1)} s
              {summary.kept_confirmed > 0 && ` · ${summary.kept_confirmed} decided rows kept`}
            </span>
          )}
          {progress && (
            <span className="text-app-text-secondary" role="status">
              page {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {progress.found.toLocaleString()} found
              <button onClick={() => labApi.statsCancel()} className="ml-2 px-2 border border-app-border-medium rounded">Cancel</button>
            </span>
          )}
        </div>

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
          <span className="text-app-text-tertiary ml-auto" data-testid="candidate-count">
            {rows.length ? `${index + 1} / ${rows.length}` : 'no candidates'}
          </span>
        </div>

        {current && (
          <div className="px-3 py-2 border-b border-app-border-light bg-app-surface text-sm" data-testid="chain-view">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-1.5 rounded text-xs ${current.status === 'confirmed' ? 'bg-app-highlight-lemma' : current.status === 'rejected' ? 'bg-red-100' : 'bg-app-surface-variant'}`}>{current.status}</span>
              <span className="text-xs text-app-text-tertiary">{current.kind} · {current.links} links · {current.part_index}:{current.page_id}</span>
              <span className="text-xs" title={conf ? `links ${conf.links.toFixed(2)} · noun_prop ${conf.noun_prop.toFixed(2)} · terminal ${conf.terminal.toFixed(0)} · clean ${conf.clean.toFixed(2)}` : ''} data-testid="confidence">
                confidence {current.confidence.toFixed(2)}
                {conf && <span className="text-app-text-tertiary"> (why: links {conf.links.toFixed(2)}, noun_prop {conf.noun_prop.toFixed(2)}, terminal {conf.terminal.toFixed(0)}, clean {conf.clean.toFixed(2)})</span>}
              </span>
            </div>
            <div className="font-arabic text-lg mt-1 flex flex-wrap gap-x-2 items-baseline" dir="rtl" data-testid="structured-chain">
              {current.transmitters.map((t, i) => (
                <span key={t.id} className="flex items-baseline gap-1">
                  <span className="text-xs text-app-text-tertiary font-ui" dir="ltr">[{t.verb_before ?? '—'}]</span>
                  <button onClick={() => setSelectedTransmitter(t.id)} className={`lay-t${i % 6} px-1 rounded ${t.id === selectedTransmitter ? 'lay-t-selected' : ''}`} title={[t.kunya, t.ism, t.nasab, t.nisba, t.laqab].filter(Boolean).join(' · ')}>
                    {t.raw}
                  </button>
                  {i < current.transmitters.length - 1 && <span className="text-app-text-tertiary">←</span>}
                </span>
              ))}
              {current.matn_tok_start != null && page && (
                <span className="text-app-text-secondary">
                  ← <span className="lay-matn px-1">{page.tokens.slice(current.matn_tok_start, Math.min(current.matn_tok_end ?? current.matn_tok_start + 12, current.matn_tok_start + 12)).map((t) => t.surface).join(' ')}…</span>
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

        {notice && (
          <div className="px-3 py-1 text-xs text-app-text-secondary bg-app-surface-variant border-b border-app-border-light flex justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        {error && (
          <div className="px-3 py-1 text-xs text-app-error" role="alert">{error}</div>
        )}

        <div className="flex-1 min-h-0">
          <Reader page={page} pages={[]} index={0} onNavigate={() => {}} layerClass={layerClass} onTokenClick={onTokenClick} loading={false} error={null} />
        </div>
      </section>

      {/* -------------------------------------------- right: transmitters --- */}
      <aside className="w-[38rem] flex flex-col min-h-0 bg-app-surface">
        <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2 flex-wrap text-xs">
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names… (/)" aria-label="Search transmitters" dir="rtl" className="px-2 py-1 border border-app-border-medium rounded font-arabic w-48" />
          <label className="flex items-center gap-1"><input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} /> confirmed only</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={groupByForm} onChange={(e) => setGroupByForm(e.target.checked)} /> group by form (g)</label>
          <span className="text-app-text-tertiary" data-testid="table-count">{shownTable.length.toLocaleString()} rows</span>
        </div>
        <div className="px-3 py-1.5 border-b border-app-border-light flex items-center gap-1 flex-wrap text-xs">
          <button onClick={link} className="px-2 py-0.5 border border-app-border-medium rounded">Link (l)</button>
          <button onClick={samePerson} disabled={selectedRows.length !== 2} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Same person (m)</button>
          <button onClick={acceptSuggestions} className="px-2 py-0.5 border border-app-border-medium rounded">Accept suggestions on page (a)</button>
          <button onClick={() => { const r = table.find((x) => x.id === selectedRows[0]); if (r?.person_id != null) setPersonMenu(r.person_id); else setNotice('Select a linked row.'); }} disabled={selectedRows.length !== 1} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">Person… (p)</button>
          <span className="ml-auto flex gap-1">
            <button onClick={undo} className="px-2 py-0.5 border border-app-border-medium rounded">Undo</button>
            <button onClick={redo} className="px-2 py-0.5 border border-app-border-medium rounded">Redo</button>
            <ExportIsnads bookId={book.id} />
          </span>
        </div>

        {pendingSuggestions && (
          <div className="px-3 py-2 border-b border-app-border-light bg-app-accent-light text-xs" data-testid="suggestions-review">
            <div className="mb-1">Accept {pendingSuggestions.length} suggestion{pendingSuggestions.length === 1 ? '' : 's'} on this page? One undo step.</div>
            <ul className="mb-1 max-h-24 overflow-y-auto">
              {pendingSuggestions.map((o, i) => o.op === 'link' ? (
                <li key={i} className="font-arabic" dir="rtl">
                  {table.find((t) => t.id === o.transmitter_id)?.raw ?? o.transmitter_id} → {persons.find((p) => p.id === o.person_id)?.canonical_name ?? o.person_id}
                </li>
              ) : null)}
            </ul>
            <button onClick={applySuggestions} className="px-2 py-0.5 bg-app-accent text-white rounded mr-2">Accept</button>
            <button onClick={() => setPendingSuggestions(null)} className="px-2 py-0.5 border border-app-border-medium rounded">Cancel</button>
          </div>
        )}

        {personMenu != null && (
          <PersonEditor person={persons.find((p) => p.id === personMenu) ?? null} table={table} onClose={() => setPersonMenu(null)} onOp={(op) => doOp(op, { whole: true })} />
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          <VirtualTable
            columns={tableColumns}
            rows={shownTable}
            rowKey={(r) => r.id}
            height={640}
            onRowClick={(r) => {
              setSelectedRows((sel) => (sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel.slice(-1), r.id]));
            }}
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
function PersonEditor({ person, table, onClose, onOp }: { person: PersonRow | null; table: TransmitterListRow[]; onClose: () => void; onOp: (op: Op) => Promise<void> }) {
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
        <span className="text-app-text-tertiary">{person.linked} linked · {person.forms.length} forms</span>
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
              {t.raw} <span className="text-app-text-tertiary font-ui" dir="ltr">{t.part_index}:{t.page_id}</span>
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
      {msg && <span className="text-app-text-tertiary truncate max-w-[12rem]" title={msg}>{msg}</span>}
    </span>
  );
}

