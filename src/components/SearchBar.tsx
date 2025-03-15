import React, { useState, useEffect } from 'react';

interface SearchBarProps {
  query: string;
  onSearch: (query: string, isExact: boolean) => void;
  isLoading: boolean;
  isExact?: boolean;
}

const SearchBar: React.FC<SearchBarProps> = ({ query, onSearch, isLoading, isExact = false }) => {
  const [inputValue, setInputValue] = useState(query);
  const [exactSearch, setExactSearch] = useState(isExact);

  // Update input when query changes
  useEffect(() => {
    setInputValue(query);
  }, [query]);

  // Update exact search state when isExact prop changes
  useEffect(() => {
    setExactSearch(isExact);
  }, [isExact]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onSearch(inputValue.trim(), exactSearch);
    }
  };

  return (
    <div className="mb-6" >
      <form onSubmit={handleSubmit} className="relative">
        <div className="flex">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="...Search for a word or phrase"
            className="w-full border-2 border-gray-300 bg-white h-12 px-5 pr-10 rounded-lg text-lg focus:outline-none focus:border-indigo-500"
            dir="rtl"
          />

          <div className="flex items-center mx-2">
            <label className="inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={exactSearch}
                onChange={() => setExactSearch(!exactSearch)}
                className="form-checkbox h-5 w-5 text-gray-600 rounded focus:ring-gray-500"
              />
              <span className="ml-2 text-sm font-medium text-gray-700">E</span>
            </label>
            <div className="relative group ml-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 cursor-help">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-48 p-2 bg-gray-700 text-white text-xs rounded shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity">
                E = Exact search (no proclitics ب، ف، و، ل)
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className={`
              ml-2 px-6 h-12 rounded-lg text-white font-medium mr-2 w-[150px]
              ${isLoading || !inputValue.trim()
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-gray-600 hover:bg-gray-400'
              }
            `}
          >
            {isLoading ? (
              <div className="flex items-center justify-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-5 w-5 text-white"
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
                <span>Searching</span>
              </div>
            ) : (
              'Search'
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default SearchBar;