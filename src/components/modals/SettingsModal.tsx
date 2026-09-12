import { useEffect, useState } from 'react';
import { useOperatingMode } from '../../contexts/OperatingModeContext';
import type { DataDirInfo } from '../../types';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

interface SettingsModalProps {
  onClose: () => void;
  /** Online mode: the exact-counts toggle is hidden (it only applies to local data). */
  isOnlineMode: boolean;
}

/**
 * App settings. Currently one setting: "Exact counts" — verified searches
 * (proximity, wide wildcards, phrase verification) walk to the end instead of
 * stopping at the engine's verified-hit cap. Offline mode only; applied to
 * the running engine at once and persisted in user_settings.exact_counts.
 */
export function SettingsModal({ onClose, isOnlineMode }: SettingsModalProps) {
  const { capabilities, refreshCapabilities } = useOperatingMode();
  const [exactCounts, setExactCounts] = useState<boolean>(capabilities?.exact_counts ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirInfo, setDirInfo] = useState<DataDirInfo | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);

  // "Where is my corpus": the same resolution the download uses.
  useEffect(() => {
    let cancelled = false;
    import('../../api/tauri')
      .then(({ getDataDirectoryInfo }) => getDataDirectoryInfo())
      .then((info) => { if (!cancelled) setDirInfo(info); })
      .catch((err) => { if (!cancelled) setDirError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  async function handleOpenFolder() {
    try {
      const { openDataDirectory } = await import('../../api/tauri');
      await openDataDirectory();
    } catch (err) {
      setDirError(String(err));
    }
  }

  useEffect(() => {
    setExactCounts(capabilities?.exact_counts ?? false);
  }, [capabilities?.exact_counts]);

  async function handleToggle(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const { setExactCounts: apply } = await import('../../api/tauri');
      const caps = await apply(enabled);
      setExactCounts(caps.exact_counts);
      await refreshCapabilities();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const cap = capabilities?.max_verified_hits ?? 20000;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[480px] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-app-border-light flex items-center justify-between">
          <h2 className="text-lg font-semibold text-app-text-primary">Settings</h2>
          <button onClick={onClose} className="text-app-text-tertiary hover:text-app-text-primary text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-6 space-y-4">
          <div className="rounded-lg border border-app-border-light p-3 text-sm space-y-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-app-text-tertiary text-xs uppercase tracking-wide">Data location</div>
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
                    {' · '}
                    {formatBytes(dirInfo.free_bytes)} free of {formatBytes(dirInfo.total_bytes)}
                    {!dirInfo.writable && <span className="text-red-700"> · not writable</span>}
                  </div>
                )}
                {dirError && <div className="text-xs text-red-700 mt-0.5">{dirError}</div>}
              </div>
              {dirInfo && (
                <button
                  type="button"
                  onClick={handleOpenFolder}
                  className="flex-shrink-0 px-2 py-1 text-xs rounded border border-app-border-medium text-app-text-secondary hover:text-app-accent hover:border-app-accent transition-colors"
                >
                  Open folder
                </button>
              )}
            </div>
            <div className="text-xs text-app-text-tertiary">
              Holds the corpus database and index, and settings.db (history, saved searches, collections).
            </div>
          </div>

          {isOnlineMode ? (
            <p className="text-sm text-app-text-secondary">
              Search settings apply to local data only. Download the corpus to use offline mode and
              enable them.
            </p>
          ) : (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={exactCounts}
                disabled={saving || !capabilities}
                onChange={(e) => handleToggle(e.target.checked)}
              />
              <span>
                <span className="block text-sm font-medium text-app-text-primary">
                  Exact counts (slower, local data only)
                </span>
                <span className="block text-xs text-app-text-secondary mt-1">
                  Proximity, phrase and wide wildcard searches normally stop after verifying{' '}
                  {cap.toLocaleString()} matching pages and show the count with a “+”. With exact
                  counts on, they run to the end and report the exact total; very common terms can
                  take several seconds and use more memory.
                </span>
              </span>
            </label>
          )}

          {error && (
            <div className="bg-red-50 rounded-lg p-3 text-sm text-red-700">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-app-border-light flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-app-accent text-white hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
