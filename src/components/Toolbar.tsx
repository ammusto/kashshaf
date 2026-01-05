import { useState, useEffect } from 'react';
import { showAppMenu, checkAppUpdate, getAppSetting, setAppSetting } from '../api/tauri';
import type { AppUpdateStatus } from '../types';

interface ToolbarProps {
  onBrowseTexts: () => void;
  onSearchHistory: () => void;
  onSavedSearches: () => void;
  onHelp: () => void;
  helpActive?: boolean;
  /** Whether the app is in online mode */
  isOnlineMode?: boolean;
  /** Callback when user wants to download corpus (from online mode button) */
  onDownloadCorpus?: () => void;
}

export function Toolbar({
  onBrowseTexts,
  onSearchHistory,
  onSavedSearches,
  onHelp,
  helpActive,
  isOnlineMode,
  onDownloadCorpus,
}: ToolbarProps) {
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showRequiredUpdateModal, setShowRequiredUpdateModal] = useState(false);

  useEffect(() => {
    checkForUpdates();
  }, []);

  async function checkForUpdates() {
    try {
      const status = await checkAppUpdate();
      setUpdateStatus(status);

      if (status.update_required) {
        // Required update - show blocking modal
        setShowRequiredUpdateModal(true);
      } else if (status.update_available) {
        // Optional update - check if user dismissed this version
        const dismissedVersion = await getAppSetting('dismissed_update_version');
        if (dismissedVersion !== status.latest_version) {
          setShowUpdateBanner(true);
        }
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
    }
  }

  async function handleDismissUpdate() {
    if (updateStatus) {
      await setAppSetting('dismissed_update_version', updateStatus.latest_version);
      setShowUpdateBanner(false);
    }
  }

  function handleDownloadUpdate() {
    if (updateStatus?.download_url) {
      window.open(updateStatus.download_url, '_blank');
    }
  }

  const handleMenuClick = async () => {
    try {
      await showAppMenu();
    } catch (err) {
      console.error('Failed to show menu:', err);
    }
  };

  return (
    <div className="flex flex-col flex-shrink-0">
      {/* Update Available Banner (optional update) */}
      {showUpdateBanner && updateStatus && !updateStatus.update_required && (
        <div className="h-10 flex items-center justify-between px-4 bg-blue-50 border-b border-blue-200">
          <div className="flex items-center gap-2 text-sm text-blue-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Update available: <strong>v{updateStatus.latest_version}</strong>
              {updateStatus.release_notes && ` - ${updateStatus.release_notes}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadUpdate}
              className="px-3 py-1 text-sm font-medium text-blue-700 hover:bg-blue-100 rounded transition-colors"
            >
              Download
            </button>
            <button
              onClick={handleDismissUpdate}
              className="p-1 text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded transition-colors"
              title="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Main Toolbar */}
      <div className="h-10 flex items-center gap-2 px-3 bg-white border-b border-app-border-light">
        {/* Menu Button */}
        <button
          onClick={handleMenuClick}
          className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                     bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light
                     flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          Menu
        </button>

        {/* Browse Texts Button */}
        <button
          onClick={onBrowseTexts}
          className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                     bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light
                     flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          Browse Texts
        </button>

        {/* Search History Button */}
        <button
          onClick={onSearchHistory}
          className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                     bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light
                     flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          History
        </button>

        {/* Saved Searches Button */}
        <button
          onClick={onSavedSearches}
          className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                     bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light
                     flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          Saved
        </button>

        {/* Help Button */}
        <button
          onClick={onHelp}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                     flex items-center gap-1.5
                     ${helpActive
              ? 'bg-app-accent text-white'
              : 'bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light'
            }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Help
        </button>

        {/* Spacer to push Online Mode button to the right */}
        <div className="flex-1" />

        {/* Online Mode Button - only visible when in online mode */}
        {isOnlineMode && onDownloadCorpus && (
          <button
            onClick={() => setShowDownloadConfirm(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                       bg-amber-100 text-amber-800 hover:bg-amber-200
                       flex items-center gap-1.5"
            title="Currently using online mode. Click to download corpus for offline use."
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Online Mode
          </button>
        )}
      </div>

      {/* Download Confirmation Dialog */}
      {showDownloadConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-[400px] flex flex-col">
            <div className="px-6 py-4 border-b border-app-border-light">
              <h2 className="text-lg font-semibold text-app-text-primary">Download Corpus</h2>
            </div>
            <div className="px-6 py-6">
              <p className="text-app-text-secondary">
                Download the corpus for offline use? This is a large download (~8 GB) but enables faster searches and offline access.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-3">
              <button
                onClick={() => setShowDownloadConfirm(false)}
                className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowDownloadConfirm(false);
                  onDownloadCorpus?.();
                }}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Required Update Modal (blocking) */}
      {showRequiredUpdateModal && updateStatus && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-[450px] flex flex-col">
            <div className="px-6 py-4 border-b border-app-border-light">
              <h2 className="text-lg font-semibold text-red-600 flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Update Required
              </h2>
            </div>
            <div className="px-6 py-6">
              <p className="text-app-text-secondary mb-4">
                A required update is available. Your current version (<strong>v{updateStatus.current_version}</strong>) is no longer supported.
              </p>
              <p className="text-app-text-secondary mb-4">
                Please update to <strong>v{updateStatus.latest_version}</strong> to continue using Kashshaf.
              </p>
              {updateStatus.release_notes && (
                <div className="bg-gray-50 rounded-lg p-3 text-sm text-app-text-secondary">
                  <strong>What's new:</strong> {updateStatus.release_notes}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-app-border-light flex justify-end">
              <button
                onClick={handleDownloadUpdate}
                className="px-6 py-2.5 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors font-medium"
              >
                Download Update
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
