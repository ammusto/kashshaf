import { useCallback, useEffect, useState } from 'react';
import { labApi, rustErr, rustOk, type FreqStatus, type LabStatus, type Progress } from '../api/lab';
import { workspaceApi } from '../api/workspace';
import { useHeavyLimits } from '../api/settings';
import { DEFAULT_HEAVY_LIMITS } from './ui/Running';

/**
 * Settings (spec §7.8, extended by 1.5 §A2 and §F4).
 *
 * It renders in the main pane rather than as a modal — it is long, and the
 * stop list is something a reader edits while thinking — but it is reached
 * from the menu bar, not from the left rail, because it is about Lab and not
 * about the open text.
 */

export function SettingsPanel({ status }: { status: LabStatus | null }) {
  const [dirs, setDirs] = useState<Awaited<ReturnType<typeof labApi.dirs>> | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
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
    ['Table of contents', status.toc ? 'present' : (status.toc_error ?? `needs corpus ${status.min_toc_corpus_version}`)],
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
        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={() => labApi.openLabDirectory()}
            className="px-3 py-1.5 text-sm border border-app-border-medium rounded hover:bg-app-surface-variant"
          >
            Open Lab folder
          </button>
          <button
            onClick={() => workspaceApi.openFolder().then(setFolder).catch((e) => setFolder(String(e)))}
            className="px-3 py-1.5 text-sm border border-app-border-medium rounded hover:bg-app-surface-variant"
            data-testid="open-workspace-folder"
          >
            Open workspace folder
          </button>
          {folder && <span className="text-xs text-app-text-tertiary break-all">{folder}</span>}
        </div>
      </section>

      <HeavyRunSettings />
      <FreqSnapshotSettings local={status.mode === 'local'} />
      <StopwordSettings />

      <p className="text-xs text-app-text-tertiary">
        The lexicon editor, algorithm defaults and the export directory arrive with the phases that
        produce something to export.
      </p>
    </div>
  );
}

/** When a run is big enough to ask first (spec 1.5 §F4). */
function HeavyRunSettings() {
  const { limits, save } = useHeavyLimits();
  const [tokens, setTokens] = useState('');
  const [pages, setPages] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setTokens(String(limits.tokens));
    setPages(String(limits.pages));
  }, [limits]);

  const apply = async (t: number, p: number) => {
    await save({ tokens: t, pages: p });
    setMsg('Saved. The next run over either number asks before it starts.');
  };

  return (
    <section>
      <h3 className="text-base font-semibold mb-2">Warn before a long run</h3>
      <p className="text-xs text-app-text-secondary mb-3">
        Isnād extraction, book-mode reuse and Qurʾān detection read the whole text. Over either of
        these they show what the run will read and wait for you to say go. A run can be paused or
        cancelled once it starts, and what it has found is kept either way.
      </p>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-app-text-tertiary">Tokens</span>
          <input
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            inputMode="numeric"
            className="w-32 px-2 py-1.5 border border-app-border-medium rounded tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-app-text-tertiary">Pages</span>
          <input
            value={pages}
            onChange={(e) => setPages(e.target.value)}
            inputMode="numeric"
            className="w-32 px-2 py-1.5 border border-app-border-medium rounded tabular-nums"
          />
        </label>
        <button
          onClick={() => void apply(Number(tokens) || DEFAULT_HEAVY_LIMITS.tokens, Number(pages) || DEFAULT_HEAVY_LIMITS.pages)}
          className="px-3 py-1.5 bg-app-accent text-white rounded"
        >
          Save
        </button>
        <button
          onClick={() => void apply(DEFAULT_HEAVY_LIMITS.tokens, DEFAULT_HEAVY_LIMITS.pages)}
          className="px-3 py-1.5 border border-app-border-medium rounded"
        >
          Reset to default
        </button>
        {msg && <span className="text-xs text-app-text-tertiary">{msg}</span>}
      </div>
    </section>
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
