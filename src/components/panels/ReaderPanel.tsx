import { useState, useMemo, useRef, useEffect } from 'react';
import type { Token } from '../../types';
import { stripHtml, buildCharToTokenMap, getHighlightRanges } from '../../utils/arabicTokenizer';
import { TokenPopup } from '../ui/TokenPopup';
import { useBooks } from '../../contexts/BooksContext';

interface ReaderPanelProps {
  currentPage: {
    bookId: number;
    meta: string;
    body: string;
    loadTimeMs?: number;
  } | null;
  tokens: Token[];
  onNavigate: (direction: number) => void;
  /** Token indices that matched from Tantivy search */
  matchedTokenIndices?: number[];
}

/**
 * Renders the body text with highlighting and clickable tokens.
 * Uses the body (with tashkil) for display, maps to token indices for interaction.
 */
function BodyRenderer({
  body,
  tokens,
  matchedIndicesSet,
  onWordClick,
  firstHighlightRef,
}: {
  body: string;
  tokens: Token[];
  matchedIndicesSet: Set<number>;
  onWordClick: (e: React.MouseEvent, token: Token) => void;
  firstHighlightRef: React.RefObject<HTMLSpanElement>;
}) {
  const content = useMemo(() => {
    const plainText = stripHtml(body);
    if (plainText.length === 0) return null;

    const charToToken = buildCharToTokenMap(plainText);
    const highlightRanges = getHighlightRanges(charToToken, matchedIndicesSet);

    // Build a map from token index to token for O(1) lookup
    const tokenByIdx = new Map<number, Token>();
    for (const token of tokens) {
      tokenByIdx.set(token.idx, token);
    }

    // Debug: Log token mapping info
    const maxCharTokenIdx = Math.max(...charToToken.filter((x): x is number => x !== null));
    const tokenIdxRange = tokens.length > 0 ? { min: Math.min(...tokens.map(t => t.idx)), max: Math.max(...tokens.map(t => t.idx)) } : null;
    console.log('[TokenDebug] BodyRenderer mapping:', {
      plainTextLength: plainText.length,
      tokensCount: tokens.length,
      tokenByIdxSize: tokenByIdx.size,
      maxCharTokenIdx,
      tokenIdxRange,
      sampleTokens: tokens.slice(0, 3).map(t => ({ idx: t.idx, surface: t.surface })),
    });

    // Build a set of highlighted character positions for quick lookup
    const highlightedChars = new Set<number>();
    for (const range of highlightRanges) {
      for (let i = range.start; i < range.end; i++) {
        highlightedChars.add(i);
      }
    }

    // Build spans: group consecutive characters by their highlight state and token index
    const elements: React.ReactNode[] = [];
    let i = 0;
    let isFirstHighlight = true;

    while (i < plainText.length) {
      const tokenIdx = charToToken[i];
      const isHighlighted = highlightedChars.has(i);

      // Find the end of this token (consecutive chars with same token index)
      let end = i + 1;
      if (tokenIdx !== null) {
        while (end < plainText.length && charToToken[end] === tokenIdx) {
          end++;
        }
      } else {
        // Non-token character (whitespace, etc.) - just take one char
        end = i + 1;
      }

      const text = plainText.slice(i, end);

      if (tokenIdx !== null) {
        // This is part of a token - make it clickable (O(1) lookup via Map)
        const token = tokenByIdx.get(tokenIdx);
        if (!token && tokenIdx <= maxCharTokenIdx) {
          // Only log once per missing token (at the start of that token's chars)
          if (i === 0 || charToToken[i - 1] !== tokenIdx) {
            console.warn('[TokenDebug] Missing token for idx:', tokenIdx, 'text:', text, 'availableIdxs:', [...tokenByIdx.keys()].slice(0, 20));
          }
        }
        const shouldAttachRef = isHighlighted && isFirstHighlight;
        if (shouldAttachRef) {
          isFirstHighlight = false;
        }
        elements.push(
          <span
            key={i}
            ref={shouldAttachRef ? firstHighlightRef : undefined}
            onClick={token ? (e) => onWordClick(e, token) : undefined}
            className={`cursor-pointer rounded px-0.5 transition-colors duration-100
              ${isHighlighted
                ? 'bg-red-100 text-red-700 font-semibold border-b-2 border-red-400'
                : 'hover:bg-app-accent-light'
              }`}
          >
            {text}
          </span>
        );
      } else {
        // Non-token character (whitespace, newline, etc.)
        if (text === '\n') {
          elements.push(<br key={i} />);
        } else {
          elements.push(text);
        }
      }

      i = end;
    }

    return elements;
  }, [body, tokens, matchedIndicesSet, onWordClick, firstHighlightRef]);

  return (
    <div
      dir="rtl"
      className="text-xl leading-loose font-arabic text-app-text-primary select-text"
    >
      {content}
    </div>
  );
}

export function ReaderPanel({ currentPage, tokens, onNavigate, matchedTokenIndices = [] }: ReaderPanelProps) {
  const { booksMap, authorsMap } = useBooks();
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });
  const firstHighlightRef = useRef<HTMLSpanElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Look up book metadata from booksMap
  const book = currentPage ? booksMap.get(currentPage.bookId) : null;
  const title = book?.title ?? `Book ${currentPage?.bookId}`;
  const author = book?.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;

  const handleWordClick = (e: React.MouseEvent, token: Token) => {
    e.stopPropagation();
    console.log('[TokenDebug] Token clicked:', {
      idx: token.idx,
      surface: token.surface,
      lemma: token.lemma,
      root: token.root,
      pos: token.pos,
    });
    setSelectedToken(token);
    setPopupPosition({
      x: e.clientX,
      y: e.clientY,
    });
  };

  const handleClosePopup = () => {
    setSelectedToken(null);
  };

  // Create a Set for O(1) lookup of matched token indices
  const matchedIndicesSet = useMemo(() => {
    return new Set(matchedTokenIndices);
  }, [matchedTokenIndices]);

  // Scroll to first highlighted match when matches change
  useEffect(() => {
    if (matchedTokenIndices.length > 0 && firstHighlightRef.current && scrollContainerRef.current) {
      // Small delay to ensure DOM is updated
      requestAnimationFrame(() => {
        if (firstHighlightRef.current && scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          const element = firstHighlightRef.current;
          const elementRect = element.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();

          // Calculate scroll position to center the element
          const scrollTop = container.scrollTop + (elementRect.top - containerRect.top) - (containerRect.height / 3);
          container.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
        }
      });
    }
  }, [matchedTokenIndices, currentPage?.body]);

  // If no text is loaded, render nothing
  if (!currentPage?.body) {
    return <div className="h-full bg-white" />;
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-20 border-b border-app-border-light px-8 flex items-center gap-4 flex-shrink-0 bg-app-surface">
        <h2 className="font-semibold text-app-text-primary flex-1 truncate font-arabic text-xl" dir="rtl">
          {title}{author ? ` - ${author}` : ''}
        </h2>
        {currentPage.loadTimeMs !== undefined && (
          <span className="text-xs text-app-text-tertiary flex-shrink-0">
            {currentPage.loadTimeMs}ms
          </span>
        )}
        {currentPage.meta && (
          <span className="text-sm text-app-accent font-medium flex-shrink-0 bg-app-accent-light px-3 py-1 rounded">
            {currentPage.meta}
          </span>
        )}
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => onNavigate(-1)}
            className="px-2 py-2 bg-app-surface-variant rounded-md text-xs font-medium
                     hover:bg-app-accent-light hover:text-app-accent transition-colors
                     border border-app-border-light"
          >
            ← Prev
          </button>
          <button
            onClick={() => onNavigate(1)}
            className="px-2 py-2 bg-app-surface-variant rounded-md text-xs font-medium
                     hover:bg-app-accent-light hover:text-app-accent transition-colors
                     border border-app-border-light"
          >
            Next →
          </button>
        </div>
      </div>

      {/* Text Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto bg-white" onClick={handleClosePopup}>
        <div className="max-w-4xl mx-auto px-16 py-12">
          <BodyRenderer
            body={currentPage.body}
            tokens={tokens}
            matchedIndicesSet={matchedIndicesSet}
            onWordClick={handleWordClick}
            firstHighlightRef={firstHighlightRef}
          />
        </div>
      </div>

      {/* Token Popup */}
      {selectedToken && (
        <TokenPopup
          token={selectedToken}
          position={popupPosition}
          onClose={handleClosePopup}
        />
      )}
    </div>
  );
}
