import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { parseUrlParams, buildUrlParams } from '../utils/urlParams';
import { SearchParams, FilterState } from '../types';

interface UseUrlParamsReturn {
  currentParams: Partial<SearchParams>;
  updateUrlParams: (params: Partial<SearchParams>) => void;
  clearUrlParams: () => void;
}

export const useUrlParams = (): UseUrlParamsReturn => {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Get current parameters from URL
  const currentParams = parseUrlParams(location.search);
  
  // Update URL parameters
  const updateUrlParams = useCallback((params: Partial<SearchParams>) => {
    // Merge with existing params
    const newParams: Partial<SearchParams> = {
      ...currentParams,
      ...params
    };
    
    // Reset page to 1 if query or filters change
    if (
      (params.query && params.query !== currentParams.query) ||
      (params.filters && JSON.stringify(params.filters) !== JSON.stringify(currentParams.filters))
    ) {
      newParams.page = 1;
    }
    
    // Build URL string
    const urlString = buildUrlParams(newParams);
    
    // Update URL
    navigate(`?${urlString}`, { replace: true });
  }, [navigate, currentParams]);
  
  // Clear all URL parameters
  const clearUrlParams = useCallback(() => {
    navigate('', { replace: true });
  }, [navigate]);
  
  return {
    currentParams,
    updateUrlParams,
    clearUrlParams
  };
};