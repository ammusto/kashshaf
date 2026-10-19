import { stripPunctuation } from '@kashshaf/shared';
import type { CombinedSearchQuery, SearchInput } from '../types/search';
import type { SearchTerm } from '../api';

/**
 * A Boolean form as the request both hosts send: every AND input stays an
 * AND term and every OR input an OR term, and "Ignore clitics" travels as
 * the term's own `clitics` flag for the engine to expand inside that slot.
 *
 * Before 0.8.4 the clients expanded the five proclitic forms themselves and
 * had nowhere to put six alternatives of one AND term but the OR list, so a
 * toggled AND term became OR terms: with two toggled AND terms nothing was
 * left in the AND list and the search returned any form of either word
 * (~30,000 pages for a pair that shares 13).
 */
export interface CombinedRequest {
  and_terms: SearchTerm[];
  or_terms: SearchTerm[];
}

function toTerm(inp: SearchInput): SearchTerm | null {
  const query = stripPunctuation(inp.query).trim();
  if (!query) return null;
  const term: SearchTerm = { query, mode: inp.mode };
  if (inp.mode === 'surface' && inp.cliticToggle) term.clitics = true;
  return term;
}

export function buildCombinedRequest(combined: CombinedSearchQuery): CombinedRequest {
  return {
    and_terms: combined.andInputs.map(toTerm).filter((t): t is SearchTerm => t !== null),
    or_terms: combined.orInputs.map(toTerm).filter((t): t is SearchTerm => t !== null),
  };
}
