import { API_USER, API_PASS, API_URL, INDEX, MAX_RESULT_WINDOW } from '../config/api';
import { SearchResult } from '../types';
import { processHighlight } from '../utils/arabicNormalization';
import { loadTextsMetadata, loadAuthorsMetadata } from './metadataService';

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
        page_content: string[];
      };
    }>;
    total: {
      value: number;
    };
  };
  took: number;
}

/**
 * Search for texts matching the query and filters
 */
export const searchTexts = async (
  query: string,
  page: number = 1,
  size: number = 50,
  textIds: number[] = [],
  pagesToLoad: number[] = []
): Promise<{ hits: SearchResult[], total: number }> => {
  try {
    // Check if we've reached the max result window
    const from = (page - 1) * size;
    if (from >= MAX_RESULT_WINDOW) {
      throw new Error(`Search results limited to first ${MAX_RESULT_WINDOW} results`);
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

    // Determine if query is single word or phrase
    const trimmedQuery = query.trim();
    const isPhrase = trimmedQuery.includes(' ');

    // Build query based on whether it's a phrase or single word
    const queryClause = {
      match_phrase: {
        page_content: trimmedQuery
      }
    };

    // Build OpenSearch query
    const opensearchQuery = {
      from,
      size,
      query: {
        bool: {
          must: [
            {
              match_phrase: {
                page_content: trimmedQuery
              }
            }
          ],
          filter: filters.length > 0 ? filters : undefined
        }
      },
      highlight: {
        type: 'fvh',
        fields: {
          page_content: {
            number_of_fragments: 10,
            fragment_size: 150,
            pre_tags: ['<em>'],
            post_tags: ['</em>'],
            require_field_match: true
          }
        },
        // Force exact match for highlighting
        highlight_query: {
          match_phrase: {
            page_content: trimmedQuery
          }
        }
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
      const mainHighlights = hit.highlight?.page_content || [];

      // Get inner hits (all matches for this document)
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
        score: hit._score
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
  textIds: number[] = []
): Promise<SearchResult[]> => {
  try {
    // Use a reasonable limit for exports
    const MAX_EXPORT_RESULTS = 2000;

    // This is similar to searchTexts but with a larger size limit
    const response = await searchTexts(
      query,
      1,
      MAX_EXPORT_RESULTS,
      textIds,
      []
    );

    return response.hits;
  } catch (error) {
    console.error('Failed to get all results for export:', error);
    throw error;
  }
};

// Export metadataService functions for compatibility
export { loadTextsMetadata, loadAuthorsMetadata, getAvailableGenres, searchAuthors } from './metadataService';