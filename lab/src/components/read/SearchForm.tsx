import type { SearchInput, SearchMode } from '../../api/search';
import { LONG_PHRASE_NOTE, phraseExceedsCrossPageSpan } from '@kashshaf/shared';

/**
 * The search form, permanently in the panel's left rail (Phase 7 B).
 *
 * Kashshaf's `sidebar/BooleanSearchPanel` and `sidebar/SearchInputRow`, with
 * the same AND/OR tabs, the same three modes per term, the same clitic
 * toggle and the same limit of three rows a tab. What is dropped is the
 * corpus selector and the wildcard validation, neither of which applies to a
 * search inside one text.
 */

export function SearchForm({
  tab,
  onTab,
  andInputs,
  orInputs,
  onChange,
  onAdd,
  onRemove,
  onSearch,
  onClear,
  running,
  disabled,
}: {
  tab: 'and' | 'or';
  onTab: (t: 'and' | 'or') => void;
  andInputs: SearchInput[];
  orInputs: SearchInput[];
  onChange: (tab: 'and' | 'or', input: SearchInput) => void;
  onAdd: (tab: 'and' | 'or') => void;
  onRemove: (tab: 'and' | 'or', id: number) => void;
  onSearch: () => void;
  onClear: () => void;
  running: boolean;
  disabled: boolean;
}) {
  const inputs = tab === 'and' ? andInputs : orInputs;
  const filled = (xs: SearchInput[]) => xs.filter((i) => i.query.trim()).length;
  const has = filled(andInputs) + filled(orInputs) > 0;

  return (
    <div
      className="p-5 space-y-4 flex flex-col h-full overflow-y-auto"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSearch();
      }}
    >
      <div className="flex items-center justify-between flex-shrink-0">
        <label className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">Search this text</label>
        <button onClick={onClear} className="text-xs text-app-text-secondary hover:text-red-500 transition-colors">
          Clear form
        </button>
      </div>

      <div className="flex gap-1 h-8 flex-shrink-0">
        {(['and', 'or'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={`flex-1 rounded text-xs font-medium transition-colors border ${
              tab === t
                ? 'bg-app-accent-light text-app-accent border-app-accent'
                : 'bg-app-surface text-app-text-secondary hover:bg-app-surface-variant border-app-border-light'
            }`}
          >
            {t.toUpperCase()}
            {filled(t === 'and' ? andInputs : orInputs) > 0 && ` (${filled(t === 'and' ? andInputs : orInputs)})`}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-app-text-secondary">
        {tab === 'and' ? 'Every term must be on the page.' : 'Any one of these terms is enough.'}
      </p>

      {inputs.map((input) => (
        <Row
          key={input.id}
          input={input}
          onChange={(u) => onChange(tab, u)}
          onRemove={() => onRemove(tab, input.id)}
          canRemove={inputs.length > 1}
        />
      ))}

      {inputs.length < 3 && (
        <button
          onClick={() => onAdd(tab)}
          className="w-full h-8 text-xs rounded border border-dashed border-app-border-medium
                     text-app-text-secondary hover:bg-app-surface-variant"
        >
          + Add a term
        </button>
      )}

      <button
        onClick={onSearch}
        disabled={!has || running || disabled}
        data-testid="run-search"
        className="w-full h-9 text-sm font-medium rounded-lg bg-app-accent text-white
                   hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {running ? 'Searching…' : 'Search'}
      </button>
    </div>
  );
}

function Row({
  input,
  onChange,
  onRemove,
  canRemove,
}: {
  input: SearchInput;
  onChange: (u: SearchInput) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="space-y-2 p-3 rounded-lg border border-app-border-light">
      <div className="flex gap-2 items-center">
        <input
          type="text"
          dir="rtl"
          value={input.query}
          onChange={(e) => onChange({ ...input, query: e.target.value })}
          placeholder="ابحث..."
          aria-label="Term"
          className="flex-1 min-w-0 h-10 px-4 rounded-md border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                     text-right font-arabic bg-app-surface text-lg"
        />
        {canRemove && (
          <button
            onClick={onRemove}
            aria-label="Remove this term"
            title="Remove"
            className="w-8 h-8 flex items-center justify-center rounded-md bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      {/* A phrase longer than the boundary index covers (21 tokens) is still
          searched; it may just miss a page break. No cap, no refusal. */}
      {phraseExceedsCrossPageSpan(input.query) && (
        <p className="text-[11px] text-app-text-tertiary" data-testid="long-phrase-note">
          {LONG_PHRASE_NOTE}
        </p>
      )}

      <div className="flex gap-1.5 h-8">
        {(['surface', 'lemma', 'root'] as SearchMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => onChange({ ...input, mode })}
            className={`flex-1 rounded text-xs font-medium transition-colors ${
              input.mode === mode
                ? 'bg-app-accent text-white shadow-sm'
                : 'bg-app-surface text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
            }`}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={input.cliticToggle}
          onChange={(e) => onChange({ ...input, cliticToggle: e.target.checked })}
          disabled={input.mode !== 'surface'}
          className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
        />
        <span className={`text-xs ${input.mode === 'surface' ? 'text-app-text-primary' : 'text-app-text-secondary'}`}>
          Ignore clitics
        </span>
      </label>
    </div>
  );
}
