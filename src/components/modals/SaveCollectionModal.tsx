import { useState, useEffect } from 'react';

interface SaveCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description: string | null) => Promise<void>;
  existingNames?: string[];
  initialName?: string;
  initialDescription?: string;
  title?: string;
  saveButtonText?: string;
}

export function SaveCollectionModal({
  isOpen,
  onClose,
  onSave,
  existingNames = [],
  initialName = '',
  initialDescription = '',
  title = 'Save Collection',
  saveButtonText = 'Save',
}: SaveCollectionModalProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setDescription(initialDescription);
      setError(null);
    }
  }, [isOpen, initialName, initialDescription]);

  const trimmedName = name.trim();
  const isDuplicate = existingNames.some(
    n => n.toLowerCase() === trimmedName.toLowerCase() && n !== initialName
  );
  const isValid = trimmedName.length > 0 && !isDuplicate;

  async function handleSave() {
    if (!isValid) return;

    try {
      setSaving(true);
      setError(null);
      const desc = description.trim() || null;
      await onSave(trimmedName, desc);
      onClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('already exists')) {
        setError('A collection with this name already exists');
      } else {
        setError(`Failed to save: ${errorMessage}`);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && isValid && !saving) {
      e.preventDefault();
      handleSave();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-xl shadow-2xl w-[400px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">{title}</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors disabled:opacity-50"
          >
            <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-sm font-medium text-app-text-primary mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-1
                ${isDuplicate ? 'border-red-300 focus:ring-red-500' : 'border-app-border-light focus:ring-app-accent'}`}
              placeholder="Enter collection name"
              autoFocus
              disabled={saving}
            />
            {isDuplicate && (
              <p className="text-xs text-red-500 mt-1">A collection with this name already exists</p>
            )}
          </div>

          {/* Description input */}
          <div>
            <label className="block text-sm font-medium text-app-text-primary mb-1">
              Description <span className="text-app-text-tertiary">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 150))}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg focus:outline-none focus:ring-1 focus:ring-app-accent resize-none"
              rows={3}
              placeholder="Add a description..."
              disabled={saving}
            />
            <div className="text-xs text-app-text-tertiary text-right mt-1">
              {description.length}/150
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-app-text-secondary hover:bg-app-surface-variant rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="px-4 py-2 bg-app-accent text-white rounded-lg hover:bg-app-accent-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {saveButtonText}
          </button>
        </div>
      </div>
    </div>
  );
}
