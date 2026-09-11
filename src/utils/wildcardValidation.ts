/**
 * Wildcard validation for Arabic text search.
 *
 * Two grammars, chosen by the engine (`EngineCapabilities.wildcard_grammar`):
 *
 * `glob` (compound index): `*`-only glob, any number of `*` per word, any
 * position (`أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`). Rules:
 *   1. every word containing `*` has at least 2 literal Arabic letters
 *   2. surface mode only
 * Several wildcard words in one phrase are fine; each slot expands on its own.
 *
 * `legacy` (three-field index, RegexQuery path):
 *   1. only one `*` per search input
 *   2. `*` cannot be at the start of a word
 *   3. surface mode only
 *
 * The Rust twin is `validate_wildcard_query` in `engine/src/search.rs`;
 * keep the rules and the error strings identical.
 */

import type { SearchMode, WildcardGrammar } from '../types';

export interface WildcardValidationResult {
  valid: boolean;
  error?: string;
}

export const WILDCARD_ERR_MODE = 'Wildcards only supported in Surface mode';
export const WILDCARD_ERR_LETTERS = 'A wildcard word needs at least 2 letters besides *';
export const WILDCARD_ERR_ONE = 'Only one wildcard (*) allowed per search term';
export const WILDCARD_ERR_START = 'Wildcard cannot be at start of word';

/**
 * Validates a search query for wildcard usage under the given grammar.
 */
export function validateWildcard(
  query: string,
  mode: SearchMode,
  grammar: WildcardGrammar = 'glob'
): WildcardValidationResult {
  const trimmedQuery = query.trim();

  // No wildcard in query - always valid
  if (!trimmedQuery.includes('*')) {
    return { valid: true };
  }

  // Wildcard only in Surface mode
  if (mode !== 'surface') {
    return { valid: false, error: WILDCARD_ERR_MODE };
  }

  const words = trimmedQuery.split(/\s+/);

  if (grammar === 'legacy') {
    const wildcardCount = (trimmedQuery.match(/\*/g) || []).length;
    if (wildcardCount > 1) {
      return { valid: false, error: WILDCARD_ERR_ONE };
    }
    for (const word of words) {
      if (word.startsWith('*')) {
        return { valid: false, error: WILDCARD_ERR_START };
      }
    }
    return { valid: true };
  }

  for (const word of words) {
    if (!word.includes('*')) continue;
    const literal = word.replace(/\*/g, '');
    if (countArabicLetters(literal) < 2) {
      return { valid: false, error: WILDCARD_ERR_LETTERS };
    }
  }
  return { valid: true };
}

/**
 * Count Arabic letters (excluding diacritics/tashkeel). Mirrors
 * `normalize::count_arabic_letters` in the engine.
 */
function countArabicLetters(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Arabic letters range: 0x0621-0x064A (excluding diacritics 0x064B-0x065F)
    if (code >= 0x0621 && code <= 0x064A) {
      count++;
    }
    // Extended Arabic letters
    if (code >= 0x0671 && code <= 0x06D3) {
      count++;
    }
  }
  return count;
}

/**
 * Parses a wildcard query into its components
 */
export interface WildcardQueryInfo {
  hasWildcard: boolean;
  wildcardTermIndex: number;  // Which word has the wildcard (0-based)
  wildcardType: 'prefix' | 'internal' | 'none';  // prefix: أب*, internal: أح*مد
  prefix?: string;  // Characters before *
  suffix?: string;  // Characters after * (for internal wildcards)
  terms: string[];  // All terms in the query
}

export function parseWildcardQuery(query: string): WildcardQueryInfo {
  const words = query.trim().split(/\s+/).filter(w => w.length > 0);

  const result: WildcardQueryInfo = {
    hasWildcard: false,
    wildcardTermIndex: -1,
    wildcardType: 'none',
    terms: words,
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.includes('*')) {
      result.hasWildcard = true;
      result.wildcardTermIndex = i;

      const wildcardIndex = word.indexOf('*');
      result.prefix = word.substring(0, wildcardIndex);

      if (wildcardIndex < word.length - 1) {
        result.wildcardType = 'internal';
        result.suffix = word.substring(wildcardIndex + 1);
      } else {
        result.wildcardType = 'prefix';
      }

      break;  // Only one wildcard allowed
    }
  }

  return result;
}
