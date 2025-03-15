import queryString from 'query-string';
import { FilterState, SearchParams } from '../types';

/**
 * Parse URL search parameters into app state
 */
export const parseUrlParams = (urlSearch: string): Partial<SearchParams> => {
  const parsed = queryString.parse(urlSearch);

  const params: Partial<SearchParams> = {};

  // Parse search query
  if (typeof parsed.q === 'string') {
    params.query = parsed.q;
  }

  // Parse exact search parameter
  if (typeof parsed.exact === 'string') {
    params.exact = parsed.exact === 'true';
  }

  // Parse page number
  if (typeof parsed.page === 'string') {
    const pageNum = parseInt(parsed.page, 10);
    if (!isNaN(pageNum) && pageNum > 0) {
      params.page = pageNum;
    }
  }

  // Parse rows per page
  if (typeof parsed.rows === 'string') {
    const rowsNum = parseInt(parsed.rows, 10);
    if (!isNaN(rowsNum) && [25, 50, 75, 100].includes(rowsNum)) {
      params.rows = rowsNum;
    }
  }

  // Parse filters
  const filters: FilterState = {
    genres: [],
    authors: [],
    deathDateRange: { min: 0, max: 2000 }
  };

  // Parse genre filters
  if (typeof parsed.genres === 'string') {
    filters.genres = parsed.genres.split(',').filter(Boolean);
  } else if (Array.isArray(parsed.genres)) {
    filters.genres = parsed.genres.filter((g): g is string => typeof g === 'string');
  }

  // Parse author filters
  if (typeof parsed.authors === 'string') {
    filters.authors = parsed.authors
      .split(',')
      .map(id => parseInt(id, 10))
      .filter(id => !isNaN(id));
  } else if (Array.isArray(parsed.authors)) {
    filters.authors = parsed.authors
      .map(id => typeof id === 'string' ? parseInt(id, 10) : NaN)
      .filter(id => !isNaN(id));
  }

  // Parse death date range
  if (typeof parsed.death_min === 'string') {
    const min = parseInt(parsed.death_min, 10);
    if (!isNaN(min)) {
      filters.deathDateRange.min = min;
    }
  }

  if (typeof parsed.death_max === 'string') {
    const max = parseInt(parsed.death_max, 10);
    if (!isNaN(max)) {
      filters.deathDateRange.max = max;
    }
  }

  if (
    filters.genres.length > 0 ||
    filters.authors.length > 0 ||
    filters.deathDateRange.min > 0 ||
    filters.deathDateRange.max < 2000
  ) {
    params.filters = filters;
  }

  return params;
};

/**
 * Build URL search parameters from app state
 */
export const buildUrlParams = (params: Partial<SearchParams>): string => {
  const urlParams: Record<string, any> = {};

  // Add search query
  if (params.query) {
    urlParams.q = params.query;
  }

  // ALWAYS include exact search parameter - explicitly convert to string
  urlParams.exact = (params.exact === true).toString();

  // Add page number - always include it for consistency
  if (params.page) {
    urlParams.page = params.page.toString();
  }

  // Add rows per page
  if (params.rows && params.rows !== 50) {
    urlParams.rows = params.rows.toString();
  }

  // Add filters
  if (params.filters) {
    // Add genre filters
    if (params.filters.genres.length > 0) {
      urlParams.genres = params.filters.genres.join(',');
    }

    // Add author filters
    if (params.filters.authors.length > 0) {
      urlParams.authors = params.filters.authors.join(',');
    }

    // Add death date range
    if (params.filters.deathDateRange.min > 0) {
      urlParams.death_min = params.filters.deathDateRange.min.toString();
    }

    if (params.filters.deathDateRange.max < 2000) {
      urlParams.death_max = params.filters.deathDateRange.max.toString();
    }
  }

  return queryString.stringify(urlParams);
};