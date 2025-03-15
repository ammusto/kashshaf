import React, { useState, useCallback, useMemo } from 'react';

interface GenreFilterProps {
  allGenres: string[];
  selectedGenres: string[];
  onChange: (genres: string[]) => void;
}

const GenreFilter: React.FC<GenreFilterProps> = ({
  allGenres,
  selectedGenres,
  onChange
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  
  // Filter genres by search term - memoized
  const filteredGenres = useMemo(() => {
    return allGenres.filter(genre => 
      genre.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [allGenres, searchTerm]);
  
  // Toggle a genre in the selection
  const toggleGenre = useCallback((genre: string) => {
    if (selectedGenres.includes(genre)) {
      onChange(selectedGenres.filter(g => g !== genre));
    } else {
      onChange([...selectedGenres, genre]);
    }
  }, [selectedGenres, onChange]);
  
  // Clear all filtered genres
  const clearAll = useCallback(() => {
    // Keep only genres that aren't in the filtered list
    const remainingGenres = selectedGenres.filter(genre => !filteredGenres.includes(genre));
    onChange(remainingGenres);
  }, [filteredGenres, selectedGenres, onChange]);
  
  // Handle search input change
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);
  
  return (
    <div className="filter-group">
      <h4 className="text-md font-medium mb-2">Genres</h4>
      
      <div className="mb-2">
        <input
          type="text"
          value={searchTerm}
          onChange={handleSearchChange}
          placeholder="Search for a genre..."
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      
      <div className="flex justify-between mb-2">
        <button
          className="text-xs text-gray-900 hover:underline"
          onClick={clearAll}
          type="button"
        >
          Unselect all
        </button>
      </div>
      
      <div className="h-60 overflow-y-auto border border-gray-200 rounded p-2 bg-white">
        {filteredGenres.length > 0 ? (
          filteredGenres.map(genre => (
            <label
              key={genre}
              className="flex items-center py-1 px-2 hover:bg-gray-50 rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedGenres.includes(genre)}
                onChange={() => toggleGenre(genre)}
                className="form-checkbox h-4 w-4 text-indigo-600 rounded focus:ring-indigo-500"
              />
              <span className="ml-2 text-sm">{genre}</span>
            </label>
          ))
        ) : (
          <p className="text-sm text-gray-500 text-center py-4">
            No matching genres found
          </p>
        )}
      </div>
      
      {selectedGenres.length > 0 && (
        <div className="mt-2 text-sm text-gray-500">
          {selectedGenres.length} Genre Selected
        </div>
      )}
    </div>
  );
}

export default React.memo(GenreFilter);