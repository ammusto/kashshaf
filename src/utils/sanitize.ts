/**
 * Text sanitization utilities for search inputs
 */

/**
 * Punctuation marks to strip from search queries.
 * Includes English punctuation, Arabic punctuation, and common symbols.
 */
const PUNCTUATION_PATTERN = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~،؛؟«»‹›""''「」『』【】〈〉《》〔〕…—–·•°¬¨´¸'"٪٫٬۔。、]/g;

/**
 * Strip punctuation from a search query.
 * Removes English punctuation, Arabic punctuation (،؛؟), quotes, and other symbols.
 * Preserves Arabic letters, numbers, spaces, and the asterisk (*) for wildcard searches.
 *
 * @param query - The search query to sanitize
 * @returns The query with punctuation removed
 */
export function stripPunctuation(query: string): string {
  return query
    .replace(PUNCTUATION_PATTERN, '')
    .replace(/\s+/g, ' ')  // Collapse multiple spaces
    .trim();
}
