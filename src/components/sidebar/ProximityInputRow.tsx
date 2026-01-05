import type { TokenField } from '../../types';

export interface ProximityInput {
  term: string;
  field: TokenField;
}

interface ProximityInputRowProps {
  label: string;
  input: ProximityInput;
  onChange: (updated: ProximityInput) => void;
}

export function ProximityInputRow({
  label,
  input,
  onChange,
}: ProximityInputRowProps) {
  return (
    <div className="space-y-2 p-3 bg-app-surface-variant rounded-lg">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-app-text-secondary w-12">{label}</span>
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
      </div>

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
