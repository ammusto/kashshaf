import type { LabStatus } from '../api/lab';

/**
 * The persistent mode badge (spec §7.1): `Local corpus 4.1.0` / `Online`.
 *
 * When neither mode worked it says so and shows both reasons — ground rule 5
 * is that a failure is shown, not hidden behind a disabled control with no
 * explanation.
 */
export function ModeBadge({ status, onRetry, busy }: {
  status: LabStatus | null;
  onRetry: () => void;
  busy?: boolean;
}) {
  if (!status) {
    return <span className="text-xs text-app-text-secondary">Checking…</span>;
  }

  const tone =
    status.mode === 'local' ? 'bg-app-accent-light text-app-accent'
    : status.mode === 'api' ? 'bg-app-surface-variant text-app-text-secondary'
    : 'bg-red-50 text-app-error';

  const label =
    status.mode === 'local' ? `Local corpus ${status.corpus_version ?? '—'}`
    : status.mode === 'api' ? `Online ${status.corpus_version ?? ''}`.trim()
    : 'No corpus';

  const reason = status.mode === 'unavailable'
    ? [status.local_error, status.api_error].filter(Boolean).join(' · ')
    : status.mode === 'api'
      ? status.local_error ?? undefined
      : undefined;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`px-2 py-0.5 rounded text-xs font-medium ${tone}`}
        title={reason}
        data-testid="mode-badge"
      >
        {label}
      </span>
      {status.mode !== 'local' && (
        <button
          onClick={onRetry}
          disabled={busy}
          className="text-xs text-app-accent hover:underline disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Recheck'}
        </button>
      )}
    </div>
  );
}

/**
 * The reason panel shown when nothing can be read. Both candidate modes
 * report why they failed, so the user can tell a missing corpus from an
 * unwritable directory from a server that is down.
 */
export function UnavailableNotice({ status }: { status: LabStatus }) {
  return (
    <div className="max-w-2xl mx-auto mt-16 p-6 bg-app-surface border border-app-border-light rounded-lg shadow-app-md">
      <h2 className="text-lg font-semibold text-app-text-primary mb-2">
        Kashshaf Lab has nothing to read yet
      </h2>
      <p className="text-sm text-app-text-secondary mb-4">
        Lab works from a local corpus (every feature) or through the Kashshaf API
        (most features). Neither is available right now.
      </p>
      <dl className="text-sm space-y-3">
        <div>
          <dt className="font-medium text-app-text-primary">Local corpus</dt>
          <dd className="text-app-text-secondary">
            {status.local_error ?? 'not checked'}
            {status.corpus_dir && (
              <div className="text-xs text-app-text-secondary mt-0.5">
                Looked in {status.corpus_dir}
              </div>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-app-text-primary">Kashshaf API</dt>
          <dd className="text-app-text-secondary">
            {status.api_error ?? 'not checked'}
            {status.api_base && (
              <div className="text-xs text-app-text-secondary mt-0.5">{status.api_base}</div>
            )}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-app-text-secondary mt-5">
        Downloading the corpus in Kashshaf makes it available here too: both apps
        read the same directory. Lab picks it up when you press Recheck.
      </p>
    </div>
  );
}
