import { API_USER, API_PASS, API_URL, INDEX, MAX_RESULT_WINDOW, MAX_EXPORT_RESULTS } from '../config/api';
import { SearchResult } from '../types';
import { processHighlight } from '../utils/arabicNormalization';

interface OpenSearchResponse {
  hits: {
    hits: Array<{
      _id: string;
      _source: {
        text_id: number;
        uri: string;
        vol: string;
        collection: string;
        page_id: number;
        page_num: number;
        page_content: string;
      };
      _score: number;
      highlight?: {
        'page_content.proclitic'?: string[];
        'page_content'?: string[];
      };
    }>;
    total: {
      value: number;
    };
  };
  took: number;
}

/**
 * Check if query contains wildcard characters 
 */
const containsWildcard = (query: string): boolean => {
  return query.includes('*');
};

/**
 * Check if query is a phrase (multiple words)
 */
const isPhrase = (query: string): boolean => {
  // Trim whitespace and split by spaces
  const words = query.trim().split(/\s+/);
  // If there's more than one word, it's a phrase
  return words.length > 1;
};

/**
 * Validate search query - phrase searches cannot contain wildcards
 */
const validateSearchQuery = (query: string): boolean => {
  if (isPhrase(query) && containsWildcard(query)) {
    return false; // Invalid: phrase with wildcard
  }
  return true; // Valid query
};

/**
 * Search for texts matching the query and filters
 */
export const searchTexts = async (
  query: string,
  page: number = 1,
  size: number = 50,
  textIds: number[] = [],
  pagesToLoad: number[] = [],
  isExact: boolean = false
): Promise<{ hits: SearchResult[], total: number }> => {
  try {
    // Validate the search query
    if (!validateSearchQuery(query)) {
      throw new Error('Invalid search query: Wildcards are not allowed in phrase searches');
    }

    // Check if we've reached the max result window
    const from = (page - 1) * size;
    
    // Limit 'from' parameter to ensure we don't exceed the max result window
    const adjustedFrom = Math.min(from, MAX_RESULT_WINDOW - size);
    if (from !== adjustedFrom && from >= MAX_RESULT_WINDOW) {
      console.warn(`Adjusted 'from' position from ${from} to ${adjustedFrom} to stay within MAX_RESULT_WINDOW limit`);
    }

    // Build filters
    const filters = [];
    if (textIds.length > 0) {
      filters.push({
        terms: {
          text_id: textIds
        }
      });
    }

    // Determine which field to search based on isExact flag
    const searchField = isExact ? "page_content" : "page_content.proclitic";
    
    // Check if the query contains wildcards and is a phrase
    const hasWildcard = containsWildcard(query);
    const isQueryPhrase = isPhrase(query);

    // Build the appropriate query based on search type
    let searchQuery;
    
    if (hasWildcard) {
      // Use wildcard query for asterisk searches (single word only)
      searchQuery = {
        wildcard: {
          [searchField]: {
            value: query,
            case_insensitive: true
          }
        }
      };
    } else {
      // Use match_phrase for regular searches (both single words and phrases)
      searchQuery = {
        match_phrase: {
          [searchField]: query
        }
      };
    }

    // Define the type for the highlight configuration
    interface HighlightConfig {
      type: string;
      fields: {
        [key: string]: {
          number_of_fragments: number;
          fragment_size: number;
          pre_tags: string[];
          post_tags: string[];
          require_field_match: boolean;
        }
      };
      highlight_query: any;
    }

    // Build highlight configuration based on query type
    const highlightConfig: HighlightConfig = {
      // Default type, will be overridden below
      type: 'fvh',
      fields: {
        [searchField]: {
          number_of_fragments: 10,
          fragment_size: 500,
          pre_tags: ['<em>'],
          post_tags: ['</em>'],
          require_field_match: true
        }
      },
      // Force exact match for highlighting
      highlight_query: searchQuery
    };

    // Use different highlighter based on query type
    if (hasWildcard && !isQueryPhrase) {
      // For single word with wildcard, use unified highlighter
      highlightConfig.type = 'fvh';
    } else {
      // For phrases and single words without wildcards, use fast vector highlighter
      highlightConfig.type = 'fvh';
    }

    // Build OpenSearch query
    const opensearchQuery = {
      from: adjustedFrom,
      size,
      track_total_hits: true, // Ensure total hits count is accurate even beyond 10k
      query: {
        bool: {
          must: [searchQuery],
          filter: filters.length > 0 ? filters : undefined
        }
      },
      // Add sort by uri in ascending order
      sort: [
        { "uri": { "order": "asc" } }
      ],
      highlight: highlightConfig
    };

    // Set headers with Basic Auth
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Add Basic Authentication if credentials are provided
    if (API_USER && API_PASS) {
      headers['Authorization'] = `Basic ${btoa(`${API_USER}:${API_PASS}`)}`;
    }

    // Execute search with fetch
    const response = await fetch(`${API_URL}/${INDEX}/_search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opensearchQuery)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenSearch error response:', errorText);
      throw new Error(`OpenSearch error: ${response.status} ${response.statusText}`);
    }

    const data: OpenSearchResponse = await response.json();

    // Process results to include all matches per document
    const hits: SearchResult[] = [];

    data.hits.hits.forEach(hit => {
      const source = hit._source;
      
      // Get highlights from the appropriate field based on the search mode
      const highlightField = isExact ? 'page_content' : 'page_content.proclitic';
      const mainHighlights = hit.highlight?.[highlightField] || [];

      // Get all highlights
      const allHighlights = [...mainHighlights];

      // Process all highlights
      const processedHighlights = allHighlights.map(highlight => {
        // Strip any HTML tags except for <em>
        const cleanedHighlight = highlight.replace(/<(?!em|\/em)[^>]+>/g, '');
        return processHighlight(cleanedHighlight);
      });

      hits.push({
        id: hit._id,
        text_id: source.text_id,
        vol: source.vol,
        page_num: source.page_num,
        page_id: source.page_id,
        highlights: processedHighlights,
        score: hit._score,
        uri: source.uri 
      });
    });

    return {
      hits,
      total: data.hits.total.value
    };
  } catch (error) {
    console.error('OpenSearch query failed:', error);
    throw error;
  }
};

/**
 * Get all results for export (up to MAX_EXPORT_RESULTS)
 */
export const getAllResultsForExport = async (
  query: string,
  textIds: number[] = [],
  isExact: boolean = false
): Promise<SearchResult[]> => {
  try {
    // Check if query is valid first
    if (!validateSearchQuery(query)) {
      throw new Error('Invalid search query: Wildcards are not allowed in phrase searches');
    }

    // Use the MAX_EXPORT_RESULTS constant from config
    const response = await searchTexts(
      query,
      1,
      MAX_EXPORT_RESULTS,
      textIds,
      [],
      isExact
    );

    return response.hits;
  } catch (error) {
    console.error('Failed to get all results for export:', error);
    throw error;
  }
};

export { loadTextsMetadata, loadAuthorsMetadata, getAvailableGenres, searchAuthors } from './metadataService';