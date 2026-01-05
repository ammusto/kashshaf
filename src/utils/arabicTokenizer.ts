/**
 * Arabic tokenization utilities.
 *
 * Core invariant: Token indices are semantic positions, not character positions.
 * At display time, we walk the visible text and count Arabic words.
 * Token #N is the Nth Arabic word encountered.
 *
 * IMPORTANT: Token counting must match Python's preprocessing pipeline.
 * The Python tokenizer applies: strip_punct, strip_latin, strip_digits,
 * normalize_unicode before CAMeL tokenization. Here we  skip the same
 * characters when counting tokens for display highlighting to match.
 */

// Arabic Unicode ranges
const ARABIC_LETTER_RANGES = [
  [0x0600, 0x06FF],  // Arabic
  [0x0750, 0x077F],  // Arabic Supplement
  [0x08A0, 0x08FF],  // Arabic Extended-A
];

// Tashkil (diacritics) - part of current word, not separate tokens
const TASHKIL_RANGE = [0x064B, 0x065F];
const SUPERSCRIPT_ALEF = 0x0670;

// Punctuation symbols that Python strips (must match process_batch.py)
const PUNCT_SYMBOLS = new Set([
  // Common punctuation
  '.', ',', '،', ':', ';', '!', '?', '؟', '؛', '«', '»', '"', '"', "'", "'",
  '(', ')', '[', ']', '{', '}', '⦗', '⦘', '﴾', '﴿', '/', '\\', '–', '—', '-',
  '_', '…', '·', '•', '●', '○', '◦',
  // Arabic-specific punctuation
  '۔', '؍', '٫', '٬', '٭',
  // Mathematical and misc symbols
  '±', '×', '÷', '=', '≠', '<', '>', '≤', '≥', '∞', '∑', '∏', '√', '∫', '∂', '∇',
  // Other punctuation marks
  '¡', '¿', '†', '‡', '§', '¶', '©', '®', '™', '°', '′', '″', '‴',
]);

/**
 * Check if character is a Latin letter (matches Python's LATIN_PATTERN).
 */
function isLatinLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  // A-Z
  if (code >= 0x41 && code <= 0x5A) return true;
  // a-z
  if (code >= 0x61 && code <= 0x7A) return true;
  // Latin Extended (accented letters): U+00C0-U+024F
  if (code >= 0x00C0 && code <= 0x024F) return true;
  // Latin Extended Additional: U+1E00-U+1EFF
  if (code >= 0x1E00 && code <= 0x1EFF) return true;
  return false;
}

/**
 * Check if character is a digit (Arabic or Western).
 */
function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  // Western digits 0-9
  if (code >= 0x30 && code <= 0x39) return true;
  // Arabic-Indic digits ٠-٩
  if (code >= 0x0660 && code <= 0x0669) return true;
  // Extended Arabic-Indic digits ۰-۹
  if (code >= 0x06F0 && code <= 0x06F9) return true;
  return false;
}

/**
 * Check if character should be skipped during token counting.
 * This matches Python's strip_punct, strip_latin, strip_digits.
 */
function shouldSkipForTokenCounting(char: string): boolean {
  if (PUNCT_SYMBOLS.has(char)) return true;
  if (isLatinLetter(char)) return true;
  if (isDigit(char)) return true;
  return false;
}

export function isArabicLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  for (const [start, end] of ARABIC_LETTER_RANGES) {
    if (code >= start && code <= end) {
      // Exclude tashkil from being considered "letters" for word boundary purposes
      if (code >= TASHKIL_RANGE[0] && code <= TASHKIL_RANGE[1]) return false;
      if (code === SUPERSCRIPT_ALEF) return false;
      return true;
    }
  }
  return false;
}

export function isTashkil(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= TASHKIL_RANGE[0] && code <= TASHKIL_RANGE[1]) || code === SUPERSCRIPT_ALEF;
}

export function isArabicChar(char: string): boolean {
  return isArabicLetter(char) || isTashkil(char);
}

/**
 * Build a mapping from character position to token index.
 *
 * IMPORTANT: Token counting must match Python's preprocessing pipeline.
 * Python strips punctuation, Latin letters, and digits BEFORE tokenizing.
 * We must count tokens the same way, but map display characters to those tokens.
 *
 * @param text - The display text (after HTML stripping)
 * @returns Array where each element is the token index for that character, or null for non-Arabic
 */
export function buildCharToTokenMap(text: string): (number | null)[] {
  const charToToken: (number | null)[] = new Array(text.length);
  let currentTokenIdx = 0;
  let inWord = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Skip characters that Python strips (they don't affect token counting)
    if (shouldSkipForTokenCounting(char)) {
      charToToken[i] = null;
      // Note: we do NOT end the word here because these chars are stripped,
      // not treated as word boundaries. The word continues through them.
      continue;
    }

    if (isArabicLetter(char) || isTashkil(char)) {
      charToToken[i] = currentTokenIdx;
      inWord = true;
    } else {
      // Non-Arabic, non-skipped character (whitespace, newlines, etc.)
      // This is a true word boundary
      charToToken[i] = null;
      if (inWord) {
        currentTokenIdx++;
        inWord = false;
      }
    }
  }

  return charToToken;
}

/**
 * Get the total token count from the char-to-token map.
 */
export function getTokenCount(charToToken: (number | null)[]): number {
  let maxIdx = -1;
  for (const idx of charToToken) {
    if (idx !== null && idx > maxIdx) {
      maxIdx = idx;
    }
  }
  return maxIdx + 1;
}

export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Get character ranges that should be highlighted based on matched token indices.
 *
 * @param charToToken - The char-to-token mapping
 * @param matchedIndices - Set of token indices that matched
 * @returns Array of {start, end} character ranges (inclusive start, exclusive end)
 */
export function getHighlightRanges(
  charToToken: (number | null)[],
  matchedIndices: Set<number>
): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let currentRange: HighlightRange | null = null;

  for (let i = 0; i < charToToken.length; i++) {
    const tokenIdx = charToToken[i];

    if (tokenIdx !== null && matchedIndices.has(tokenIdx)) {
      if (currentRange === null) {
        currentRange = { start: i, end: i + 1 };
      } else {
        currentRange.end = i + 1;
      }
    } else {
      if (currentRange !== null) {
        ranges.push(currentRange);
        currentRange = null;
      }
    }
  }

  if (currentRange !== null) {
    ranges.push(currentRange);
  }

  return ranges;
}

/**
 * Strip HTML tags from text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

/**
 * Get token index at a specific character position.
 */
export function getTokenAtPosition(charToToken: (number | null)[], position: number): number | null {
  if (position < 0 || position >= charToToken.length) return null;
  return charToToken[position];
}

/**
 * Find the character range for a specific token index.
 */
export function getTokenCharRange(charToToken: (number | null)[], tokenIdx: number): HighlightRange | null {
  let start = -1;
  let end = -1;

  for (let i = 0; i < charToToken.length; i++) {
    if (charToToken[i] === tokenIdx) {
      if (start === -1) start = i;
      end = i + 1;
    } else if (start !== -1) {
      break;
    }
  }

  if (start === -1) return null;
  return { start, end };
}

/**
 * Find snippet range centered on a token index with context.
 *
 * @param charToToken - The char-to-token mapping
 * @param centerTokenIdx - The token index to center around (typically first match)
 * @param tokensBefore - Maximum tokens to show before the center token
 * @param tokensAfter - Tokens to show after the center token
 * @param maxDistanceFromStart - If provided, ensures the center token is at most this many
 *                               tokens from the start of the snippet. If the match would be
 *                               farther, the snippet start is shifted forward.
 */
export function getSnippetRange(
  charToToken: (number | null)[],
  centerTokenIdx: number,
  tokensBefore: number = 10,
  tokensAfter: number = 20,
  maxDistanceFromStart?: number
): { start: number; end: number; startToken: number; endToken: number; truncatedStart: boolean } {
  const totalTokens = getTokenCount(charToToken);

  let startToken = Math.max(0, centerTokenIdx - tokensBefore);
  const endToken = Math.min(totalTokens, centerTokenIdx + tokensAfter + 1);

  // If maxDistanceFromStart is specified, ensure the match is within that distance
  // Also track if we truncated from the original start of the text
  let truncatedStart = startToken > 0;
  if (maxDistanceFromStart !== undefined && maxDistanceFromStart >= 0) {
    const distanceFromStart = centerTokenIdx - startToken;
    if (distanceFromStart > maxDistanceFromStart) {
      // Shift the start forward so the match is exactly maxDistanceFromStart tokens in
      startToken = centerTokenIdx - maxDistanceFromStart;
      truncatedStart = true;
    }
  }

  let start = charToToken.length;
  let end = 0;

  for (let i = 0; i < charToToken.length; i++) {
    const tokenIdx = charToToken[i];
    if (tokenIdx !== null && tokenIdx >= startToken && tokenIdx < endToken) {
      if (i < start) start = i;
      if (i + 1 > end) end = i + 1;
    }
  }

  if (start >= charToToken.length) {
    return { start: 0, end: charToToken.length, startToken: 0, endToken: totalTokens, truncatedStart: false };
  }

  return { start, end, startToken, endToken, truncatedStart };
}
