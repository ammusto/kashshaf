import React, { useState } from 'react';
import { SearchResult } from '../../types';
import { stripDiacriticsExceptShadda, truncateTitle } from '../../utils/textProcessing';

interface ResultRowProps {
  result: SearchResult;
}

const ResultRow: React.FC<ResultRowProps> = ({ result }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  
  // Handle clicking on a result row (e.g., to show full context)
  const handleRowClick = () => {
    // Navigate to full text view with context
    // This is a placeholder for future implementation
  };

  // Format the text title with death date if available
  const formattedTitle = () => {
    // Truncate the title to 4 tokens
    const title = truncateTitle(result.text_title || 'عنوان غير معروف', 4);
    
    // Get death date from the result
    const deathDate = result.death_date;
    
    // If death date exists, add it in parentheses
    if (deathDate) {
      return `${title} (${deathDate})`;
    }
    
    return title;
  };

  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer transition duration-150"
      onClick={handleRowClick}
    >
      <td className="px-6 whitespace-nowrap">
        {/* Create a relative container for the tooltip */}
        <div className="relative">
          {/* Show truncated text name with death date - use onMouseEnter/Leave for tooltip */}
          <div 
            className="text-lg font-medium text-gray-900 hover:text-indigo-600"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            {formattedTitle()}
          </div>
          
          {/* Tooltip with detailed information - fixed sizing */}
          {showTooltip && (
            <div className="absolute z-10 left-0 mt-1 min-w-[300px] max-w-[400px] px-4 py-3 bg-white rounded-lg shadow-lg border border-gray-200">
              {/* Display all available text/author information with improved text wrapping */}
              {result.text_title && (
                <div className="mb-1">
                  <span className="font-semibold">العنوان: </span>
                  <span className="break-words">{result.text_title}</span>
                </div>
              )}
              
              {result.author_name && (
                <div className="mb-1">
                  <span className="font-semibold">المؤلف: </span>
                  <span className="break-words">{result.author_name}</span>
                </div>
              )}
              
              {(result as any).author_lat && (
                <div className="mb-1">
                  <span className="font-semibold">Author: </span>
                  <span dir="ltr" className="break-words">{(result as any).author_lat}</span>
                </div>
              )}
              
              {result.death_date && (
                <div className="mb-1">
                  <span className="font-semibold">تاريخ الوفاة: </span>
                  <span>{result.death_date} هـ</span>
                </div>
              )}
              
              <div className="mt-1 text-xs text-gray-500">
                المجلد {result.vol}، صفحة {result.page_num}
              </div>
            </div>
          )}
        </div>
      </td>

      <td className="px-6">
        <div className="text-lg text-gray-900 search-result-text">
          {result.highlights.map((highlight, index, arr) => (
            <div key={index} 
                 className={`grid grid-cols-[1fr_auto_1fr] gap-2 text-right items-center ${index < arr.length - 1 ? 'mb-1' : ''}`}>
              <div className="text-left text-gray-600 truncate flex items-center" style={{ direction: 'ltr' }}>
                {stripDiacriticsExceptShadda(highlight.pre)}
              </div>
              <div className="text-center font-bold text-red-600 whitespace-nowrap text-lg flex items-center justify-center" 
                   style={{ lineHeight: '1.4' }}>
                {stripDiacriticsExceptShadda(highlight.match)}
              </div>
              <div className="text-right text-gray-600 truncate flex items-center justify-start">
                {stripDiacriticsExceptShadda(highlight.post)}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
};

export default ResultRow;