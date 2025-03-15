export const API_URL = process.env.REACT_APP_OPENSEARCH_API_URL || '/opensearch';
export const INDEX = process.env.REACT_APP_OPENSEARCH_INDEX || 'pages';
export const API_USER = process.env.REACT_APP_OPENSEARCH_USER || '';
export const API_PASS = process.env.REACT_APP_OPENSEARCH_PASS || '';

// API request timeout (in milliseconds)
export const API_TIMEOUT = 30000;

// Max results per page
export const MAX_RESULTS_PER_PAGE = 100;

// Max results for export
export const MAX_EXPORT_RESULTS = 2000;

// Max OpenSearch result window
export const MAX_RESULT_WINDOW = 10000;