import React, { useState, useEffect } from 'react';

interface SearchBarProps {
  query: string;
  onSearch: (query: string) => void;
  isLoading: boolean;
}

const SearchBar: React.FC<SearchBarProps> = ({ query, onSearch, isLoading }) => {
  const [inputValue, setInputValue] = useState(query);

  // Update input when query changes
  useEffect(() => {
    setInputValue(query);
  }, [query]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onSearch(inputValue.trim());
    }
  };

  return (
    <div className="mb-6">
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

          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className={`
    ml-2 px-6 h-12 rounded-lg text-white font-medium mr-2 w-[150px]
              ${isLoading || !inputValue.trim()
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700'
              }
            `}
          >
            {isLoading ? (
              <div className="flex items-center">
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