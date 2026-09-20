import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { perfMark, perfMeasure } from '../../utils/perf';
import type { HighlightRequest } from '../../utils/highlightRequest';
import type { PageEntry, Token, TocNode } from '../../types';
import type { SearchAPI } from '../../api';
import { TokenPopup, entryForPage } from '@kashshaf/shared';
import { Toast } from '../ui';
import { useBooks } from '../../contexts/BooksContext';
import { CitationBlock } from '../shared/CitationBlock';
import { BookDetailView } from '../modals/MetadataBrowser';
import { usePageStack, type PageAnchor } from '../../hooks/usePageStack';
import type { ClickedMatches } from '../../types/search';
import { ContinuousReader, pageLabel, type ContinuousReaderHandle } from '../reader/ContinuousReader';
import { ReaderTocPane } from '../reader/ReaderTocPane';
import { useBookToc } from '../../hooks/useBookToc';
import { useTocPane, READER_MIN_WIDTH } from '../../hooks/useTocPane';

interface ReaderPanelProps {
  api: SearchAPI;
  /** The book open in this tab. */
  bookId: number | null;
  /** Where the reader should be: a clicked result, or a jump. */
  anchor: PageAnchor | null;
  /** The clicked result's own highlights, and the page they are on. */
  clickedMatches?: ClickedMatches | null;
  /** The running search, as what every fetched page is asked to highlight. */
  highlight?: HighlightRequest | null;
  /** Told where the reader is, so the tab remembers it. */
  onActivePage?: (entry: PageEntry) => void;
  /** Jumping when the book has no spine. Returns false if there is no such page. */
  onNavigateToLabel?: (partLabel: string, pageNumber: string) => Promise<boolean>;
  /** The pages come from the API server (online mode or the web build), not a local corpus. */
  remote?: boolean;
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
  clickedMatches,
  highlight = null,
  onActivePage,
  onNavigateToLabel,
  remote = false,
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

  const stack = usePageStack({ api, bookId, anchor, highlight });
  // The commit in which the spine landed: the state update's own cost.
  useLayoutEffect(() => {
    if (stack.spine.length > 0) {
      perfMark('reader:spine-rendered');
      perfMeasure('reader:spine-render', 'reader:spine-fetched');
    }
  }, [stack.spine]);

  // --- the contents pane
  const toc = useBookToc(api, bookId);
  const tocPane = useTocPane();
  // A book loaded from a result click opens the pane, the first time in the
  // session; after that it stays as the user left it.
  useEffect(() => {
    if (bookId !== null && clickedMatches) tocPane.openedFromResult();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, clickedMatches?.part_index, clickedMatches?.page_id]);

  // With both sidebars open the reader takes what remains, and must not fall
  // below a readable minimum: if it would, the contents pane yields.
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootWidth, setRootWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setRootWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tocYields = rootWidth !== null && rootWidth > 0 && rootWidth - tocPane.width < READER_MIN_WIDTH;
  const tocShown = tocPane.open && !tocYields;

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

  // The entry the page in view sits under, by (part_index, page_id).
  const currentTocId = useMemo(
    () => (active ? entryForPage(toc.rows, active.part_index, active.page_id)?.id ?? null : null),
    [toc.rows, active]
  );

  // Page labels by (part_index, page_id), built once per spine: the pane
  // labels every row it draws, on every render, and a scan of a 33,000-page
  // spine for each was most of what made a long book's contents slow.
  const labelByPage = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of stack.spine) m.set(`${e.part_index}:${e.page_id}`, pageLabel(e, multiPart));
    return m;
  }, [stack.spine, multiPart]);
  const tocLabel = useCallback(
    (part: number, page: number) => labelByPage.get(`${part}:${page}`) ?? (multiPart ? `${part + 1}:${page}` : String(page)),
    [labelByPage, multiPart]
  );

  /** A contents entry was clicked: goTo, the one way the view moves. */
  const handleTocJump = useCallback(
    (node: TocNode) => {
      const index = stack.spine.findIndex((e) => e.part_index === node.part_index && e.page_id === node.page_id);
      if (index >= 0) readerRef.current?.goTo(index);
    },
    [stack.spine]
  );

  const matchesForIndex = useCallback(
    (index: number): readonly number[] => {
      const entry = stack.spine[index];
      if (!entry) return [];
      // The clicked result already answered for its own page: show that at
      // once rather than waiting for the lookup to repeat it.
      if (
        clickedMatches &&
        clickedMatches.indices.length > 0 &&
        clickedMatches.part_index === entry.part_index &&
        clickedMatches.page_id === entry.page_id
      ) {
        return clickedMatches.indices;
      }
      // Every other page carries its highlights from its own fetch, made
      // under the running search; under another search they are stale and
      // the page is being fetched again.
      const loaded = stack.pages.get(index);
      if (loaded && loaded.highlightKey === (highlight?.key ?? null)) return loaded.matches ?? [];
      return [];
    },
    [stack.spine, stack.pages, highlight, clickedMatches]
  );

  /** A proximity search's page-level terms on a page, for the second colour. */
  const pageTermsFor = useCallback(
    (index: number): readonly number[] => {
      const loaded = stack.pages.get(index);
      if (!loaded || loaded.highlightKey !== (highlight?.key ?? null)) return [];
      return loaded.pageTermMatches ?? [];
    },
    [stack.pages, highlight]
  );

  /** Where a highlighted match runs off the card, for the marks at its edges. */
  const continuesFor = useCallback(
    (index: number): { prev: boolean; next: boolean } => {
      const loaded = stack.pages.get(index);
      if (!loaded || loaded.highlightKey !== (highlight?.key ?? null)) return { prev: false, next: false };
      return { prev: loaded.continuesPrev, next: loaded.continuesNext };
    },
    [stack.pages, highlight]
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
      readerRef.current?.goTo(index);
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
        {/* No Prev/Next: the column scrolls, the arrow keys and the wheel
            move it, and the page box with Go places a page. */}
        <button
          type="button"
          onClick={tocPane.toggle}
          aria-pressed={tocPane.open}
          title={tocYields && tocPane.open ? 'The contents pane is hidden while the window is too narrow (Ctrl+T)' : 'Contents (Ctrl+T)'}
          className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border flex-shrink-0
                     ${tocPane.open
                       ? 'bg-app-accent-light text-app-accent border-app-accent'
                       : 'bg-app-surface-variant text-app-text-primary border-app-border-light hover:bg-app-accent-light hover:text-app-accent'}`}
        >
          Contents
        </button>
      </div>

      {stack.spineError && (
        <div className="px-8 py-2 text-xs text-app-text-tertiary bg-app-surface-variant border-b border-app-border-light">
          This corpus does not serve a page list, so the reader shows one page at a time.
        </div>
      )}

      <div ref={rootRef} className="flex-1 min-h-0 flex">
        <ContinuousReader
          ref={readerRef}
          stack={stack}
          matchesFor={matchesForIndex}
          pageTermsFor={pageTermsFor}
          continuesFor={continuesFor}
          onWordClick={handleWordClick}
          onActivePage={handleActivePage}
          multiPart={multiPart}
          onBackgroundClick={handleClosePopup}
        />
        {tocShown && (
          <ReaderTocPane
            toc={toc}
            currentId={currentTocId}
            label={tocLabel}
            onJump={handleTocJump}
            onClose={tocPane.close}
            width={tocPane.width}
            onWidth={tocPane.setWidth}
            unavailableMessage={
              remote
                ? 'Table of contents requires a newer server.'
                : 'This corpus has no table of contents; it ships with corpus 4.2.0.'
            }
          />
        )}
      </div>

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
