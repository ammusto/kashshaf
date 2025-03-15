/**
 * Strips all Arabic diacritics except shadda from the given text
 * 
 * Arabic diacritics Unicode ranges:
 * - Fathah: \u064E
 * - Kasrah: \u0650
 * - Dammah: \u064F
 * - Sukun: \u0652
 * - Fathatan: \u064B
 * - Kasratan: \u064D
 * - Dammatan: \u064C
 * - Shadda: \u0651 (this one we keep)
 * - Superscript Alef: \u0670
 */
export const stripDiacriticsExceptShadda = (text: string): string => {
  if (!text) return '';
  
  // Remove only specific diacritics, not the entire range which includes digits
  return text.replace(/[\u064B-\u0650\u0652-\u065F\u0670]/g, '');
};

/**
 * Truncates an Arabic title to a maximum number of tokens (words)
 * and adds an ellipsis if truncated
 * 
 * @param title The title text to truncate
 * @param maxTokens Maximum number of tokens/words to keep (default: 4)
 * @returns Truncated title
 */
export const truncateTitle = (title: string, maxTokens: number = 4): string => {
  if (!title) return '';
  
  // Split by whitespace
  const tokens = title.trim().split(/\s+/);
  
  // If title has fewer tokens than the max, return as is
  if (tokens.length <= maxTokens) {
    return title;
  }
  
  // Otherwise, get only the first maxTokens tokens and add ellipsis
  return tokens.slice(0, maxTokens).join(' ') + '...';
};