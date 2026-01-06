import { useState } from 'react';

interface DeleteDataModalProps {
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function DeleteDataModal({ onConfirm, onCancel }: DeleteDataModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(String(err));
      setIsDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[450px] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-red-600 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Delete Local Data
          </h2>
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          <p className="text-app-text-secondary mb-4">
            Are you sure you want to delete local data?
          </p>
          <p className="text-app-text-secondary mb-4">
            This will delete the corpus database and search index files. Future offline usage will require you to re-download the database files.
          </p>
          <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
            <strong>Note:</strong> Your search history, saved searches, and settings will be preserved.
          </div>

          {error && (
            <div className="mt-4 bg-red-50 rounded-lg p-3 text-sm text-red-700">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
