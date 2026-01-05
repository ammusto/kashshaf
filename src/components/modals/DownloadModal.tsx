import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { CorpusStatus, DownloadProgress } from '../../types';
import { startCorpusDownload, cancelCorpusDownload } from '../../api/tauri';

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
  const [lastBytesDownloaded, setLastBytesDownloaded] = useState(0);
  const [lastTimestamp, setLastTimestamp] = useState(Date.now());
  const [skipVerify, setSkipVerify] = useState(true);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [skipPromptNextTime, setSkipPromptNextTime] = useState(false);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>('download-progress', (event) => {
      const newProgress = event.payload;
      setProgress(newProgress);

      // Calculate download speed
      const now = Date.now();
      const timeDiff = (now - lastTimestamp) / 1000;
      if (timeDiff >= 1) {
        const bytesDiff = newProgress.overall_bytes_downloaded - lastBytesDownloaded;
        setDownloadSpeed(bytesDiff / timeDiff);
        setLastBytesDownloaded(newProgress.overall_bytes_downloaded);
        setLastTimestamp(now);
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
  }, [lastBytesDownloaded, lastTimestamp, onDownloadComplete]);

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
      setLastBytesDownloaded(0);
      setLastTimestamp(Date.now());
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

  // Determine message based on status
  const getMessage = () => {
    // Fresh install - no corpus data
    if (!status.ready && status.missing_files.length > 0 && !status.update_required) {
      return {
        title: 'Corpus Download',
        message: `For offline use, you must download the corpus (${formatBytes(status.total_download_size)}). Do you want to proceed?`,
        canDismiss: false,
        showOnline: showOnlineOption && !!onOnlineUse,
      };
    }
    if (status.update_required) {
      return {
        title: 'Corpus Update Required',
        message: 'The corpus format has changed. Please download the updated corpus data to continue.',
        canDismiss: false,
        showOnline: false,
      };
    }
    if (status.update_available) {
      return {
        title: 'Corpus Update Available',
        message: `A new version of the corpus is available (${status.remote_version}). Would you like to update?`,
        canDismiss: true,
        showOnline: false,
      };
    }
    return {
      title: 'Download Corpus',
      message: 'Download corpus data to continue.',
      canDismiss: false,
      showOnline: showOnlineOption && !!onOnlineUse,
    };
  };

  const msgInfo = getMessage();
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
          {msgInfo.canDismiss && onDismiss && !downloading && (
            <button
              onClick={onDismiss}
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
            <div className="space-y-4">
              <p className="text-app-text-secondary">{msgInfo.message}</p>
              {status.error && (
                <div className="p-3 rounded-lg bg-yellow-50 text-yellow-700 text-sm">
                  {status.error}
                </div>
              )}
              {/* Verify files checkbox */}
              <label className="flex items-center gap-2 text-sm text-app-text-tertiary cursor-pointer">
                <input
                  type="checkbox"
                  checked={!skipVerify}
                  onChange={(e) => setSkipVerify(!e.target.checked)}
                  className="w-4 h-4 rounded border-app-border-light"
                />
                <span>Verify downloaded files (slower)</span>
              </label>
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
                  Online Use
                </button>
              )}
              {msgInfo.canDismiss && onDismiss && (
                <button
                  onClick={onDismiss}
                  className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
                >
                  Later
                </button>
              )}
              <button
                onClick={handleStartDownload}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                Download
              </button>
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
