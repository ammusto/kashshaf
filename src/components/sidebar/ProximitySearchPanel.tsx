import { useState } from 'react';
import type { ProximitySearchQuery } from '../../types/search';
import { ProximityInputRow, type ProximityInput } from './ProximityInputRow';

interface ProximitySearchPanelProps {
  onSearch: (query: ProximitySearchQuery) => void;
  onClearForm: () => void;
  loading: boolean;
}

export function ProximitySearchPanel({
  onSearch,
  onClearForm,
  loading,
}: ProximitySearchPanelProps) {
  const [proximityInput1, setProximityInput1] = useState<ProximityInput>({ term: '', field: 'surface' });
  const [proximityInput2, setProximityInput2] = useState<ProximityInput>({ term: '', field: 'surface' });
  const [proximityDistance, setProximityDistance] = useState(10);

  const handleClear = () => {
    setProximityInput1({ term: '', field: 'surface' });
    setProximityInput2({ term: '', field: 'surface' });
    setProximityDistance(10);
    onClearForm();
  };

  const handleSearch = () => {
    if (!proximityInput1.term.trim() || !proximityInput2.term.trim()) return;

    onSearch({
      term1: proximityInput1.term.trim(),
      field1: proximityInput1.field,
      term2: proximityInput2.term.trim(),
      field2: proximityInput2.field,
      distance: proximityDistance,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const hasValidQuery = proximityInput1.term.trim() && proximityInput2.term.trim();

  return (
    <div className="space-y-3 flex-1 flex flex-col min-h-0 overflow-hidden" onKeyDown={handleKeyDown}>
      <div className="flex items-center justify-between flex-shrink-0">
        <label className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">
          Search
        </label>
        <button
          onClick={handleClear}
          className="text-xs text-app-text-tertiary hover:text-red-500 transition-colors"
        >
          Clear form
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {/* Term 1 */}
        <ProximityInputRow
          label="Term 1"
          input={proximityInput1}
          onChange={setProximityInput1}
        />

        {/* Distance indicator */}
        <div className="flex items-center gap-2 px-2">
          <div className="flex-1 h-px bg-app-border-light" />
          <span className="text-xs text-app-text-tertiary">within</span>
          <input
            type="number"
            min={1}
            max={100}
            value={proximityDistance}
            onChange={(e) => setProximityDistance(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
            className="w-14 h-7 px-2 text-center text-sm rounded border border-app-border-medium
                     focus:outline-none focus:border-app-accent"
          />
          <span className="text-xs text-app-text-tertiary">tokens</span>
          <div className="flex-1 h-px bg-app-border-light" />
        </div>

        {/* Term 2 */}
        <ProximityInputRow
          label="Term 2"
          input={proximityInput2}
          onChange={setProximityInput2}
        />
      </div>

      {/* Search Button */}
      <button
        onClick={handleSearch}
        disabled={loading || !hasValidQuery}
        className="w-full h-11 bg-app-accent hover:bg-app-accent-hover
                 text-white rounded-lg font-semibold text-sm
                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                 shadow-sm flex-shrink-0"
      >
        {loading ? 'Searching...' : 'Search'}
      </button>
    </div>
  );
}
