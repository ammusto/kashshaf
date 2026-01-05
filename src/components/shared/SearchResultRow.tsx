import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { SearchResult } from '../../types';
import { stripHtml, buildCharToTokenMap, getSnippetRange, getHighlightRanges } from '../../utils/arabicTokenizer';
import { MetadataTooltip } from '../ui';

interface SearchResultRowProps {
  result: SearchResult;
  onClick: () => void;
  style?: React.CSSProperties;
}

export function SearchResultRow({
  result,
  onClick,
  style,
}: SearchResultRowProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });

  const handleMouseEnter = (e: React.MouseEvent) => {
    setShowTooltip(true);
    setTooltipPosition({
      x: e.clientX,
      y: e.clientY,
    });
  };

  const matchedIndicesSet = useMemo(
    () => new Set(result.matched_token_indices || []),
    [result.matched_token_indices]
  );
  const body = result.body || '';

  const snippetContent = useMemo(() => {
    const plainText = stripHtml(body);
    if (plainText.length === 0) return null;

    const charToToken = buildCharToTokenMap(plainText);
    const firstMatchIdx = result.matched_token_indices?.[0] ?? 0;
    // Limit snippet to 100 tokens total, with match within first 10 tokens
    const maxTokens = 50;
    const maxDistanceFromStart = 5;
    const tokensBefore = Math.min(firstMatchIdx, maxDistanceFromStart);
    const tokensAfter = maxTokens - tokensBefore - 1;
    const snippetRange = getSnippetRange(charToToken, firstMatchIdx, tokensBefore, tokensAfter, maxDistanceFromStart);
    const snippetText = plainText.slice(snippetRange.start, snippetRange.end);

    // Build char-to-token map for the snippet text
    const snippetCharToToken = buildCharToTokenMap(snippetText);

    // Adjust matched indices relative to snippet's starting token
    const adjustedMatchedIndices = new Set<number>();
    for (const idx of matchedIndicesSet) {
      const adjusted = idx - snippetRange.startToken;
      if (adjusted >= 0) {
        adjustedMatchedIndices.add(adjusted);
      }
    }

    const highlightRanges = getHighlightRanges(snippetCharToToken, adjustedMatchedIndices);

    if (highlightRanges.length === 0) {
      // Add ellipsis if start was truncated
      return snippetRange.truncatedStart ? <>… {snippetText}</> : <>{snippetText}</>;
    }

    const elements: React.ReactNode[] = [];

    // Add ellipsis prefix if start was truncated
    if (snippetRange.truncatedStart) {
      elements.push('… ');
    }

    let lastEnd = 0;

    for (const range of highlightRanges) {
      if (range.start > lastEnd) {
        elements.push(snippetText.slice(lastEnd, range.start));
      }
      elements.push(
        <span key={range.start} className="bg-red-100 text-red-700 font-semibold px-0.5 rounded">
          {snippetText.slice(range.start, range.end)}
        </span>
      );
      lastEnd = range.end;
    }

    if (lastEnd < snippetText.length) {
      elements.push(snippetText.slice(lastEnd));
    }

    return <>{elements}</>;
  }, [body, matchedIndicesSet, result.matched_token_indices]);

  return (
    <>
      <div
        onClick={onClick}
        style={style}
        className="h-12 px-6 flex items-center gap-6 cursor-pointer
                 hover:bg-app-surface-variant transition-colors border-b border-app-border-light"
      >
        <div className="w-16 flex-shrink-0 flex items-center justify-center gap-1 rounded py-2 px-3">
          <span className="text-sm text-app-text-primary">{result.part_label}:{result.page_number}</span>
        </div>

        <div className="flex-1 min-w-0">
          <p dir="rtl" className="text-xl text-app-text-primary truncate font-arabic text-right leading-relaxed arabic">
            {snippetContent}
          </p>
        </div>

        <div
          className="w-48 flex-shrink-0 min-w-0"
          onMouseEnter={handleMouseEnter}
          onMouseMove={(e) => setTooltipPosition({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <p
            dir="rtl"
            className="text-xl font-medium text-app-accent truncate text-right font-arabic"
          >
            {result.title}
          </p>
        </div>
      </div>

      {showTooltip && createPortal(
        <MetadataTooltip result={result} position={tooltipPosition} />,
        document.body
      )}
    </>
  );
}
