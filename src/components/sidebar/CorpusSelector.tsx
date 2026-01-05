interface CorpusSelectorProps {
  selectedTextsCount: number;
  onOpenTextSelection: () => void;
}

export function CorpusSelector({
  selectedTextsCount,
  onOpenTextSelection,
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

      {/* Select Texts Button */}
      <button
        onClick={onOpenTextSelection}
        className="w-full h-11 bg-app-accent hover:bg-app-accent-hover
                 text-white rounded-lg font-medium text-sm transition-colors shadow-sm"
      >
        Select Texts
      </button>
    </div>
  );
}
