import React, { useState } from 'react';

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
  
  // Filter genres by search term
  const filteredGenres = allGenres.filter(genre => 
    genre.toLowerCase().includes(searchTerm.toLowerCase())
  );
  
  // Toggle a genre in the selection
  const toggleGenre = (genre: string) => {
    if (selectedGenres.includes(genre)) {
      onChange(selectedGenres.filter(g => g !== genre));
    } else {
      onChange([...selectedGenres, genre]);
    }
  };
  
  // Select all filtered genres
  const selectAll = () => {
    const uniqueGenres = Array.from(new Set([...selectedGenres, ...filteredGenres]));
    onChange(uniqueGenres);
  };
  
  // Clear all filtered genres
  const clearAll = () => {
    onChange(selectedGenres.filter(genre => !filteredGenres.includes(genre)));
  };
  
  return (
    <div className="filter-group">
      <h4 className="text-md font-medium mb-2">الأنواع الأدبية</h4>
      
      <div className="mb-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="ابحث عن نوع..."
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      
      <div className="flex justify-between mb-2">
        <button
          className="text-xs text-indigo-600 hover:underline"
          onClick={selectAll}
        >
          تحديد الكل
        </button>
        <button
          className="text-xs text-indigo-600 hover:underline"
          onClick={clearAll}
        >
          إلغاء الكل
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
              <span className="mr-2 text-sm">{genre}</span>
            </label>
          ))
        ) : (
          <p className="text-sm text-gray-500 text-center py-4">
            لا توجد أنواع مطابقة
          </p>
        )}
      </div>
      
      {selectedGenres.length > 0 && (
        <div className="mt-2 text-sm text-gray-500">
          تم تحديد {selectedGenres.length} نوع
        </div>
      )}
    </div>
  );
}

export default GenreFilter;