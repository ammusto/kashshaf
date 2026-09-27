import { useEffect } from 'react';

interface SearchInTextModalProps {
  /** The text in the reader, for the heading. */
  bookTitle: string;
  /** Adds this text to the selection as it stands. */
  onAdd: () => void;
  /** Replaces the selection with this text alone. */
  onClear: () => void;
  /** Cancel, Escape and the backdrop: nothing changes. */
  onClose: () => void;
}

/**
 * Search in Text with a selection already made: the person chooses whether
 * this text joins it or replaces it. Shown only when there is a selection;
 * with none, the reader sets the text as the selection and asks nothing.
 */
export function SearchInTextModal({ bookTitle, onAdd, onClear, onClose }: SearchInTextModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-testid="search-in-text-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-in-text-title"
        className="bg-white rounded-xl shadow-2xl w-[520px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-app-border-light">
          <h2 id="search-in-text-title" className="text-lg font-semibold text-app-text-primary">
            Search in Text
          </h2>
          <p className="text-sm text-app-text-secondary font-arabic mt-1 truncate" dir="rtl">
            {bookTitle}
          </p>
        </div>
        <div className="px-6 py-5">
          <p className="text-app-text-primary leading-relaxed">
            Add this text to your current selection, or clear your selection and search just this text?
          </p>
        </div>
        <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-app-text-secondary
                       hover:bg-app-surface-variant transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-app-surface-variant text-app-text-primary
                       border border-app-border-light hover:bg-app-accent-light hover:text-app-accent transition-colors"
          >
            Clear Selection
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-app-accent text-white
                       hover:bg-app-accent-hover transition-colors shadow-sm"
          >
            Add to Selection
          </button>
        </div>
      </div>
    </div>
  );
}
