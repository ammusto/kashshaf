import { useEffect, useState } from 'react';
import type { LabStatus } from '../api/lab';
import { ModeBadge } from './ModeBadge';

/**
 * The top menu bar (spec 1.5 §A3).
 *
 * The left rail is for the work on the open text; anything about Lab itself
 * lives up here. Workspace returns to the startup view, Ctrl+W with it.
 * Settings still renders in the main pane rather than as a modal, because it
 * is long enough to scroll.
 */

export function MenuBar({
  status,
  onRecheck,
  rechecking,
  onWorkspace,
  onSettings,
  inWorkspaceView,
  settingsOpen,
  currentTitle,
  dirty,
  onSave,
}: {
  status: LabStatus | null;
  onRecheck: () => void;
  rechecking: boolean;
  onWorkspace: () => void;
  onSettings: () => void;
  inWorkspaceView: boolean;
  settingsOpen: boolean;
  currentTitle: string | null;
  /** Something is not yet written out to the workspace folder (spec §A2). */
  dirty: boolean;
  onSave: () => void;
}) {
  const [about, setAbout] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        onWorkspace();
      }
      if (e.key === 'Escape') setAbout(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onWorkspace]);

  const item = (label: string, on: boolean, fn: () => void, title?: string) => (
    <button
      onClick={fn}
      title={title}
      className={`px-3 py-1 text-sm rounded ${on ? 'bg-app-accent-light text-app-accent' : 'hover:bg-app-surface-variant'}`}
    >
      {label}
    </button>
  );

  return (
    <header className="flex items-center gap-3 px-3 py-1.5 border-b border-app-border-light bg-app-surface" data-testid="menu-bar">
      <h1 className="text-sm font-semibold ltr:mr-2">Kashshaf Lab</h1>
      {item('Workspace', inWorkspaceView, onWorkspace, 'Ctrl+W')}
      {item('Settings', settingsOpen, onSettings)}
      {item('About', false, () => setAbout(true))}

      <div className="flex-1 min-w-0 text-center">
        {currentTitle && (
          <span className="font-arabic text-sm text-app-text-secondary truncate inline-block max-w-full align-middle" dir="rtl">
            {currentTitle}
          </span>
        )}
      </div>

      {currentTitle && (
        <button
          onClick={onSave}
          title="Write everything out to the workspace folder (Ctrl+S)"
          className={`px-2 py-1 text-xs border rounded ${
            dirty ? 'border-app-accent text-app-accent' : 'border-app-border-medium text-app-text-secondary'
          }`}
          data-testid="save-workspace"
        >
          {dirty ? 'Save •' : 'Saved'}
        </button>
      )}
      <ModeBadge status={status} onRetry={onRecheck} busy={rechecking} />

      {about && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={() => setAbout(false)}>
          <div
            role="dialog"
            aria-label="About Kashshaf Lab"
            className="bg-app-surface rounded-2xl shadow-lg border border-app-border-light w-[30rem] max-w-[95vw] p-5 text-sm"
            onClick={(e) => e.stopPropagation()}
            data-testid="about-dialog"
          >
            <h2 className="text-base font-semibold mb-1">Kashshaf Lab</h2>
            <p className="text-app-text-secondary text-xs mb-4">Version {status?.lab_version ?? '—'}</p>
            <p className="text-app-text-secondary leading-relaxed">
              A workbench for reading one text closely: its statistics, the chains of transmission in
              it, what it shares with the rest of the corpus, and what it quotes from the Qurʾān.
              Lab reads the corpus and never writes to it; everything it finds lives in its own
              database and in the workspace folder.
            </p>
            <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-app-text-secondary">Mode</dt>
              <dd>{status?.mode ?? '—'}</dd>
              <dt className="text-app-text-secondary">Corpus</dt>
              <dd>{status?.corpus_version ?? '—'}</dd>
              <dt className="text-app-text-secondary">Table of contents</dt>
              <dd>{status?.toc ? 'present' : `needs corpus ${status?.min_toc_corpus_version ?? '—'}`}</dd>
            </dl>
            <div className="mt-5 text-right">
              <button onClick={() => setAbout(false)} className="px-3 py-1 border border-app-border-medium rounded">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
