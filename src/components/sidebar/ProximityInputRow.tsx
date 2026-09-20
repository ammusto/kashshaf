import type { TokenField } from '../../types';
import { LONG_PHRASE_NOTE, phraseExceedsCrossPageSpan } from '@kashshaf/shared';

export interface ProximityInput {
  term: string;
  field: TokenField;
}

interface ProximityInputRowProps {
  input: ProximityInput;
  onChange: (updated: ProximityInput) => void;
  /** A row that can be taken away again (the third term, a page term). */
  onRemove?: () => void;
  /** What the remove button says it removes, for assistive technology. */
  removeLabel?: string;
  /** A page term is drawn in the colour its highlights take in the reader. */
  tone?: 'chain' | 'page';
}

export function ProximityInputRow({
  input,
  onChange,
  onRemove,
  removeLabel = 'Remove',
  tone = 'chain',
}: ProximityInputRowProps) {
  return (
    <div
      className={`space-y-2 p-3 rounded-lg ${tone === 'page' ? 'bg-amber-50 border border-amber-200' : 'bg-app-surface-variant'}`}
      data-testid={tone === 'page' ? 'page-term-row' : 'proximity-term-row'}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          dir="rtl"
          value={input.term}
          onChange={(e) => onChange({ ...input, term: e.target.value })}
          placeholder="ابحث..."
          className="flex-1 min-w-0 h-10 px-4 rounded-md border border-app-border-medium
                   focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                   text-right font-arabic bg-white text-lg"
        />
        {onRemove && (
          <button
            onClick={onRemove}
            aria-label={removeLabel}
            title="Remove"
            className="w-7 h-7 rounded text-app-text-tertiary hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
          >
            ×
          </button>
        )}
      </div>

      {phraseExceedsCrossPageSpan(input.term) && (
        <p className="text-[11px] text-app-text-tertiary" data-testid="long-phrase-note">
          {LONG_PHRASE_NOTE}
        </p>
      )}

      {/* Field Selector */}
      <div className="flex gap-1.5 h-8">
        {(['surface', 'lemma', 'root'] as TokenField[]).map((field) => (
          <button
            key={field}
            onClick={() => onChange({ ...input, field })}
            className={`flex-1 rounded text-xs font-medium transition-colors ${input.field === field
              ? 'bg-app-accent text-white shadow-sm'
              : 'bg-white text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
              }`}
          >
            {field.charAt(0).toUpperCase() + field.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
