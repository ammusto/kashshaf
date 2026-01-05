import type { SearchMode } from '../../types';
import type { SearchInput } from '../../types/search';

interface SearchInputRowProps {
  input: SearchInput;
  onChange: (updated: SearchInput) => void;
  onRemove: () => void;
  canRemove: boolean;
}

export function SearchInputRow({
  input,
  onChange,
  onRemove,
  canRemove,
}: SearchInputRowProps) {
  return (
    <div className="space-y-2 p-3 bg-app-surface-variant rounded-lg">
      <div className="flex gap-2 items-center">
        <input
          type="text"
          dir="rtl"
          value={input.query}
          onChange={(e) => onChange({ ...input, query: e.target.value })}
          placeholder="ابحث..."
          className="flex-1 min-w-0 h-10 px-4 rounded-md border border-app-border-medium
         focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
         text-right font-arabic bg-white text-lg"
        />
        {canRemove && (
          <button
            onClick={onRemove}
            className="w-8 h-8 flex items-center justify-center rounded-md
                     bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
            title="Remove"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Mode Selector */}
      <div className="flex gap-1.5 h-8">
        {(['surface', 'lemma', 'root'] as SearchMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => onChange({ ...input, mode })}
            className={`flex-1 rounded text-xs font-medium transition-colors ${input.mode === mode
              ? 'bg-app-accent text-white shadow-sm'
              : 'bg-white text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
              }`}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      {/* Clitic Toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={input.cliticToggle}
          onChange={(e) => onChange({ ...input, cliticToggle: e.target.checked })}
          disabled={input.mode !== 'surface'}
          className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
        />
        <span
          className={`text-xs ${input.mode === 'surface' ? 'text-app-text-primary' : 'text-app-text-tertiary'
            }`}
        >
          Ignore clitics
        </span>
      </label>
    </div>
  );
}
