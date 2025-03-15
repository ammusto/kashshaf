import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
    searchTexts,
    loadTextsMetadata,
    loadAuthorsMetadata
} from '../services/opensearch';
import { parseUrlParams, buildUrlParams } from '../utils/urlParams';
import { normalizeArabicText } from '../utils/arabicNormalization';
import {
    SearchResult,
    FilterState,
    Text,
    Author
} from '../types';

interface UseSearchReturn {
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    results: SearchResult[];
    isLoading: boolean;
    totalResults: number;
    currentPage: number;
    setCurrentPage: (page: number) => void;
    rowsPerPage: number;
    setRowsPerPage: (rows: number) => void;
    filters: FilterState;
    setFilters: (filters: FilterState) => void;
    textsMetadata: Map<number, Text>;
    authorsMetadata: Map<number, Author>;
    executeSearch: (newQuery?: string, page?: number) => void;
    resetFilters: () => void;
    applyFilters: () => void;
}

const DEFAULT_ROWS_PER_PAGE = 50;
const DEFAULT_FILTERS: FilterState = {
    genres: [],
    authors: [],
    deathDateRange: { min: 0, max: 2000 }
};

export const useSearch = (): UseSearchReturn => {
    const location = useLocation();
    const navigate = useNavigate();

    // Local state
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [totalResults, setTotalResults] = useState<number>(0);
    const [currentPage, setCurrentPage] = useState<number>(1);
    const [rowsPerPage, setRowsPerPage] = useState<number>(DEFAULT_ROWS_PER_PAGE);
    const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
    const [loadedPages, setLoadedPages] = useState<number[]>([]);
    const [textsMetadata, setTextsMetadata] = useState<Map<number, Text>>(new Map());
    const [authorsMetadata, setAuthorsMetadata] = useState<Map<number, Author>>(new Map());

    // Load metadata on mount
    useEffect(() => {
        const loadMetadata = async () => {
            try {
                const [texts, authors] = await Promise.all([
                    loadTextsMetadata(),
                    loadAuthorsMetadata()
                ]);

                setTextsMetadata(texts);
                setAuthorsMetadata(authors);
            } catch (error) {
                console.error('Failed to load metadata:', error);
            }
        };

        loadMetadata();
    }, []);

    // Handle URL params on mount or URL change
    useEffect(() => {
        const params = parseUrlParams(location.search);

        if (params.query) {
            setSearchQuery(params.query);
        }

        if (params.page) {
            setCurrentPage(params.page);
        }

        if (params.rows) {
            setRowsPerPage(params.rows);
        }

        if (params.filters) {
            setFilters(params.filters);
        }

        // Execute search if we have a query
        if (params.query && params.query.trim()) {
            executeSearch(params.query, params.page || 1);
        }
    }, [location.search]);

    // Filter texts based on selected filters
    const getFilteredTextIds = useCallback((currentFilters: FilterState): number[] => {
        
        // Start with all texts
        let filteredTexts = Array.from(textsMetadata.values());
        
        // Filter by genres
        if (currentFilters.genres.length > 0) {
            const genresSet = new Set(currentFilters.genres);
            filteredTexts = filteredTexts.filter(text =>
                text.tags && text.tags.some(genre => genresSet.has(genre))
            );
        }

        // Filter by authors
        if (currentFilters.authors.length > 0) {
            const authorsSet = new Set(currentFilters.authors);
            filteredTexts = filteredTexts.filter(text =>
                authorsSet.has(text.au_id)
            );
        }

        // Filter by death date
        if (currentFilters.deathDateRange.min > 0 || currentFilters.deathDateRange.max < 2000) {
            // Get author IDs within death date range
            const authorIdsInRange = Array.from(authorsMetadata.values())
                .filter(author =>
                    author.death_date >= currentFilters.deathDateRange.min &&
                    author.death_date <= currentFilters.deathDateRange.max
                )
                .map(author => author.id);

            // Filter texts by those author IDs
            filteredTexts = filteredTexts.filter(text =>
                authorIdsInRange.includes(text.au_id)
            );
        }

        // Return text IDs
        return filteredTexts.map(text => text.id);
    }, [textsMetadata, authorsMetadata]);

    // Execute search
    const executeSearch = useCallback(async (newQuery?: string, page?: number) => {
        const query = newQuery || searchQuery;
        const currentRequestPage = page || currentPage;
        
        if (!query.trim()) return;

        setIsLoading(true);

        try {
            // Get filtered text IDs
            const textIds = getFilteredTextIds(filters);

            // Calculate pages to load
            const pagesToLoad = [currentRequestPage];

            // Execute search
            const response = await searchTexts(
                normalizeArabicText(query),
                currentRequestPage,
                rowsPerPage,
                textIds,
                pagesToLoad
            );

            // Map results to include text and author metadata
            const enrichedResults = response.hits.map(result => {
                const text = textsMetadata.get(result.text_id);
                const author = text ? authorsMetadata.get(text.au_id) : undefined;

                return {
                    ...result,
                    text_title: text?.title || `Text ID: ${result.text_id}`,
                    author_name: author?.name || `Author ID: ${text?.au_id || 'Unknown'}`
                };
            });

            // Update state
            setResults(enrichedResults);
            setTotalResults(response.total);
            setCurrentPage(currentRequestPage);
            
            // Update loaded pages
            setLoadedPages(prev => {
                if (prev.includes(currentRequestPage)) {
                    return prev;
                } else {
                    return [...prev, currentRequestPage];
                }
            });

            // Update URL if it's a new search
            if (newQuery || page) {
                updateUrl(query, currentRequestPage);
            }
        } catch (error) {
            console.error('Search failed:', error);
            setResults([]);
            setTotalResults(0);
        } finally {
            setIsLoading(false);
        }
    }, [
        searchQuery,
        currentPage,
        rowsPerPage,
        filters,
        loadedPages,
        textsMetadata,
        authorsMetadata,
        getFilteredTextIds
    ]);

    // Update URL with current state
    const updateUrl = useCallback((query: string = searchQuery, page: number = currentPage) => {
        const params = buildUrlParams({
            query,
            page,
            rows: rowsPerPage,
            filters
        });

        navigate(`?${params}`, { replace: true });
    }, [searchQuery, currentPage, rowsPerPage, filters, navigate]);

    // Reset filters
    const resetFilters = useCallback(() => {
        setFilters(DEFAULT_FILTERS);
        setCurrentPage(1);

        // Execute search with reset filters
        executeSearch(searchQuery, 1);
    }, [searchQuery, executeSearch]);

    // Apply filters
    const applyFilters = useCallback(() => {
        setCurrentPage(1);
        setLoadedPages([]);

        // Execute search with current query and new filters
        executeSearch(searchQuery, 1);
    }, [searchQuery, executeSearch]);

    return {
        searchQuery,
        setSearchQuery,
        results,
        isLoading,
        totalResults,
        currentPage,
        setCurrentPage,
        rowsPerPage,
        setRowsPerPage,
        filters,
        setFilters,
        textsMetadata,
        authorsMetadata,
        executeSearch,
        resetFilters,
        applyFilters
    };
};