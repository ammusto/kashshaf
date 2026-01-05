import { useState } from 'react';
import type { AppUpdateStatus } from '../../types';

interface AppUpdateModalProps {
  updateStatus: AppUpdateStatus;
  /** Called when user clicks Update */
  onUpdate: () => void;
  /** Called when user clicks Skip */
  onSkip: (doNotShowAgain: boolean) => void;
}

export function AppUpdateModal({
  updateStatus,
  onUpdate,
  onSkip,
}: AppUpdateModalProps) {
  const [doNotShowAgain, setDoNotShowAgain] = useState(false);

  const isRequired = updateStatus.update_required;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[450px] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-app-border-light">
          <h2 className={`text-lg font-semibold flex items-center gap-2 ${isRequired ? 'text-red-600' : 'text-app-text-primary'}`}>
            {isRequired ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            {isRequired ? 'Update Required' : 'Update Available'}
          </h2>
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          {isRequired ? (
            <>
              <p className="text-app-text-secondary mb-4">
                A required update is available. Your current version (<strong>v{updateStatus.current_version}</strong>) is no longer supported.
              </p>
              <p className="text-app-text-secondary mb-4">
                Please update to <strong>v{updateStatus.latest_version}</strong> to continue using Kashshaf.
              </p>
            </>
          ) : (
            <>
              <p className="text-app-text-secondary mb-4">
                A new version of Kashshaf is available and recommended.
              </p>
              <p className="text-app-text-secondary mb-4">
                Current version: <strong>v{updateStatus.current_version}</strong><br />
                Latest version: <strong>v{updateStatus.latest_version}</strong>
              </p>
            </>
          )}

          {updateStatus.release_notes && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm text-app-text-secondary mb-4">
              <strong>What's new:</strong> {updateStatus.release_notes}
            </div>
          )}

          {/* Do not show again checkbox - only for optional updates */}
          {!isRequired && (
            <label className="flex items-center gap-2 text-sm text-app-text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={doNotShowAgain}
                onChange={(e) => setDoNotShowAgain(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-app-accent focus:ring-app-accent"
              />
              Do not show again
            </label>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-3">
          {!isRequired && (
            <button
              onClick={() => onSkip(doNotShowAgain)}
              className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={onUpdate}
            className="px-6 py-2.5 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors font-medium"
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
