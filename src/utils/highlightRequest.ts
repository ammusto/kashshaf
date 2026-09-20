import type { SearchTerm } from '../api';
import type { SearchContext } from '../types/search';
import { getSearchTermsFromContext } from '../hooks/useReaderNavigation';

/**
 * What the reader asks the page request to highlight: the terms of the
 * running search, or the name patterns, with a key that changes exactly
 * when the highlights would. Pages loaded under one key are asked for again
 * under another; under the same key, never.
 */
export interface HighlightRequest {
  key: string;
  terms?: SearchTerm[];
  namePatterns?: string[];
}

export function highlightRequestOf(context: SearchContext | null): HighlightRequest | null {
  if (!context) return null;
  if (context.type === 'name') {
    // The displayed patterns; the server expands them for the page.
    const patterns = context.namePatterns?.flat() ?? [];
    return patterns.length > 0 ? { key: `name|${patterns.join('|')}`, namePatterns: patterns } : null;
  }
  const terms = getSearchTermsFromContext(context);
  if (!terms || terms.length === 0) return null;
  return { key: `${context.type}|${terms.map((t) => `${t.mode}:${t.query}`).join('|')}`, terms };
}
