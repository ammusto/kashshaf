import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { SearchResult } from '../../types';
import { stripHtml, buildCharToTokenMap, getSnippetRange, getHighlightRanges, continuationLabel, secondaryIsAfter } from '@kashshaf/shared';
import { MetadataTooltip } from '../ui';
import { useBooks } from '../../contexts/BooksContext';

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
  const { booksMap, authorsMap, genresMap } = useBooks();
  const book = booksMap.get(result.id);
  // A match across a page break: the row is the primary page's, with its
  // share highlighted, and says at its edge where the rest is.
  const isMultiPart = book?.parts == null || book.parts > 1;
  const continuation =
    result.crosses_page && result.secondary
      ? continuationLabel(result.secondary, secondaryIsAfter(result, result.secondary), isMultiPart)
      : null;
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const titleRef = useRef<HTMLDivElement>(null);

  // The tooltip follows the pointer and goes when it leaves the title. A
  // row can move out from under a still pointer (the list scrolls, rows
  // re-render) without a mouseleave ever arriving, and then it stayed up.
  // While it shows, the document is watched: pointer movement outside the
  // title, any scroll or wheel, a click, or Escape puts it away.
  useEffect(() => {
    if (!showTooltip) return;
    const hide = () => setShowTooltip(false);
    const onMove = (e: PointerEvent) => {
      const el = titleRef.current;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('wheel', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, [showTooltip]);

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

    // A 0.8.0 server sends the snippet already cut, with the token it
    // starts at; an older one sends the page, cut here the same way.
    let snippetText: string;
    let startToken: number;
    let truncatedStart: boolean;
    if (result.snippet_start_token !== undefined) {
      snippetText = plainText;
      startToken = result.snippet_start_token;
      truncatedStart = startToken > 0;
    } else {
      const charToToken = buildCharToTokenMap(plainText);
      const firstMatchIdx = result.matched_token_indices?.[0] ?? 0;
      // Limit snippet to 50 tokens total, with match within the first 5 tokens
      const maxTokens = 50;
      const maxDistanceFromStart = 5;
      const tokensBefore = Math.min(firstMatchIdx, maxDistanceFromStart);
      const tokensAfter = maxTokens - tokensBefore - 1;
      const snippetRange = getSnippetRange(charToToken, firstMatchIdx, tokensBefore, tokensAfter, maxDistanceFromStart);
      snippetText = plainText.slice(snippetRange.start, snippetRange.end);
      startToken = snippetRange.startToken;
      truncatedStart = snippetRange.truncatedStart;
    }

    // Build char-to-token map for the snippet text
    const snippetCharToToken = buildCharToTokenMap(snippetText);

    // Adjust matched indices relative to snippet's starting token
    const adjustedMatchedIndices = new Set<number>();
    for (const idx of matchedIndicesSet) {
      const adjusted = idx - startToken;
      if (adjusted >= 0) {
        adjustedMatchedIndices.add(adjusted);
      }
    }

    const highlightRanges = getHighlightRanges(snippetCharToToken, adjustedMatchedIndices);

    if (highlightRanges.length === 0) {
      // Add ellipsis if start was truncated
      return truncatedStart ? <>… {snippetText}</> : <>{snippetText}</>;
    }

    const elements: React.ReactNode[] = [];

    // Add ellipsis prefix if start was truncated
    if (truncatedStart) {
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
  }, [body, matchedIndicesSet, result.matched_token_indices, result.snippet_start_token]);

  return (
    <>
      <div
        onClick={onClick}
        style={style}
        className="h-12 px-6 flex items-center gap-6 cursor-pointer
                 hover:bg-app-surface-variant transition-colors border-b border-app-border-light"
      >
        <div className="w-16 flex-shrink-0 flex items-center justify-center gap-1 rounded py-2 px-3">
          <span className="text-sm text-app-text-primary">
            {(() => {
              // Hide the volume + colon for single-part books OR when the
              // part_label is missing/blank (e.g. "0", "" — these aren't useful
              // to surface to the user).
              const isMultiPart = book?.parts == null || book.parts > 1;
              const trimmedLabel = result.part_label?.trim() ?? '';
              const showVol = isMultiPart && trimmedLabel !== '' && trimmedLabel !== '0';
              return showVol ? `${result.part_label}:${result.page_number}` : result.page_number;
            })()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p dir="rtl" className="text-xl text-app-text-primary truncate font-arabic text-right leading-relaxed arabic">
            {snippetContent}
          </p>
        </div>
        {continuation && (
          <span
            dir="ltr"
            className="flex-shrink-0 text-[11px] text-app-text-tertiary italic whitespace-nowrap"
            data-testid="continuation"
          >
            {continuation}
          </span>
        )}

        <div
          ref={titleRef}
          className="w-56 flex-shrink-0 min-w-0 cursor-pointer"
          onMouseEnter={handleMouseEnter}
          onMouseMove={(e) => setTooltipPosition({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <p
            dir="rtl"
            className="text-lg font-medium text-app-accent truncate text-right font-arabic"
          >
            {book?.title ?? `Book ${result.id}`}
          </p>
        </div>
      </div>

      {showTooltip && book && createPortal(
        <MetadataTooltip book={book} position={tooltipPosition} authorsMap={authorsMap} genresMap={genresMap} />,
        document.body
      )}
    </>
  );
}
