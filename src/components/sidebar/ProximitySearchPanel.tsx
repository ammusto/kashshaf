import type { ProximitySearchQuery } from '../../types/search';
import { PROXIMITY_MAX_PAGE_TERMS, PROXIMITY_MAX_TERMS } from '../../types/search';
import { ProximityInputRow, type ProximityInput } from './ProximityInputRow';
import { useSearchForm } from '../../contexts/SearchFormContext';
import { clampDistance } from '../../utils/proximityQuery';

interface ProximitySearchPanelProps {
  onSearch: (query: ProximitySearchQuery) => void;
  onClearForm: () => void;
  loading: boolean;
}

const emptyInput = (): ProximityInput => ({ term: '', field: 'surface' });

/**
 * The proximity form: a chain of two or three terms with a distance on each
 * link, an ordering switch, and, set apart below, up to two terms that must
 * be somewhere on the page.
 */
export function ProximitySearchPanel({ onSearch, onClearForm, loading }: ProximitySearchPanelProps) {
  // The form's state is the store's, so it survives the sidebar folding.
  const {
    proximityTerms,
    setProximityTerms,
    proximityDistances,
    setProximityDistances,
    proximityOrdered,
    setProximityOrdered,
    proximityPageTerms,
    setProximityPageTerms,
  } = useSearchForm();

  const handleClear = () => {
    setProximityTerms([emptyInput(), emptyInput()]);
    setProximityDistances([10]);
    setProximityOrdered(false);
    setProximityPageTerms([]);
    onClearForm();
  };

  const setTerm = (i: number, v: ProximityInput) => setProximityTerms(proximityTerms.map((t, k) => (k === i ? v : t)));
  const setDistance = (i: number, d: number) => setProximityDistances(proximityDistances.map((x, k) => (k === i ? d : x)));
  const addTerm = () => {
    if (proximityTerms.length >= PROXIMITY_MAX_TERMS) return;
    setProximityTerms([...proximityTerms, emptyInput()]);
    setProximityDistances([...proximityDistances, 10]);
  };
  const removeTerm = (i: number) => {
    if (proximityTerms.length <= 2) return;
    setProximityTerms(proximityTerms.filter((_, k) => k !== i));
    // The link that vanishes is the one leading into the removed term
    // (or out of it, for the first).
    setProximityDistances(proximityDistances.filter((_, k) => k !== Math.max(0, i - 1)));
  };
  const setPageTerm = (i: number, v: ProximityInput) => setProximityPageTerms(proximityPageTerms.map((t, k) => (k === i ? v : t)));
  const addPageTerm = () => {
    if (proximityPageTerms.length >= PROXIMITY_MAX_PAGE_TERMS) return;
    setProximityPageTerms([...proximityPageTerms, emptyInput()]);
  };
  const removePageTerm = (i: number) => setProximityPageTerms(proximityPageTerms.filter((_, k) => k !== i));

  const hasValidQuery = proximityTerms.every((t) => t.term.trim());

  const handleSearch = () => {
    if (!hasValidQuery) return;
    onSearch({
      terms: proximityTerms.map((t) => ({ query: t.term.trim(), mode: t.field })),
      distances: proximityDistances.map(clampDistance),
      ordered: proximityOrdered,
      pageTerms: proximityPageTerms.filter((t) => t.term.trim()).map((t) => ({ query: t.term.trim(), mode: t.field })),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

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

      <div className="flex-1 overflow-y-auto space-y-3 min-h-0" data-testid="proximity-form">
        {proximityTerms.map((input, i) => (
          <div key={i} className="space-y-3">
            {i > 0 && (
              <div className="flex items-center gap-2 px-2" data-testid={`proximity-link-${i}`}>
                <div className="flex-1 h-px bg-app-border-light" />
                <span className="text-xs text-app-text-tertiary">within</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  aria-label={`Distance ${i}`}
                  value={proximityDistances[i - 1] ?? 10}
                  onChange={(e) => setDistance(i - 1, clampDistance(parseInt(e.target.value) || 1))}
                  className="w-14 h-7 px-2 text-center text-sm rounded border border-app-border-medium
                           focus:outline-none focus:border-app-accent"
                />
                <span className="text-xs text-app-text-tertiary">tokens</span>
                <div className="flex-1 h-px bg-app-border-light" />
              </div>
            )}
            <ProximityInputRow
              label={`Term ${i + 1}`}
              input={input}
              onChange={(v) => setTerm(i, v)}
              onRemove={i >= 2 ? () => removeTerm(i) : undefined}
            />
          </div>
        ))}

        <div className="flex items-center justify-between px-1">
          <label className="flex items-center gap-2 text-xs text-app-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={proximityOrdered}
              onChange={(e) => setProximityOrdered(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
            />
            Ordered
            <span className="text-app-text-tertiary" title="The terms must appear in the order written">
              (as written)
            </span>
          </label>
          {proximityTerms.length < PROXIMITY_MAX_TERMS && (
            <button
              onClick={addTerm}
              className="text-xs font-medium text-app-accent hover:underline"
              data-testid="add-proximity-term"
            >
              + Add term
            </button>
          )}
        </div>

        {/* Page terms: not part of the chain, anywhere on the page. Set
            apart so that the two kinds of term read as two kinds. */}
        <div className="border-t border-dashed border-app-border-medium pt-3 space-y-2" data-testid="page-terms">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">
              Also on the page
            </span>
            {proximityPageTerms.length < PROXIMITY_MAX_PAGE_TERMS && (
              <button
                onClick={addPageTerm}
                className="text-xs font-medium text-app-accent hover:underline"
                data-testid="add-page-term"
              >
                + Add page term
              </button>
            )}
          </div>
          {proximityPageTerms.length === 0 && (
            <p className="px-1 text-[11px] text-app-text-tertiary">
              A term the page must contain anywhere, apart from the chain.
            </p>
          )}
          {proximityPageTerms.map((input, i) => (
            <ProximityInputRow
              key={i}
              label={`Page ${i + 1}`}
              input={input}
              onChange={(v) => setPageTerm(i, v)}
              onRemove={() => removePageTerm(i)}
              tone="page"
            />
          ))}
        </div>
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
