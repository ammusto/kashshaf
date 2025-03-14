/**
 * Normalizes Arabic text by:
 * - Removing diacritics (tashkeel)
 * - Normalizing hamzas (أ -> ا, ؤ -> و, etc.)
 * - Normalizing alifs (آ -> ا, إ -> ا, etc.)
 * - Normalizing tatweel (kashida)
 */
export const normalizeArabicText = (text: string): string => {
  if (!text) return '';
  
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
  
  // Normalize taa marbouta
  normalized = normalized
    .replace(/ة/g, 'ه');
  
  // Remove tatweel (kashida)
  normalized = normalized
    .replace(/ـ/g, '');
  
  return normalized;
};

/**
 * Processes OpenSearch highlighted text
 * Splits the highlight into pre, match, post segments
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
  const cleanPre = highlight.substring(0, startIdx).replace(/<[^>]*>?/gm, '');
  const cleanMatch = highlight.substring(startIdx + matchStart.length, endIdx).replace(/<[^>]*>?/gm, '');
  const cleanPost = highlight.substring(endIdx + matchEnd.length).replace(/<[^>]*>?/gm, '');
  
  return {
    pre: cleanPre,
    match: cleanMatch,
    post: cleanPost
  };
};

/**
 * Creates an OpenSearch query string with proper Arabic normalization
 */
export const createSearchQueryString = (query: string): string => {
  const normalized = normalizeArabicText(query);
  // Escape special characters for OpenSearch
  const escaped = normalized.replace(/[+\-=&|><!(){}[\]^"~*?:\\\/]/g, '\\$&');
  return escaped;
};