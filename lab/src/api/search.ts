/**
 * Search within the current text (spec 1.5 §D).
 *
 * Kashshaf's boolean search narrowed to one book. The clitic toggle expands
 * a surface term into its `و ف ب ل ك` variants as OR terms, exactly as
 * Kashshaf's own bridge does, so the two apps answer a query the same way.
 */

import { invoke } from '@tauri-apps/api/core';
import { stripPunctuation } from '@kashshaf/shared';

export type SearchMode = 'surface' | 'lemma' | 'root';

/** One row of the search form. */
export interface SearchInput {
  id: number;
  query: string;
  mode: SearchMode;
  /** Surface only: also match the word with a proclitic attached. */
  cliticToggle: boolean;
}

export interface Term {
  query: string;
  mode: SearchMode;
}

export interface Hit {
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  /** The page's snippet around the first hit (engine 0.8.0), or the whole page from an older API. */
  body: string;
  /** The token `body` starts at when it is a snippet; absent for a whole page. */
  snippet_start_token?: number;
  score: number;
  /** Token indices the query matched, for the reader's highlight. */
  matched: number[];
  /**
   * The match runs on from this page onto the next, or in from the one
   * before: `matched` is this page's share, `secondary` the other's
   * (corpus 4.3.0's boundary index).
   */
  crosses_page?: boolean;
  secondary?: HitSecondary;
}

/** The other page of a hit across a page break, and its share of the match. */
export interface HitSecondary {
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  matched: number[];
}

export interface SearchResults {
  hits: Hit[];
  total: number;
  elapsed_ms: number;
  capped: boolean;
}

export const PROCLITICS = ['و', 'ف', 'ب', 'ل', 'ك'];

/** Kashshaf's clitic expansion: the word, and the word behind each proclitic. */
export function expandWithClitics(query: string): string[] {
  const sanitized = stripPunctuation(query);
  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [sanitized];
  if (words.length === 1) {
    const word = words[0];
    return [word, ...PROCLITICS.map((p) => p + word)];
  }
  const [first, ...rest] = words;
  const restJoined = rest.join(' ');
  return [words.join(' '), ...PROCLITICS.map((p) => `${p}${first} ${restJoined}`)];
}

/** The form's rows as the backend's two term lists (Kashshaf's rule). */
export function toTerms(andInputs: SearchInput[], orInputs: SearchInput[]): { and_terms: Term[]; or_terms: Term[] } {
  const and_terms: Term[] = [];
  const or_terms: Term[] = [];
  for (const inp of andInputs) {
    if (!inp.query.trim()) continue;
    if (inp.mode === 'surface' && inp.cliticToggle) {
      for (const v of expandWithClitics(inp.query)) or_terms.push({ query: v, mode: 'surface' });
    } else {
      and_terms.push({ query: stripPunctuation(inp.query), mode: inp.mode });
    }
  }
  for (const inp of orInputs) {
    if (!inp.query.trim()) continue;
    if (inp.mode === 'surface' && inp.cliticToggle) {
      for (const v of expandWithClitics(inp.query)) or_terms.push({ query: v, mode: 'surface' });
    } else {
      or_terms.push({ query: stripPunctuation(inp.query), mode: inp.mode });
    }
  }
  return { and_terms, or_terms };
}

export const searchApi = {
  book: (args: { book_id: number; and_terms: Term[]; or_terms: Term[]; limit?: number; offset?: number }) =>
    invoke<SearchResults>('search_book', { args }),
};
