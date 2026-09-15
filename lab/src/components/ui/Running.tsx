import { useEffect, type ReactNode } from 'react';

/**
 * What a long operation looks like (spec 1.5 §F).
 *
 * - [`LoadingOverlay`] (F1) covers the panel it blocks with a spinner, the
 *   step counter and the step's name — not a line at the top that a reader
 *   has to hunt for.
 * - [`RunBar`] (F2, F3) is the strip a streaming run shows while it runs:
 *   progress, Pause/Resume, Cancel. It disappears when the run ends; a
 *   cancelled run leaves a line saying how far it got, and no live button.
 * - [`HeavyRunModal`] (F4) asks before a run that would read more than the
 *   thresholds in Settings.
 */

// ------------------------------------------------------------------- F1 ---

export interface Step {
  /** What is happening, in words: "Loading pages…". */
  label: string;
  /** 1-based; omit for an operation with a single step. */
  index?: number;
  total?: number;
  /** Progress within the step, when it is countable. */
  done?: number;
  of?: number;
}

/**
 * A centred overlay over the panel it blocks (spec §F1). Absolute, so the
 * pane it covers must be `relative`.
 */
export function LoadingOverlay({ step, onCancel }: { step: Step | null; onCancel?: () => void }) {
  if (!step) return null;
  const pct = step.of && step.of > 0 && step.done != null ? Math.min(100, Math.round((step.done / step.of) * 100)) : null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-app-bg/70 backdrop-blur-[1px]" role="status" data-testid="loading-overlay">
      <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-lg bg-app-surface border border-app-border-light shadow-lg min-w-[16rem]">
        <Spinner />
        {step.total != null && step.total > 1 && (
          <div className="text-xs text-app-text-tertiary tabular-nums">
            {step.index ?? 1} / {step.total}
          </div>
        )}
        <div className="text-sm text-app-text-primary text-center">{step.label}</div>
        {pct != null && (
          <div className="w-56">
            <div className="h-1.5 bg-app-surface-variant rounded overflow-hidden">
              <div className="h-full bg-app-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-app-text-tertiary tabular-nums text-center">
              {step.done?.toLocaleString()} / {step.of?.toLocaleString()}
            </div>
          </div>
        )}
        {onCancel && (
          <button onClick={onCancel} className="mt-1 px-3 py-1 text-xs border border-app-border-medium rounded">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function Spinner({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin text-app-accent`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}

// --------------------------------------------------------------- F2, F3 ---

/** The state a panel keeps for one streaming run. */
export interface RunState {
  running: boolean;
  paused: boolean;
  /** Set when the last run was cancelled, with what it reached. */
  cancelledAt: string | null;
}

export const IDLE_RUN: RunState = { running: false, paused: false, cancelledAt: null };

/**
 * The run strip (spec §F2, §F3). Rendered only while a run is going: when it
 * finishes, the caller clears `running` and the strip — with its Cancel —
 * goes, leaving the result. A cancelled run leaves the count it reached.
 */
export function RunBar({
  run,
  done,
  total,
  found,
  foundLabel = 'found',
  estimateMs,
  onPause,
  onCancel,
}: {
  run: RunState;
  done: number;
  total: number;
  found?: number;
  foundLabel?: string;
  estimateMs?: number | null;
  onPause: (paused: boolean) => void;
  onCancel: () => void;
}) {
  if (!run.running) {
    if (!run.cancelledAt) return null;
    return (
      <div className="px-3 py-1 text-xs bg-app-surface-variant border-b border-app-border-light text-app-text-secondary" role="status" data-testid="run-cancelled">
        Cancelled — {run.cancelledAt}
      </div>
    );
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="px-3 py-1.5 text-xs bg-app-surface-variant border-b border-app-border-light flex items-center gap-3" role="status" data-testid="run-bar">
      <Spinner className="w-3.5 h-3.5" />
      <div className="flex-1 min-w-[6rem] max-w-sm">
        <div className="h-1.5 bg-app-border-light rounded overflow-hidden">
          <div className={`h-full ${run.paused ? 'bg-app-text-tertiary' : 'bg-app-accent'} transition-[width] duration-200`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="tabular-nums">
        {done.toLocaleString()} / {total.toLocaleString()}
        {found != null && ` · ${found.toLocaleString()} ${foundLabel}`}
      </span>
      {run.paused ? <span className="text-app-text-tertiary">paused</span> : estimateMs != null && <span className="text-app-text-tertiary">about {fmtDuration(estimateMs)}</span>}
      <button onClick={() => onPause(!run.paused)} className="px-2 py-0.5 border border-app-border-medium rounded">
        {run.paused ? 'Resume' : 'Pause'}
      </button>
      <button onClick={onCancel} className="px-2 py-0.5 border border-app-border-medium rounded">
        Cancel
      </button>
    </div>
  );
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ------------------------------------------------------------------- F4 ---

/** The thresholds, user-set in Settings (spec §F4). */
export interface HeavyLimits {
  tokens: number;
  pages: number;
}

export const DEFAULT_HEAVY_LIMITS: HeavyLimits = { tokens: 300_000, pages: 2_000 };

export function isHeavy(size: { pages: number; tokens: number } | null, limits: HeavyLimits): boolean {
  return !!size && (size.tokens > limits.tokens || size.pages > limits.pages);
}

/**
 * Asked before a heavy run (spec §F4): what it will read, and how long that
 * is likely to take, with Continue and Cancel.
 */
export function HeavyRunModal({
  open,
  what,
  pages,
  tokens,
  estimateMs,
  onContinue,
  onCancel,
}: {
  open: boolean;
  /** "Extract isnāds", "Analyse the whole book"… */
  what: string;
  pages: number;
  tokens: number;
  estimateMs?: number | null;
  onContinue: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        role="dialog"
        aria-label={`${what} — confirm`}
        className="bg-app-surface rounded shadow-lg border border-app-border-light w-[26rem] max-w-[95vw] p-4 text-sm"
        onClick={(e) => e.stopPropagation()}
        data-testid="heavy-run-modal"
      >
        <h2 className="font-semibold mb-2">{what}</h2>
        <p className="text-app-text-secondary">
          This reads about <b>{pages.toLocaleString()} pages</b> and <b>{tokens.toLocaleString()} tokens</b>
          {estimateMs != null && (
            <>
              , about <b>{fmtDuration(estimateMs)}</b>
            </>
          )}
          . You can pause or cancel once it starts, and what it has done is kept.
        </p>
        <div className="flex items-center gap-2 mt-4">
          <button onClick={onContinue} className="px-3 py-1 bg-app-accent text-white rounded">
            Continue
          </button>
          <button onClick={onCancel} className="px-3 py-1 border border-app-border-medium rounded">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** A small inline error / notice line, so every panel shows them alike. */
export function Notice({ error, message }: { error?: string | null; message?: string | null }) {
  if (!error && !message) return null;
  return (
    <div
      className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`}
      role={error ? 'alert' : 'status'}
    >
      {error ?? message}
    </div>
  );
}

export type { ReactNode };
