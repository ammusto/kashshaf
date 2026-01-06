import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
import { showAppMenu, checkAppUpdate, getAppSetting, setAppSetting, deleteLocalData } from '../api/tauri';
import { AppUpdateModal } from './modals/AppUpdateModal';
import { DeleteDataModal } from './modals/DeleteDataModal';
import type { AppUpdateStatus } from '../types';

// Setting key for "do not show again" preference
const SETTING_SKIP_APP_UPDATE_PROMPT = 'skip_app_update_prompt';

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
  /** Callback when local data is deleted - app should switch to online mode or show download modal */
  onDataDeleted?: () => void;
}

export function Toolbar({
  onBrowseTexts,
  onSearchHistory,
  onSavedSearches,
  onHelp,
  helpActive,
  isOnlineMode,
  onDownloadCorpus,
  onDataDeleted,
}: ToolbarProps) {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isManualCheck, setIsManualCheck] = useState(false);
  const [showNoUpdateModal, setShowNoUpdateModal] = useState(false);
  const [showDeleteDataModal, setShowDeleteDataModal] = useState(false);

  useEffect(() => {
    // Check for updates on startup
    checkForUpdates(false);

    // Listen for manual "Check for Updates" from menu
    const unlistenUpdates = listen('check-for-updates', () => {
      handleManualCheckForUpdates();
    });

    // Listen for "Delete Local Data" from menu
    const unlistenDelete = listen('delete-local-data', () => {
      setShowDeleteDataModal(true);
    });

    return () => {
      unlistenUpdates.then(fn => fn());
      unlistenDelete.then(fn => fn());
    };
  }, []);

  async function checkForUpdates(manual: boolean) {
    try {
      const status = await checkAppUpdate();
      setUpdateStatus(status);

      if (status.update_required) {
        // Required update - always show blocking modal
        setIsManualCheck(manual);
        setShowUpdateModal(true);
      } else if (status.update_available) {
        if (manual) {
          // Manual check - always show modal (reset "do not show again")
          await setAppSetting(SETTING_SKIP_APP_UPDATE_PROMPT, 'false');
          setIsManualCheck(true);
          setShowUpdateModal(true);
        } else {
          // Automatic startup check - respect "do not show again" preference
          const skipPrompt = await getAppSetting(SETTING_SKIP_APP_UPDATE_PROMPT);
          if (skipPrompt !== 'true') {
            setIsManualCheck(false);
            setShowUpdateModal(true);
          }
        }
      } else if (manual) {
        // Manual check but no update available
        setShowNoUpdateModal(true);
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      if (manual) {
        // Show error for manual check
        setShowNoUpdateModal(true);
      }
    }
  }

  async function handleManualCheckForUpdates() {
    // Reset "do not show again" when user manually checks
    await setAppSetting(SETTING_SKIP_APP_UPDATE_PROMPT, 'false');
    await checkForUpdates(true);
  }

  async function handleDownloadUpdate() {
    if (updateStatus?.download_url) {
      await open(updateStatus.download_url);
    }
  }

  async function handleSkipUpdate(doNotShowAgain: boolean) {
    if (isManualCheck) {
      // User did manual check, then skipped - reset "do not show again" to false
      // This ensures next app launch will show the modal again
      await setAppSetting(SETTING_SKIP_APP_UPDATE_PROMPT, 'false');
    } else if (doNotShowAgain) {
      // Automatic check and user checked "do not show again"
      await setAppSetting(SETTING_SKIP_APP_UPDATE_PROMPT, 'true');
    }
    setShowUpdateModal(false);
  }

  const handleMenuClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    try {
      // Get button position to show menu aligned with button's left edge
      const button = event.currentTarget;
      const rect = button.getBoundingClientRect();
      // Position at the bottom-left of the button
      // Multiply by devicePixelRatio to convert to physical pixels
      const x = rect.left * window.devicePixelRatio;
      const y = rect.bottom * window.devicePixelRatio;
      await showAppMenu(x, y);
    } catch (err) {
      console.error('Failed to show menu:', err);
    }
  };

  async function handleDeleteData() {
    await deleteLocalData();
    setShowDeleteDataModal(false);
    onDataDeleted?.();
  }

  return (
    <div className="flex flex-col flex-shrink-0">
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
            onClick={onDownloadCorpus}
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

      {/* App Update Modal */}
      {showUpdateModal && updateStatus && (
        <AppUpdateModal
          updateStatus={updateStatus}
          onUpdate={handleDownloadUpdate}
          onSkip={handleSkipUpdate}
        />
      )}

      {/* No Update Available Modal (for manual check) */}
      {showNoUpdateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-[400px] flex flex-col">
            <div className="px-6 py-4 border-b border-app-border-light">
              <h2 className="text-lg font-semibold text-app-text-primary flex items-center gap-2">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Up to Date
              </h2>
            </div>
            <div className="px-6 py-6">
              <p className="text-app-text-secondary">
                You're running the latest version of Kashshaf{updateStatus ? ` (v${updateStatus.current_version})` : ''}.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-app-border-light flex justify-end">
              <button
                onClick={() => setShowNoUpdateModal(false)}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Local Data Modal */}
      {showDeleteDataModal && (
        <DeleteDataModal
          onConfirm={handleDeleteData}
          onCancel={() => setShowDeleteDataModal(false)}
        />
      )}
    </div>
  );
}
