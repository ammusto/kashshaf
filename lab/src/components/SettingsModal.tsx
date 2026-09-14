import { useEffect, type ReactNode } from 'react';

/**
 * A small modal for a panel's algorithm parameters (spec 1.4, fix 9): opened
 * from a gear button beside the panel's primary action, with Apply and
 * Reset. The caller owns the draft values; Apply hands them back and the
 * caller persists them in `lab_setting`.
 */
export function SettingsModal({
  title,
  open,
  onClose,
  onApply,
  onReset,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onApply: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose} data-testid="settings-modal">
      <div role="dialog" aria-label={title} className="bg-app-surface rounded shadow-lg border border-app-border-light w-96 max-w-[95vw] p-4 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center mb-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="ml-auto px-2 text-app-text-tertiary" aria-label="Close">
            ×
          </button>
        </div>
        <div className="space-y-2">{children}</div>
        <div className="flex items-center gap-2 mt-4">
          <button onClick={onApply} className="px-3 py-1 bg-app-accent text-white rounded">
            Apply
          </button>
          <button onClick={onReset} className="px-3 py-1 border border-app-border-medium rounded">
            Reset to defaults
          </button>
          <button onClick={onClose} className="ml-auto px-3 py-1 border border-app-border-medium rounded">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The gear button that opens a panel's settings modal. */
export function GearButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="px-2 py-1 text-sm border border-app-border-medium rounded" aria-label={label} title={label}>
      ⚙
    </button>
  );
}
