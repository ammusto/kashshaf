import type { SearchInput, CombinedSearchQuery } from '../../types/search';
import { useSearchForm } from '../../contexts/SearchFormContext';
import { SearchInputRow } from './SearchInputRow';
import { AddRowButton } from './AddRowButton';
import { validateWildcard } from '../../utils/wildcardValidation';
import { useOperatingMode } from '../../contexts/OperatingModeContext';

interface BooleanSearchPanelProps {
  onSearch: (combined: CombinedSearchQuery) => void;
  onClearForm: () => void;
  loading: boolean;
  showToast: (message: string) => void;
}

export function BooleanSearchPanel({
  onSearch,
  onClearForm,
  loading,
  showToast,
}: BooleanSearchPanelProps) {
  // The form's state is the store's, so it survives the sidebar folding.
  const { activeTab, setActiveTab, andInputs, setAndInputs, orInputs, setOrInputs, nextInputId } = useSearchForm();
  const { capabilities } = useOperatingMode();
  const wildcardGrammar = capabilities?.wildcard_grammar ?? 'glob';

  const currentInputs = activeTab === 'and' ? andInputs : orInputs;
  const setCurrentInputs = activeTab === 'and' ? setAndInputs : setOrInputs;

  const handleAddInput = () => {
    if (currentInputs.length >= 3) return;
    const newInput: SearchInput = {
      id: nextInputId(),
      query: '',
      mode: 'surface',
      cliticToggle: false,
    };
    setCurrentInputs([...currentInputs, newInput]);
  };

  const handleRemoveInput = (id: number) => {
    if (currentInputs.length <= 1) return;
    setCurrentInputs(currentInputs.filter((inp) => inp.id !== id));
  };

  const handleUpdateInput = (id: number, updated: SearchInput) => {
    setCurrentInputs(currentInputs.map((inp) => (inp.id === id ? updated : inp)));
  };

  const handleClear = () => {
    setAndInputs([{ id: nextInputId(), query: '', mode: 'surface', cliticToggle: false }]);
    setOrInputs([{ id: nextInputId(), query: '', mode: 'surface', cliticToggle: false }]);
    setActiveTab('and');
    onClearForm();
  };

  const handleSearch = () => {
    const validAndInputs = andInputs.filter((inp) => inp.query.trim());
    const validOrInputs = orInputs.filter((inp) => inp.query.trim());

    if (validAndInputs.length === 0 && validOrInputs.length === 0) return;

    const allInputs = [...validAndInputs, ...validOrInputs];

    // Validate each input's wildcard usage under the engine's grammar
    for (const input of allInputs) {
      const validation = validateWildcard(input.query, input.mode, wildcardGrammar);
      if (!validation.valid) {
        showToast(validation.error || 'Invalid wildcard usage');
        return;
      }
    }

    onSearch({
      andInputs: validAndInputs,
      orInputs: validOrInputs,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const hasValidQuery = andInputs.some((inp) => inp.query.trim()) || orInputs.some((inp) => inp.query.trim());

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
          Reset Search
        </button>
      </div>

      {/* AND/OR Tab Toggle */}
      <div className="flex gap-1 h-8 flex-shrink-0">
        <button
          onClick={() => setActiveTab('and')}
          className={`flex-1 rounded text-xs font-medium transition-colors ${activeTab === 'and'
            ? 'bg-app-accent-light text-app-accent border border-app-accent'
            : 'bg-white text-app-text-secondary hover:bg-app-surface-variant border border-app-border-light'
            }`}
        >
          AND
        </button>
        <button
          onClick={() => setActiveTab('or')}
          className={`flex-1 rounded text-xs font-medium transition-colors ${activeTab === 'or'
            ? 'bg-app-accent-light text-app-accent border border-app-accent'
            : 'bg-white text-app-text-secondary hover:bg-app-surface-variant border border-app-border-light'
            }`}
        >
          OR
        </button>
      </div>

      {/* Search Inputs (scrollable) */}
      <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
        {currentInputs.map((input) => (
          <SearchInputRow
            key={input.id}
            input={input}
            onChange={(updated) => handleUpdateInput(input.id, updated)}
            onRemove={() => handleRemoveInput(input.id)}
            canRemove={currentInputs.length > 1}
          />
        ))}
      </div>

      {/* Add Input Button */}
      {currentInputs.length < 3 && <AddRowButton label="+ Add search term" onClick={handleAddInput} />}

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
