export const normalizeArabicText = (text: string): string => {
  if (!text) return '';
  
  // Check if the query has wildcards - preserve them by only normalizing parts between wildcards
  if (text.includes('*')) {
    // Split by asterisk and normalize each part separately, then rejoin
    const parts = text.split('*');
    const normalizedParts = parts.map(part => {
      // Apply standard normalization to each part
      let normalized = part.replace(/[\u064B-\u0652]/g, '');
      
      normalized = normalized
        .replace(/[أإآ]/g, 'ا')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ى');
      
      normalized = normalized
        .replace(/[ىی]/g, 'ي');
      
      normalized = normalized
        .replace(/ـ/g, '');
      
      return normalized;
    });
    
    // Rejoin with asterisks
    return normalizedParts.join('*');
  }
  
  // Standard normalization for non-wildcard queries
  // Remove diacritics (tashkeel)
  // This includes: َ ً ُ ٌ ِ ٍ ْ ّ
  let normalized = text.replace(/[\u064B-\u0652]/g, '');
  
  // Normalize alifs with hamza
  normalized = normalized
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ى');
  
  // Normalize alif maqsura and ya
  normalized = normalized
    .replace(/[ىی]/g, 'ي');
  
  // Remove tatweel (kashida)
  normalized = normalized
    .replace(/ـ/g, '');
  
  return normalized;
};

/**
 * Processes OpenSearch highlighted text
 * Splits the highlight into pre, match, post segments
 * Removes text in parentheses that contains digits
 */
export const processHighlight = (highlight: string): { pre: string; match: string; post: string } => {
  const matchStart = '<em>';
  const matchEnd = '</em>';
  
  const startIdx = highlight.indexOf(matchStart);
  const endIdx = highlight.indexOf(matchEnd);
  
  if (startIdx === -1 || endIdx === -1) {
    return {
      pre: highlight,
      match: '',
      post: ''
    };
  }
  
  // Clean all text of any other HTML tags
  let cleanPre = highlight.substring(0, startIdx).replace(/<[^>]*>?/gm, '');
  let cleanMatch = highlight.substring(startIdx + matchStart.length, endIdx).replace(/<[^>]*>?/gm, '');
  let cleanPost = highlight.substring(endIdx + matchEnd.length).replace(/<[^>]*>?/gm, '');
  
  // Remove content in parentheses that contains digits (both Western and Arabic numerals)
  // Arabic numerals: ٠١٢٣٤٥٦٧٨٩ (Unicode range \u0660-\u0669)
  const digitParenthesesRegex = /\([^)]*[\d٠-٩][^)]*\)/g;
  cleanPre = cleanPre.replace(digitParenthesesRegex, '');
  cleanMatch = cleanMatch.replace(digitParenthesesRegex, '');
  cleanPost = cleanPost.replace(digitParenthesesRegex, '');
  
  // Remove standalone numbers (Western or Arabic digits) that are over 3 digits in length
  // This regex matches:
  // 1. Numbers with spaces or punctuation around them
  // 2. Numbers at the beginning or end of text
  // 3. Only numbers that are 4 or more digits long
  const standaloneNumberRegex = /(\s|^)[\d٠-٩]{4,}(\s|$|\.|,|;|:)/g;
  
  // Replace with just the space(s) that were captured (to maintain spacing)
  cleanPre = cleanPre.replace(standaloneNumberRegex, '$1 $2').replace(/\s+/g, ' ');
  cleanMatch = cleanMatch.replace(standaloneNumberRegex, '$1 $2').replace(/\s+/g, ' ');
  cleanPost = cleanPost.replace(standaloneNumberRegex, '$1 $2').replace(/\s+/g, ' ');
  
  // Remove all percentage symbols
  cleanPre = cleanPre.replace(/%/g, '');
  cleanMatch = cleanMatch.replace(/%/g, '');
  cleanPost = cleanPost.replace(/%/g, '');
  
  // Clean up any double spaces that might be left after removing content
  cleanPre = cleanPre.replace(/\s+/g, ' ').trim();
  cleanMatch = cleanMatch.replace(/\s+/g, ' ').trim();
  cleanPost = cleanPost.replace(/\s+/g, ' ').trim();
  
  return {
    pre: cleanPre,
    match: cleanMatch,
    post: cleanPost
  };
};

/**
 * Creates an OpenSearch query string with proper Arabic normalization
 * Preserves wildcards for OpenSearch queries
 */
export const createSearchQueryString = (query: string): string => {
  const normalized = normalizeArabicText(query);
  
  // If query contains wildcards, escape special characters except asterisks
  if (query.includes('*')) {
    return normalized.replace(/[+\-=&|><!(){}[\]^"~?:\\]/g, '\\$&');
  }
  
  // Otherwise, escape all special characters for OpenSearch
  return normalized.replace(/[+\-=&|><!(){}[\]^"~*?:\\]/g, '\\$&');
};