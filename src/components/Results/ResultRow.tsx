import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { SearchResult } from '../../types';
import { stripDiacriticsExceptShadda, truncateTitle } from '../../utils/textProcessing';

interface ResultRowProps {
  result: SearchResult;
}

const ResultRow: React.FC<ResultRowProps> = ({ result }) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  // Track mouse position when hovering over the title
  const handleMouseMove = (e: React.MouseEvent) => {
    setMousePosition({
      x: e.clientX,
      y: e.clientY
    });
  };

  // Toggle expanded state
  const toggleExpanded = () => {
    setExpanded(!expanded);
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
    <tr className={`hover:bg-gray-50 transition duration-150 cursor-pointer ${expanded ? 'expanded' : ''}`} onClick={toggleExpanded}>
      <td className="px-6 whitespace-nowrap">
        {/* Create a relative container for the tooltip */}
        <div className="relative">
          {/* Show truncated text name with death date */}
          <Link
            to={`/text/${result.text_id}`}
            className="text-lg font-medium text-gray-900 hover:text-indigo-600"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setShowTooltip(false)}
            onClick={(e) => e.stopPropagation()} // Prevent row click event
          >
            {formattedTitle()}
          </Link>

          {/* Tooltip with detailed information - positioned based on mouse coordinates */}
          {showTooltip && (
            <div
              className="fixed z-50 px-4 py-3 bg-white rounded-lg shadow-lg border border-gray-200"
              style={{
                minWidth: '300px',
                maxWidth: '600px',
                right: `${Math.max(window.innerWidth - mousePosition.x, 10)}px`,
                top: `${Math.min(mousePosition.y + 20, window.innerHeight - 200)}px`,
              }}
            >
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
                  {result.author_name}
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

              <div className="mt-1 text-sm text-gray-500">
                vol. {result.vol} pg. {result.page_num}
              </div>
            </div>
          )}
        </div>
      </td>

      <td className="px-6">
        <div className="text-lg text-gray-900 search-result-text">
          {expanded ? (
            // Expanded view - show as paragraphs with down arrow
            <div className="text-right">
              {result.highlights.map((highlight, index) => (
                <div key={index} className="mb-3 leading-relaxed text-right relative" dir="rtl">
                  <span className="text-gray-600">{stripDiacriticsExceptShadda(highlight.pre)} </span>
                  <span className="font-bold text-red-600">{stripDiacriticsExceptShadda(highlight.match)}</span>
                  <span className="text-gray-600"> {stripDiacriticsExceptShadda(highlight.post)}</span>
                  
                  {/* Down arrow at the end of paragraph */}
                  <span className="inline-block mr-2 text-gray-500">
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
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            // Collapsed view - show grid with expand indicator
            <div>
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
          )}
        </div>
      </td>
    </tr>
  );
};

export default ResultRow;