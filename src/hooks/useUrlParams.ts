import { FilterState, SearchParams } from '../types';

/**
 * Parse URL search parameters into app state
 */
export const parseUrlParams = (urlSearch: string): Partial<SearchParams> => {
  // Use URLSearchParams instead of queryString for better browser compatibility
  const urlParams = new URLSearchParams(urlSearch);
  
  const params: Partial<SearchParams> = {};
  
  // Parse search query
  const queryParam = urlParams.get('q');
  if (queryParam) {
    params.query = queryParam;
  }
  
  // Parse page number
  const pageParam = urlParams.get('page');
  if (pageParam) {
    const pageNum = parseInt(pageParam, 10);
    if (!isNaN(pageNum) && pageNum > 0) {
      params.page = pageNum;
    }
  }
  
  // Parse rows per page
  const rowsParam = urlParams.get('rows');
  if (rowsParam) {
    const rowsNum = parseInt(rowsParam, 10);
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
  const genresParam = urlParams.get('genres');
  if (genresParam) {
    filters.genres = genresParam.split(',').filter(Boolean);
  }
  
  // Parse author filters
  const authorsParam = urlParams.get('authors');
  if (authorsParam) {
    filters.authors = authorsParam
      .split(',')
      .map(id => parseInt(id, 10))
      .filter(id => !isNaN(id));
  }
  
  // Parse death date range
  const deathMinParam = urlParams.get('death_min');
  if (deathMinParam) {
    const min = parseInt(deathMinParam, 10);
    if (!isNaN(min)) {
      filters.deathDateRange.min = min;
    }
  }
  
  const deathMaxParam = urlParams.get('death_max');
  if (deathMaxParam) {
    const max = parseInt(deathMaxParam, 10);
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
  const urlParams = new URLSearchParams();
  
  // Add search query
  if (params.query) {
    urlParams.set('q', params.query);
  }
  
  // Add page number
  if (params.page && params.page > 1) {
    urlParams.set('page', params.page.toString());
  }
  
  // Add rows per page
  if (params.rows && params.rows !== 50) {
    urlParams.set('rows', params.rows.toString());
  }
  
  // Add filters
  if (params.filters) {
    // Add genre filters
    if (params.filters.genres.length > 0) {
      urlParams.set('genres', params.filters.genres.join(','));
    }
    
    // Add author filters
    if (params.filters.authors.length > 0) {
      urlParams.set('authors', params.filters.authors.join(','));
    }
    
    // Add death date range
    if (params.filters.deathDateRange.min > 0) {
      urlParams.set('death_min', params.filters.deathDateRange.min.toString());
    }
    
    if (params.filters.deathDateRange.max < 2000) {
      urlParams.set('death_max', params.filters.deathDateRange.max.toString());
    }
  }
  
  return urlParams.toString();
};