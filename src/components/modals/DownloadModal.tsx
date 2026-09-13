import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { CorpusStatus, DownloadProgress, DataDirInfo } from '../../types';
import { startCorpusDownload, cancelCorpusDownload, getDataDirectoryInfo, openDataDirectory } from '../../api/tauri';

// Number of speed samples to keep for rolling average
const SPEED_SAMPLE_COUNT = 10;

interface DownloadModalProps {
  status: CorpusStatus;
  onDownloadComplete: () => void;
  onDismiss?: () => void;
  /** Callback when user chooses online mode (no corpus download) */
  onOnlineUse?: (skipPromptNextTime: boolean) => void;
  /** Whether to show the online use option (default: true for fresh install) */
  showOnlineOption?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** The three corpus states the dialog renders, plus "the app itself is too old". */
export type DialogKind = 'no_corpus' | 'update_available' | 'update_required' | 'app_too_old';

export interface DialogCopy {
  kind: DialogKind;
  title: string;
  message: string;
  /** Release notes from the remote manifest (state 2 only, when present). */
  notes: string | null;
  /** Label of the primary (download) button. */
  primaryLabel: string;
  /** Show "Use online mode": states 1 and 3 (when the caller offers it). */
  showOnline: boolean;
  /** Show "Later": state 2 only. Never for a required update or no corpus. */
  showLater: boolean;
  requiresAppUpdate: boolean;
}

/**
 * Pick the copy and buttons from `CorpusStatus` alone, so each state is
 * explicit and testable:
 *  1. no corpus         (!ready, no local version, files to fetch)
 *  2. update available  (ready && update_available && !update_required)
 *  3. update required   (update_required: schema changed, or the app is too
 *     new for the local corpus / too old for the remote one)
 * State 2 must never say "must": the local corpus keeps working.
 */
export function describeState(
  status: CorpusStatus,
  opts: { isAppTooOld: boolean; onlineOffered: boolean },
): DialogCopy {
  const size = formatBytes(status.total_download_size);
  if (opts.isAppTooOld) {
    return {
      kind: 'app_too_old',
      title: 'App update required',
      message: status.error || 'Your app version is too old for the published corpus. Please update the app to continue.',
      notes: null,
      primaryLabel: 'Download update',
      showOnline: false,
      showLater: false,
      requiresAppUpdate: true,
    };
  }
  if (status.update_required) {
    const local = status.local_version ? `corpus ${status.local_version}` : 'the installed corpus';
    const remote = status.remote_version ? `Version ${status.remote_version}` : 'The current version';
    return {
      kind: 'update_required',
      title: 'Corpus update required',
      message:
        `The corpus format has changed, so this version of the app cannot read ${local}. ` +
        `${remote} (${size}) uses the new format. Update the corpus to keep working offline, or use online mode until you do.`,
      notes: status.remote_notes,
      primaryLabel: 'Update now',
      showOnline: opts.onlineOffered,
      showLater: false,
      requiresAppUpdate: false,
    };
  }
  if (status.update_available && status.ready) {
    return {
      kind: 'update_available',
      title: 'Corpus update available',
      message:
        `You have corpus ${status.local_version ?? '(unknown version)'}. ` +
        `Version ${status.remote_version ?? '(unknown)'} is available (${size}). ` +
        'Your current corpus keeps working until you update.',
      notes: status.remote_notes,
      primaryLabel: 'Update now',
      showOnline: false,
      showLater: true,
      requiresAppUpdate: false,
    };
  }
  return {
    kind: 'no_corpus',
    title: 'Download the corpus',
    message:
      `Offline use needs the corpus on this computer (${size}). ` +
      'Download it now, or use online mode and download later from the toolbar.',
    notes: null,
    primaryLabel: `Download ${size}`,
    showOnline: opts.onlineOffered,
    showLater: false,
    requiresAppUpdate: false,
  };
}

export function DownloadModal({
  status,
  onDownloadComplete,
  onDismiss,
  onOnlineUse,
  showOnlineOption = true,
}: DownloadModalProps) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [skipVerify, setSkipVerify] = useState(true);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [skipPromptNextTime, setSkipPromptNextTime] = useState(false);
  // Destination and free-space preflight, fetched before the first byte.
  const [dirInfo, setDirInfo] = useState<DataDirInfo | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);

  // Refs for speed calculation (avoid re-renders and dependency issues)
  const speedSamplesRef = useRef<number[]>([]);
  const lastBytesRef = useRef(0);
  const lastTimestampRef = useRef(Date.now());

  useEffect(() => {
    const unlisten = listen<DownloadProgress>('download-progress', (event) => {
      const newProgress = event.payload;
      setProgress(newProgress);

      // Calculate download speed using rolling average
      const now = Date.now();
      const timeDiff = (now - lastTimestampRef.current) / 1000;
      if (timeDiff >= 1) {
        const bytesDiff = newProgress.overall_bytes_downloaded - lastBytesRef.current;
        const instantSpeed = bytesDiff / timeDiff;

        // Add to samples and keep only last N samples
        speedSamplesRef.current.push(instantSpeed);
        if (speedSamplesRef.current.length > SPEED_SAMPLE_COUNT) {
          speedSamplesRef.current.shift();
        }

        // Calculate average speed from samples
        const avgSpeed = speedSamplesRef.current.reduce((a, b) => a + b, 0) / speedSamplesRef.current.length;
        setDownloadSpeed(avgSpeed);

        lastBytesRef.current = newProgress.overall_bytes_downloaded;
        lastTimestampRef.current = now;
      }

      // Check for completion
      if (newProgress.state === 'completed') {
        setDownloading(false);
        onDownloadComplete();
      } else if (newProgress.state === 'failed' || newProgress.state === 'cancelled') {
        setDownloading(false);
        if (newProgress.state === 'failed') {
          setError('Download failed. Please try again.');
        }
      }
    });

    return () => {
      unlisten.then(f => f());
    };
  }, [onDownloadComplete]);

  // Where the files go and whether they fit: asked with the manifest's size so
  // the answer already includes the 1 GB margin.
  useEffect(() => {
    let cancelled = false;
    setDirInfo(null);
    setDirError(null);
    getDataDirectoryInfo(status.total_download_size > 0 ? status.total_download_size : undefined)
      .then((info) => { if (!cancelled) setDirInfo(info); })
      .catch((err) => { if (!cancelled) setDirError(String(err)); });
    return () => { cancelled = true; };
  }, [status.total_download_size]);

  // Timer effect
  useEffect(() => {
    if (!downloading || !startTime) return;

    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [downloading, startTime]);

  async function handleStartDownload() {
    try {
      setError(null);
      setDownloading(true);
      setProgress(null);
      setDownloadSpeed(0);
      // Reset refs for speed calculation
      speedSamplesRef.current = [];
      lastBytesRef.current = 0;
      lastTimestampRef.current = Date.now();
      setStartTime(Date.now());
      setElapsedTime(0);
      await startCorpusDownload(skipVerify);
    } catch (err) {
      const errorStr = String(err);
      // Don't show error for user-initiated cancellation
      if (!errorStr.includes('cancelled') && !errorStr.includes('Cancelled')) {
        setError(`Download failed: ${err}`);
      }
      setDownloading(false);
    }
  }

  async function handleCancel() {
    try {
      await cancelCorpusDownload();
    } catch (err) {
      // Ignore "No download in progress" error - it just means download already finished
      console.log('Cancel attempted:', err);
    }
  }

  function handleOnlineUse() {
    if (onOnlineUse) {
      onOnlineUse(skipPromptNextTime);
    }
  }

  // Check if this is an app version too old error (requires app update, not corpus download)
  const isAppTooOld = status.update_required && status.error?.includes('too old');

  const msgInfo = describeState(status, { isAppTooOld: !!isAppTooOld, onlineOffered: showOnlineOption && !!onOnlineUse });
  // Blocking preflight problems: no usable directory, not writable, or no room.
  const preflightError: string | null = dirError
    ? dirError
    : dirInfo && !dirInfo.writable
      ? `${dirInfo.path} is not writable. Move Kashshaf to a folder you can write to, or fix the folder's permissions, then restart.`
      : dirInfo && dirInfo.enough_space === false
        ? `Not enough free space: the download needs ${formatBytes(status.total_download_size)} plus a ${formatBytes(dirInfo.margin_bytes)} margin, but only ${formatBytes(dirInfo.free_bytes)} are free on the volume of ${dirInfo.path}. Free up space or move Kashshaf to a larger drive.`
        : null;
  const canStartDownload = !msgInfo.requiresAppUpdate && dirInfo !== null && preflightError === null;
  // Dismissal needs both: a state that allows it (state 2 "Later", or a
  // caller that opened the dialog from online mode and may close it) and an
  // onDismiss from the caller. A required update or a missing corpus in
  // offline mode is opened without onDismiss and cannot be closed.
  const canDismiss = !!onDismiss && !msgInfo.requiresAppUpdate && !downloading;
  const filePercent = progress && progress.file_total_bytes > 0
    ? (progress.file_bytes_downloaded / progress.file_total_bytes) * 100
    : 0;
  const overallPercent = progress && progress.overall_total_bytes > 0
    ? (progress.overall_bytes_downloaded / progress.overall_total_bytes) * 100
    : 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[500px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">{msgInfo.title}</h2>
          {canDismiss && (
            <button
              onClick={onDismiss}
              aria-label="Close"
              className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors"
            >
              <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          {/* Message before download starts */}
          {!downloading && !progress && (
            <div className="space-y-4" data-testid={`corpus-dialog-${msgInfo.kind}`}>
              <p className="text-app-text-secondary">{msgInfo.message}</p>
              {msgInfo.notes && (
                <div className="rounded-lg border border-app-border-light p-3 text-sm">
                  <div className="text-app-text-tertiary text-xs uppercase tracking-wide mb-1">What changed</div>
                  <p className="text-app-text-secondary whitespace-pre-line">{msgInfo.notes}</p>
                </div>
              )}
              {/* Show error only if not app-too-old (that message is already in msgInfo.message) */}
              {status.error && !isAppTooOld && (
                <div className="p-3 rounded-lg bg-yellow-50 text-yellow-700 text-sm">
                  {status.error}
                </div>
              )}
              {/* Destination and free space - known before the first byte */}
              {!msgInfo.requiresAppUpdate && (
                <div className="rounded-lg border border-app-border-light bg-app-surface-variant/50 p-3 text-sm space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-app-text-tertiary text-xs uppercase tracking-wide">Destination</div>
                      <div className="font-mono text-xs text-app-text-primary break-all" title={dirInfo?.path ?? ''}>
                        {dirInfo ? dirInfo.path : dirError ? '—' : 'Resolving…'}
                      </div>
                      {dirInfo && (
                        <div className="text-xs text-app-text-tertiary mt-0.5">
                          {dirInfo.source === 'portable'
                            ? 'Portable: next to the application'
                            : dirInfo.source === 'user'
                              ? 'Per-user data folder'
                              : 'Development data folder'}
                        </div>
                      )}
                    </div>
                    {dirInfo && (
                      <button
                        type="button"
                        onClick={() => openDataDirectory().catch((e) => setDirError(String(e)))}
                        className="flex-shrink-0 px-2 py-1 text-xs rounded border border-app-border-medium text-app-text-secondary hover:text-app-accent hover:border-app-accent transition-colors"
                      >
                        Open folder
                      </button>
                    )}
                  </div>
                  {dirInfo && (
                    <div className="text-xs text-app-text-secondary">
                      Download {formatBytes(status.total_download_size)} · {formatBytes(dirInfo.free_bytes)} free of {formatBytes(dirInfo.total_bytes)}
                      {dirInfo.enough_space === true && <span className="text-green-700"> · fits</span>}
                    </div>
                  )}
                </div>
              )}
              {preflightError && !msgInfo.requiresAppUpdate && (
                <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{preflightError}</div>
              )}
              {/* Verify files checkbox - hide when app update required */}
              {!msgInfo.requiresAppUpdate && (
                <label className="flex items-center gap-2 text-sm text-app-text-tertiary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!skipVerify}
                    onChange={(e) => setSkipVerify(!e.target.checked)}
                    className="w-4 h-4 rounded border-app-border-light"
                  />
                  <span>Verify downloaded files (slower)</span>
                </label>
              )}
              {/* Do not show again checkbox - only for online use */}
              {msgInfo.showOnline && (
                <label className="flex items-center gap-2 text-sm text-app-text-tertiary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipPromptNextTime}
                    onChange={(e) => setSkipPromptNextTime(e.target.checked)}
                    className="w-4 h-4 rounded border-app-border-light"
                  />
                  <span>Do not show again</span>
                </label>
              )}
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* Download progress */}
          {(downloading || progress) && progress && (
            <div className="space-y-4">
              {/* Current file */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-app-text-secondary truncate max-w-[300px]">
                    {progress.current_file || 'Preparing...'}
                  </span>
                  <span className="text-sm text-app-text-tertiary">
                    {progress.files_completed + 1} / {progress.files_total}
                  </span>
                </div>
                <div className="h-2 bg-app-surface-variant rounded-full overflow-hidden">
                  <div
                    className="h-full bg-app-accent transition-all duration-300"
                    style={{ width: `${filePercent}%` }}
                  />
                </div>
              </div>

              {/* Overall progress */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-app-text-primary">Overall Progress</span>
                  <span className="text-sm text-app-text-tertiary">
                    {formatBytes(progress.overall_bytes_downloaded)} / {formatBytes(progress.overall_total_bytes)}
                  </span>
                </div>
                <div className="h-3 bg-app-surface-variant rounded-full overflow-hidden">
                  <div
                    className="h-full bg-app-accent transition-all duration-300"
                    style={{ width: `${overallPercent}%` }}
                  />
                </div>
              </div>

              {/* Speed and percentage */}
              <div className="flex items-center justify-between text-sm text-app-text-tertiary">
                <span>
                  {progress.state === 'verifying' ? 'Verifying...' :
                   progress.state === 'downloading' ? formatSpeed(downloadSpeed) :
                   progress.state === 'completed' ? 'Complete!' :
                   progress.state === 'cancelled' ? 'Cancelled' :
                   progress.state === 'failed' ? 'Failed' :
                   'Starting...'}
                </span>
                <span>{Math.round(overallPercent)}%</span>
              </div>

              {/* Time remaining */}
              <div className="text-sm text-app-text-tertiary text-left">
                {downloadSpeed > 0 && progress.state === 'downloading'
                  ? `Estimated Time Remaining: ${formatTime(Math.ceil((progress.overall_total_bytes - progress.overall_bytes_downloaded) / downloadSpeed))}`
                  : `${formatTime(elapsedTime)} elapsed`}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-3">
          {!downloading && !progress && (
            <>
              {msgInfo.showOnline && (
                <button
                  onClick={handleOnlineUse}
                  className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
                >
                  Use online mode
                </button>
              )}
              {canDismiss && (
                <button
                  onClick={onDismiss}
                  className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
                >
                  {msgInfo.showLater ? 'Later' : 'Close'}
                </button>
              )}
              {msgInfo.requiresAppUpdate ? (
                <a
                  href="https://kashshaf.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
                >
                  {msgInfo.primaryLabel}
                </a>
              ) : (
                <button
                  onClick={handleStartDownload}
                  disabled={!canStartDownload}
                  title={preflightError ?? (dirInfo ? undefined : 'Checking the destination…')}
                  className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {msgInfo.primaryLabel}
                </button>
              )}
            </>
          )}

          {downloading && (
            <button
              onClick={handleCancel}
              className="px-4 py-2 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
            >
              Cancel
            </button>
          )}

          {progress && progress.state === 'completed' && (
            <button
              onClick={onDownloadComplete}
              className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
            >
              Continue
            </button>
          )}

          {progress && (progress.state === 'failed' || progress.state === 'cancelled') && (
            <>
              {onOnlineUse && (
                <button
                  onClick={() => onOnlineUse(false)}
                  className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
                >
                  Use Online Mode
                </button>
              )}
              <button
                onClick={handleStartDownload}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
