interface CorpusSelectorProps {
  selectedTextsCount: number;
  onOpenTextSelection: () => void;
  onSaveCollection?: () => void;
}

export function CorpusSelector({
  selectedTextsCount,
  onOpenTextSelection,
  onSaveCollection,
}: CorpusSelectorProps) {
  return (
    <div className="space-y-3 flex-shrink-0">
      <label className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">
        Corpus
      </label>

      {/* Selected Texts Count */}
      <div className="flex items-center gap-2 p-3 bg-app-surface-variant rounded-lg">
        <span className="text-sm text-app-text-primary">Selected Texts:</span>
        <span
          className={`text-sm font-semibold ${selectedTextsCount > 0 ? 'text-app-accent' : 'text-app-text-tertiary'
            }`}
        >
          {selectedTextsCount > 0 ? selectedTextsCount.toLocaleString() : 'All'}
        </span>
      </div>

      {/* Select Texts Button with Save Collection Icon */}
      <div className="flex gap-2">
        <button
          onClick={onOpenTextSelection}
          className="flex-1 h-11 bg-app-accent hover:bg-app-accent-hover
                   text-white rounded-lg font-medium text-sm transition-colors shadow-sm"
        >
          Select Texts
        </button>
        {selectedTextsCount > 0 && onSaveCollection && (
          <button
            onClick={onSaveCollection}
            className="h-11 w-11 bg-green-600 hover:bg-green-700 text-white rounded-lg
                     flex items-center justify-center transition-colors shadow-sm"
            title="Save as Collection"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
