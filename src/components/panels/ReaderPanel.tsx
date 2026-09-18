import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageEntry, Token } from '../../types';
import type { SearchAPI } from '../../api';
import { TokenPopup } from '@kashshaf/shared';
import { Toast } from '../ui';
import { useBooks } from '../../contexts/BooksContext';
import { CitationBlock } from '../shared/CitationBlock';
import { BookDetailView } from '../modals/MetadataBrowser';
import { usePageStack, type PageAnchor } from '../../hooks/usePageStack';
import { ContinuousReader, pageLabel, type ContinuousReaderHandle } from '../reader/ContinuousReader';

interface ReaderPanelProps {
  api: SearchAPI;
  /** The book open in this tab. */
  bookId: number | null;
  /** Where the reader should be: a clicked result, or a jump. */
  anchor: PageAnchor | null;
  /** Highlights for the page the reader opened on, from the clicked result. */
  anchorMatches?: readonly number[];
  /** Highlights for any page of the book, for the search that is running. */
  matchesFor?: (entry: PageEntry) => readonly number[] | undefined;
  /** Told which pages are mounted, so their highlights can be fetched. */
  onMountedPages?: (entries: PageEntry[]) => void;
  /** Told where the reader is, so the tab remembers it. */
  onActivePage?: (entry: PageEntry) => void;
  /** Stepping when the book has no spine (an older server). */
  onNavigate?: (direction: number) => void;
  /** Jumping when the book has no spine. Returns false if there is no such page. */
  onNavigateToLabel?: (partLabel: string, pageNumber: string) => Promise<boolean>;
}

/**
 * The reader: one book as a single scrolling column.
 *
 * The book's spine (`list_book_pages`) is loaded once and the pages near the
 * one in view are mounted around it, so reading on past the foot of a page
 * needs no click and crossing into the next part needs no special case. The
 * page in view drives the header's label and the citation.
 */
export function ReaderPanel({
  api,
  bookId,
  anchor,
  anchorMatches,
  matchesFor,
  onMountedPages,
  onActivePage,
  onNavigate,
  onNavigateToLabel,
}: ReaderPanelProps) {
  const { booksMap, authorsMap, genresMap } = useBooks();
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });
  const readerRef = useRef<ContinuousReaderHandle>(null);

  const [partLabelInput, setPartLabelInput] = useState('');
  const [pageNumberInput, setPageNumberInput] = useState('');
  const [navigating, setNavigating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showCite, setShowCite] = useState(false);
  const [showBookDetail, setShowBookDetail] = useState(false);
  /** The page in view: what the header and the citation describe. */
  const [active, setActive] = useState<PageEntry | null>(null);

  const stack = usePageStack({ api, bookId, anchor });

  const book = bookId !== null ? booksMap.get(bookId) : null;
  const title = book?.title ?? (bookId !== null ? `Book ${bookId}` : '');
  const author = book?.author_id !== undefined ? authorsMap.get(book.author_id) : undefined;
  // Prefer the spine, which knows how many parts the book really has; fall
  // back to the metadata before it arrives. Unknown/legacy counts as
  // multi-part so older metadata is not misread as single-part.
  const multiPart = useMemo(() => {
    if (stack.spine.length > 0) return new Set(stack.spine.map((e) => e.part_index)).size > 1;
    return book?.parts == null || book.parts > 1;
  }, [stack.spine, book?.parts]);

  // Keep the vol:page boxes on the page in view, unless the user is typing.
  useEffect(() => {
    if (!active || navigating) return;
    setPartLabelInput(active.part_label ?? '');
    setPageNumberInput(active.page_number ?? '');
  }, [active, navigating]);

  const handleActivePage = useCallback(
    (entry: PageEntry) => {
      setActive(entry);
      onActivePage?.(entry);
    },
    [onActivePage]
  );

  const matchesForIndex = useCallback(
    (index: number): readonly number[] => {
      const entry = stack.spine[index];
      if (!entry) return [];
      const fromSearch = matchesFor?.(entry);
      if (fromSearch) return fromSearch;
      // The page the reader opened on carries the clicked result's own
      // highlights until the per-page lookup answers for it.
      if (anchor && entry.part_index === anchor.part_index && entry.page_id === anchor.page_id) {
        return anchorMatches ?? [];
      }
      return [];
    },
    [stack.spine, matchesFor, anchor, anchorMatches]
  );

  const handleGoClick = async () => {
    const partLabel = partLabelInput.trim();
    const pageNumber = pageNumberInput.trim();
    if (!pageNumber || (multiPart && !partLabel)) {
      setToastMessage(multiPart ? 'Enter both volume and page number' : 'Enter a page number');
      return;
    }
    // With a spine the page is already known: no round trip, and it works
    // the same offline and online.
    const index = stack.spine.findIndex(
      (e) => e.page_number === pageNumber && (!multiPart || e.part_label === partLabel)
    );
    if (index >= 0) {
      readerRef.current?.jumpTo(index);
      return;
    }
    if (stack.spine.length > 0) {
      setToastMessage(`Page ${multiPart ? `${partLabel}:${pageNumber}` : pageNumber} not found in this text`);
      return;
    }
    if (!onNavigateToLabel) return;
    setNavigating(true);
    try {
      const ok = await onNavigateToLabel(partLabel, pageNumber);
      if (!ok) {
        setToastMessage(`Page ${multiPart ? `${partLabel}:${pageNumber}` : pageNumber} not found in this text`);
      }
    } finally {
      setNavigating(false);
    }
  };

  const handleStep = (direction: number) => {
    if (stack.spine.length > 0) {
      readerRef.current?.step(direction);
      return;
    }
    onNavigate?.(direction);
  };

  const handleWordClick = useCallback((e: React.MouseEvent, token: Token) => {
    e.stopPropagation();
    setSelectedToken(token);
    setPopupPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const handleClosePopup = useCallback(() => setSelectedToken(null), []);

  if (bookId === null) {
    return <div className="h-full bg-white" />;
  }

  const citeVolume = active?.part_label ?? '';
  const citePageNumber = active?.page_number ?? '';

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-20 border-b border-app-border-light px-8 flex items-center gap-4 flex-shrink-0 bg-app-surface">
        <button
          onClick={() => setShowCite(true)}
          disabled={!book}
          className="px-3 py-2 bg-app-surface-variant rounded-md text-xs font-medium
                     hover:bg-app-accent-light hover:text-app-accent transition-colors
                     border border-app-border-light flex-shrink-0
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cite
        </button>
        <button
          type="button"
          onClick={() => book && setShowBookDetail(true)}
          disabled={!book}
          title="View book details"
          className="font-semibold text-app-text-primary flex-1 truncate font-arabic text-lg
                     text-right hover:text-app-accent transition-colors cursor-pointer
                     disabled:cursor-default disabled:hover:text-app-text-primary"
          dir="rtl"
        >
          {title}{author ? ` - ${author}` : ''}
        </button>
        {stack.spine.length > 0 && active && (
          <span className="text-xs text-app-text-tertiary flex-shrink-0 tabular-nums">
            {pageLabel(active, multiPart)} of {stack.spine.length.toLocaleString()}
          </span>
        )}
        <div className="flex items-center gap-1 flex-shrink-0 bg-app-accent-light rounded px-2 py-1">
          {multiPart && (
            <>
              <input
                type="text"
                value={partLabelInput}
                onChange={(e) => setPartLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleGoClick();
                  }
                }}
                disabled={navigating}
                aria-label="Volume"
                className="w-12 text-sm text-app-accent font-medium bg-transparent text-center
                           border-b border-transparent focus:border-app-accent focus:outline-none
                           disabled:cursor-not-allowed"
              />
              <span className="text-sm text-app-accent font-medium">:</span>
            </>
          )}
          <input
            type="text"
            value={pageNumberInput}
            onChange={(e) => setPageNumberInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleGoClick();
              }
            }}
            disabled={navigating}
            aria-label="Page number"
            className="w-14 text-sm text-app-accent font-medium bg-transparent text-center
                       border-b border-transparent focus:border-app-accent focus:outline-none
                       disabled:cursor-not-allowed"
          />
          <button
            onClick={() => void handleGoClick()}
            disabled={navigating}
            className="ml-1 px-2 py-0.5 text-xs font-medium text-app-accent
                       border border-app-accent rounded hover:bg-app-accent hover:text-white
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Go
          </button>
        </div>
        {/* The text is RTL, so the next page lies to the left and the
            previous to the right. The arrows point the way the reader
            moves, not the way a Latin page turns. */}
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => handleStep(1)}
            className="px-2 py-2 bg-app-surface-variant rounded-md text-xs font-medium
                     hover:bg-app-accent-light hover:text-app-accent transition-colors
                     border border-app-border-light"
          >
            ← Next
          </button>
          <button
            onClick={() => handleStep(-1)}
            className="px-2 py-2 bg-app-surface-variant rounded-md text-xs font-medium
                     hover:bg-app-accent-light hover:text-app-accent transition-colors
                     border border-app-border-light"
          >
            Prev →
          </button>
        </div>
      </div>

      {stack.spineError && (
        <div className="px-8 py-2 text-xs text-app-text-tertiary bg-app-surface-variant border-b border-app-border-light">
          This corpus does not serve a page list, so the reader shows one page at a time.
        </div>
      )}

      <ContinuousReader
        ref={readerRef}
        stack={stack}
        matchesFor={matchesForIndex}
        onWordClick={handleWordClick}
        onActivePage={handleActivePage}
        onMountedPages={onMountedPages}
        multiPart={multiPart}
        onBackgroundClick={handleClosePopup}
      />

      {selectedToken && (
        <TokenPopup token={selectedToken} position={popupPosition} onClose={handleClosePopup} />
      )}

      {showBookDetail && book && (
        <BookDetailView
          book={book}
          onBack={() => setShowBookDetail(false)}
          backLabel="Back to Search Results"
          authorsMap={authorsMap}
          genresMap={genresMap}
        />
      )}

      {showCite && book && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowCite(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[600px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
              <h2 className="text-lg font-semibold text-app-text-primary">Citation</h2>
              <button
                onClick={() => setShowCite(false)}
                aria-label="Close"
                className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors"
              >
                <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-6 py-5">
              {/* The citation follows the page in view, not the page that was
                  clicked: scrolling on and citing gives the page you are
                  reading. */}
              <CitationBlock book={book} volume={citeVolume} page={citePageNumber} withPageRef={true} />
            </div>
          </div>
        </div>
      )}

      {toastMessage && (
        <Toast message={toastMessage} type="error" onClose={() => setToastMessage(null)} />
      )}
    </div>
  );
}
