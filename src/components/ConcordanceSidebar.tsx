import type { SearchMode } from '../types';

interface ConcordanceSidebarProps {
  query: string;
  onQueryChange: (query: string) => void;
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  ignoreClitics: boolean;
  onIgnoreCliticsChange: (ignore: boolean) => void;
  onSearch: () => void;
  onExport: () => void;
  loading: boolean;
  hasResults: boolean;
  totalHits: number;
}

export function ConcordanceSidebar({
  query,
  onQueryChange,
  mode,
  onModeChange,
  ignoreClitics,
  onIgnoreCliticsChange,
  onSearch,
  onExport,
  loading,
  hasResults,
  totalHits,
}: ConcordanceSidebarProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query.trim()) {
      onSearch();
    }
  };

  const isSearchDisabled = loading || !query.trim();
  const isExportDisabled = !hasResults || loading;

  return (
    <div className="space-y-3 flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <label className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">
          Search
        </label>
      </div>

      {/* Search Input */}
      <div className="space-y-2 p-3 bg-app-surface-variant rounded-lg">
        <input
          type="text"
          dir="rtl"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="ابحث..."
          className="w-full h-10 px-4 rounded-md border border-app-border-medium
                   focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                   text-right font-arabic bg-white text-xl"
        />

        {/* Mode Selector */}
        <div className="flex gap-1.5 h-8">
          {(['surface', 'lemma', 'root'] as SearchMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`flex-1 rounded text-xs font-medium transition-colors ${
                mode === m
                  ? 'bg-app-accent text-white shadow-sm'
                  : 'bg-white text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
              }`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Ignore Clitics Checkbox */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={ignoreClitics}
            onChange={(e) => onIgnoreCliticsChange(e.target.checked)}
            disabled={mode !== 'surface'}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span
            className={`text-xs ${
              mode === 'surface' ? 'text-app-text-primary' : 'text-app-text-tertiary'
            }`}
          >
            Ignore clitics
          </span>
        </label>
      </div>

      {/* Search Button */}
      <button
        onClick={onSearch}
        disabled={isSearchDisabled}
        className="w-full h-11 bg-app-accent hover:bg-app-accent-hover
                 text-white rounded-lg font-semibold text-sm
                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                 shadow-sm flex-shrink-0"
      >
        {loading ? 'Searching...' : 'Search'}
      </button>

      {/* Export Button */}
      <button
        onClick={onExport}
        disabled={isExportDisabled}
        className="w-full h-10 bg-white hover:bg-app-surface-variant
                 text-app-text-primary rounded-lg font-medium text-sm
                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                 border border-app-border-light flex-shrink-0
                 flex items-center justify-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        Export CSV {hasResults && totalHits > 0 ? `(max 1000)` : ''}
      </button>

      {/* Results info */}
      {hasResults && totalHits > 0 && (
        <div className="text-xs text-app-text-tertiary text-center">
          {totalHits.toLocaleString()} hits found
        </div>
      )}
    </div>
  );
}
