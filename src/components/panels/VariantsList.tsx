import type { VariantsResponse } from '../../api';

interface VariantsListProps {
  data: VariantsResponse;
  onVariantClick: (tuple: string[]) => void;
}

/**
 * Renders the variants list inside ResultsPanel when the user clicks
 * "Variants". Each row is a clickable surface tuple with its frequency.
 * Clicking re-runs the search as a surface phrase for that exact tuple.
 */
export function VariantsList({ data, onVariantClick }: VariantsListProps) {
  if (data.variants.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <span className="text-xs text-app-text-tertiary">
          No variants matched. The query may not produce a phrase that exists in
          the corpus.
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {data.was_sampled && (
        <div className="px-6 py-2 bg-yellow-50 border-b border-yellow-200 text-xs text-yellow-800">
          Sampled {data.scanned_hits.toLocaleString()} of{' '}
          {data.total_hits.toLocaleString()} matching pages. Counts are estimates.
        </div>
      )}
      <ul className="flex-1 overflow-auto divide-y divide-app-border-light">
        {data.variants.map((v, i) => (
          <li key={i}>
            <button
              onClick={() => onVariantClick(v.surface_tuple)}
              className="w-full px-6 py-2 flex items-center gap-4 text-left
                         hover:bg-app-accent-light transition-colors cursor-pointer"
              dir="rtl"
            >
              <span className="text-xl font-arabic text-app-text-primary flex-1 truncate leading-loose">
                {v.surface_tuple.join(' ')}
              </span>
              <span className="text-sm text-app-text-tertiary tabular-nums flex-shrink-0">
                {v.freq.toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
