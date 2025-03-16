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
 * Check if query contains wildcard characters and should use wildcard search
 */
const shouldUseWildcardSearch = (query: string): boolean => {
  return query.includes('*');
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
    
    // Check if the query contains wildcards
    const isWildcardSearch = shouldUseWildcardSearch(query);

    // Build the appropriate query based on search type
    let searchQuery;
    
    if (isWildcardSearch) {
      // Use wildcard query for asterisk searches
      searchQuery = {
        wildcard: {
          [searchField]: {
            value: query,
            case_insensitive: true
          }
        }
      };
    } else {
      // Use match_phrase for regular searches
      searchQuery = {
        match_phrase: {
          [searchField]: query
        }
      };
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
      highlight: {
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
      }
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
    // Use the MAX_EXPORT_RESULTS constant from config
    // MAX_EXPORT_RESULTS is set to 2000 in config/api.ts

    // This is similar to searchTexts but with a larger size limit
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