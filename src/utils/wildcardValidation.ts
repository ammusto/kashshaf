/**
 * Wildcard validation for Arabic text search
 *
 * Rules:
 * 1. Only one `*` per search input
 * 2. `*` cannot be at start of word (`*منصور` invalid)
 * 3. Internal `*` requires 2+ chars before (`أح*مد` valid, `أ*مد` invalid)
 * 4. Wildcard can be any word position in phrase
 * 5. Solo wildcard term valid (`أب*` alone is fine)
 * 6. Surface mode only - block if used with Lemma/Root mode
 */

import type { SearchMode } from '../types';

export interface WildcardValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a search query for wildcard usage
 */
export function validateWildcard(query: string, mode: SearchMode): WildcardValidationResult {
  const trimmedQuery = query.trim();

  // No wildcard in query - always valid
  if (!trimmedQuery.includes('*')) {
    return { valid: true };
  }

  // Rule 6: Wildcard only in Surface mode
  if (mode !== 'surface') {
    return {
      valid: false,
      error: 'Wildcards only supported in Surface mode'
    };
  }

  // Rule 1: Only one `*` per search input
  const wildcardCount = (trimmedQuery.match(/\*/g) || []).length;
  if (wildcardCount > 1) {
    return {
      valid: false,
      error: 'Only one wildcard (*) allowed per search term'
    };
  }

  // Split into words and check each word for wildcard rules
  const words = trimmedQuery.split(/\s+/);

  for (const word of words) {
    if (!word.includes('*')) continue;

    const wildcardIndex = word.indexOf('*');

    // Rule 2: `*` cannot be at start of word
    if (wildcardIndex === 0) {
      return {
        valid: false,
        error: 'Wildcard cannot be at start of word'
      };
    }

    // Rule 3: Internal `*` requires 2+ chars before
    // Internal means there are characters after the wildcard
    const hasCharsAfter = wildcardIndex < word.length - 1;
    if (hasCharsAfter) {
      // Count characters before wildcard (excluding diacritics)
      const prefix = word.substring(0, wildcardIndex);
      const charCount = countArabicLetters(prefix);

      if (charCount < 2) {
        return {
          valid: false,
          error: 'Internal wildcard requires at least 2 characters before it'
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Count Arabic letters (excluding diacritics/tashkeel)
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
