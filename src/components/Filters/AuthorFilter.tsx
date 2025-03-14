import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Author } from '../../types';

interface AuthorFilterProps {
  selectedAuthors: Author[];
  onAuthorChange: (authorIds: number[]) => void;
  authorsMetadata: Map<number, Author>;
}

const AuthorFilter: React.FC<AuthorFilterProps> = ({
  selectedAuthors,
  onAuthorChange,
  authorsMetadata
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Author[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  
  // Handle search input change
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newSearchTerm = e.target.value;
    setSearchTerm(newSearchTerm);
    
    // Show loading state immediately
    if (newSearchTerm.trim()) {
      setIsLoading(true);
    } else {
      setSearchResults([]);
      setIsLoading(false);
    }
    
    // Clear any existing timeout
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    
    // Set a new timeout to perform the search after 500ms
    timeoutRef.current = window.setTimeout(() => {
      performSearch(newSearchTerm);
    }, 500);
  }, []);
  
  // Clean up the timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  
  // Perform author search - search both au_ar and au_sh_ar fields
  const performSearch = useCallback((query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setIsLoading(false);
      return;
    }
    
    const normalizedQuery = query.toLowerCase();
    
    // Search both au_ar and au_sh_ar fields, but prioritize exact matches
    const results = Array.from(authorsMetadata.values())
      .filter(author => {
        // Check for name match (assumes name field contains either au_ar or au_sh_ar)
        const nameMatch = author.name && author.name.toLowerCase().includes(normalizedQuery);
        
        // If the author object has Arabic-specific fields, check them too
        const auArMatch = (author as any).au_ar && 
                         (author as any).au_ar.toLowerCase().includes(normalizedQuery);
        const auShArMatch = (author as any).au_sh_ar && 
                           (author as any).au_sh_ar.toLowerCase().includes(normalizedQuery);
        
        return nameMatch || auArMatch || auShArMatch;
      })
      .slice(0, 100);
    
    setSearchResults(results);
    setIsLoading(false);
  }, [authorsMetadata]);
  
  // Add an author to the selection
  const addAuthor = useCallback((author: Author) => {
    // Check if author is already selected to prevent duplicates
    if (!selectedAuthors.some(a => a.id === author.id)) {
      onAuthorChange([...selectedAuthors.map(a => a.id), author.id]);
    }
    
    // Clear search
    setSearchTerm('');
    setSearchResults([]);
  }, [selectedAuthors, onAuthorChange]);
  
  // Remove an author from the selection
  const removeAuthor = useCallback((authorId: number) => {
    onAuthorChange(selectedAuthors.filter(a => a.id !== authorId).map(a => a.id));
  }, [selectedAuthors, onAuthorChange]);
  
  // Clear all selected authors
  const clearAll = useCallback(() => {
    onAuthorChange([]);
  }, [onAuthorChange]);

  // Helper to get display name - prefer au_sh_ar if available
  const getAuthorDisplayName = useCallback((author: Author): string => {
    // Check for Arabic short name
    if ((author as any).au_sh_ar) {
      return (author as any).au_sh_ar;
    }
    
    // Fall back to name field
    return author.name || `المؤلف ${author.id}`;
  }, []);
  
  return (
    <div className="filter-group">
      <div className="flex justify-between items-center mb-2">
        <h4 className="text-md font-medium">المؤلفون</h4>
        
        {selectedAuthors.length > 0 && (
          <button
            className="text-xs text-indigo-600 hover:underline"
            onClick={clearAll}
            type="button"
          >
            إلغاء الكل
          </button>
        )}
      </div>
      
      <div className="relative mb-2">
        <input
          type="text"
          value={searchTerm}
          onChange={handleSearchChange}
          placeholder="ابحث عن مؤلف..."
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        
        {isLoading && (
          <div className="absolute left-3 top-1/2 transform -translate-y-1/2">
            <svg
              className="animate-spin h-4 w-4 text-indigo-600"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
          </div>
        )}
        
        {searchTerm.trim() && searchResults.length > 0 && !isLoading && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg">
            <ul className="py-1 max-h-60 overflow-y-auto">
              {searchResults.map(author => (
                <li
                  key={author.id}
                  className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
                  onClick={() => addAuthor(author)}
                >
                  <div className="font-medium">{getAuthorDisplayName(author)}</div>
                  {author.death_date && (
                    <div className="text-xs text-gray-500">
                      توفي: {author.death_date} هـ
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        
        {searchTerm.trim() && !isLoading && searchResults.length === 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg p-3 text-center text-gray-500">
            لم يتم العثور على نتائج
          </div>
        )}
      </div>
      
      <div className="border border-gray-200 rounded bg-white h-60 overflow-y-auto p-2">
        {selectedAuthors.length > 0 ? (
          <ul>
            {selectedAuthors.map(author => (
              <li 
                key={author.id}
                className="flex justify-between items-center py-2 px-3 border-b border-gray-100 last:border-b-0"
              >
                <div>
                  <div className="font-medium">{getAuthorDisplayName(author)}</div>
                  {author.death_date && (
                    <div className="text-xs text-gray-500">
                      توفي: {author.death_date} هـ
                    </div>
                  )}
                </div>
                
                <button
                  onClick={() => removeAuthor(author.id)}
                  className="text-gray-500 hover:text-red-500"
                  type="button"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500">
            <p>لم يتم تحديد أي مؤلف</p>
          </div>
        )}
      </div>
      
      {selectedAuthors.length > 0 && (
        <div className="mt-2 text-sm text-gray-500">
          تم تحديد {selectedAuthors.length} مؤلف
        </div>
      )}
    </div>
  );
};

export default React.memo(AuthorFilter);