import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  buildCharToTokenMap,
  getTokenCount,
  TokenPopup,
  type Token,
} from '@kashshaf/shared';
import { readBody, type HeadingRange } from '../api/bodyText';
import type { Page, PageRef } from '../api/lab';
import { Pages } from '../api/pages';

/**
 * The reader (spec §7.2), shared by every panel.
 *
 * The overlay is the point: every rendered word is wrapped in a span that
 * carries its token index, so a click yields a `Token` and a drag yields a
 * `[start, end)` token range — the input to "Find reuse of this passage" and
 * "Mark as isnād here" in later phases, and the coordinates every stored span
 * is expressed in (ground rule 4).
 *
 * Indices come from `buildCharToTokenMap` on the same body the browser
 * displays, which is the alignment contract (§3.3); the backend's
 * `verify_alignment` checks the other side of it.
 */

/**
 * Something drawn over a token range that is not the reader's own selection:
 * a note's marker (spec 1.5 §C4), a search hit. `title` is the hover text.
 */
export interface Mark {
  start: number;
  /** Exclusive. */
  end: number;
  className: string;
  title?: string;
  /** What `onMarkClick` is given: a note's id (9 B2). */
  id?: number;
}

/** One run of characters that belongs to a single token, or to none. */
interface Run {
  text: string;
  token: number | null;
  /** The `<title>` this run sits inside, when it does (A2). */
  heading?: number;
}

/**
 * Split the display text into runs of constant token index, and of constant
 * heading. Passing no headings gives exactly the old behaviour.
 */
export function toRuns(
  plain: string,
  charToToken: (number | null)[],
  headings: HeadingRange[] = []
): Run[] {
  // A heading id per character, so a boundary is a change like any other.
  const headingAtChar: (number | undefined)[] = new Array(plain.length);
  for (const h of headings) {
    for (let i = h.start; i < h.end && i < plain.length; i++) headingAtChar[i] = h.id;
  }
  const runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= plain.length; i++) {
    const boundary =
      i === plain.length ||
      charToToken[i] !== charToToken[i - 1] ||
      headingAtChar[i] !== headingAtChar[i - 1];
    if (boundary) {
      runs.push({ text: plain.slice(start, i), token: charToToken[start], heading: headingAtChar[start] });
      start = i;
    }
  }
  return runs;
}

function inSelection(idx: number | null, sel: [number, number] | null): boolean {
  return idx !== null && sel !== null && idx >= sel[0] && idx < sel[1];
}

export function Reader({
  page,
  pages,
  index,
  onNavigate,
  onSelectRange,
  onClearSelection,
  highlight,
  highlightClass = 'tok-hit',
  layerClass,
  marks,
  onMarkClick,
  labels,
  toolbar,
  interaction = 'tokens',
  paneRef,
  onScroll,
  onTokenClick,
  loading,
  error,
}: {
  page: Page | null;
  pages: PageRef[];
  index: number;
  onNavigate: (nextIndex: number) => void;
  /** A confirmed token range `[start, end)`, or null when cleared. */
  onSelectRange?: (range: [number, number] | null) => void;
  /** A click on the pane background, or Escape, cleared the selection (fix 8). */
  onClearSelection?: () => void;
  /**
   * A token range to mark and scroll to — a concordance hit, a section
   * heading (spec §7.3 click-through). Distinct from the user's selection.
   */
  highlight?: [number, number] | null;
  /**
   * What to draw the highlight in. Green by default, which is a hit; the
   * reuse panel asks for red on the side that matched (8 D).
   */
  highlightClass?: string;
  /**
   * Extra CSS class per token index — the workbench's highlight layers
   * (transmitters, verbs, matn, chain outline), spec §7.2/§7.4.
   */
  layerClass?: (idx: number) => string | null;
  /** Ranges drawn over the text that are not the selection (spec §C4). */
  marks?: Mark[];
  /** A click on a mark that carries an id, when nothing is being selected. */
  onMarkClick?: (id: number) => void;
  /**
   * The book's page list, which every page label is built from (spec §C1).
   * Without it the locator falls back to the page's own printed number.
   */
  labels?: Pages;
  /**
   * Replaces the built-in prev/next header. The Read panel supplies its own
   * (part:page inputs, the table of contents, Annotate); the panels that only
   * show a page keep the default.
   */
  toolbar?: React.ReactNode;
  /**
   * How the mouse behaves over the text (Phase 7 B).
   *
   * `tokens` is the overlay: a drag paints a token range and a click opens
   * the morphology popup, which is what the isnād workbench needs. `text`
   * leaves the mouse to the browser, so the page selects and copies like
   * any other text; the spans still carry their indices, so a selection can
   * be read back as a token range by `tokenRangeOfSelection`.
   */
  interaction?: 'tokens' | 'text';
  /** The scrolling pane, so a caller can restore where the reader was. */
  paneRef?: React.MutableRefObject<HTMLDivElement | null>;
  onScroll?: (top: number) => void;
  /**
   * When set, a click on a token calls this instead of opening the popup
   * (the workbench's set-boundary / split / retag modes).
   */
  onTokenClick?: (idx: number) => void;
  loading: boolean;
  error: string | null;
}) {
  const [popup, setPopup] = useState<{ token: Token; x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const { runs, tokenByIdx, displayCount } = useMemo(() => {
    if (!page) return { runs: [] as Run[], tokenByIdx: new Map<number, Token>(), displayCount: 0 };
    const { plain, headings } = readBody(page.body);
    const map = buildCharToTokenMap(plain);
    const byIdx = new Map<number, Token>();
    for (const t of page.tokens) byIdx.set(t.idx, t);
    return { runs: toRuns(plain, map, headings), tokenByIdx: byIdx, displayCount: getTokenCount(map) };
  }, [page]);

  // Changing page drops whatever was selected on the old one: a token range is
  // only meaningful with its page.
  useEffect(() => {
    setSelection(null);
    setPopup(null);
    anchor.current = null;
    onSelectRange?.(null);
    // onSelectRange is the caller's stable handler; re-running on page change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.book_id, page?.part_index, page?.page_id]);

  const finishSelection = useCallback(
    (range: [number, number] | null) => {
      setSelection(range);
      onSelectRange?.(range);
    },
    [onSelectRange]
  );

  const onTokenDown = (e: React.MouseEvent, idx: number) => {
    anchor.current = idx;
    finishSelection([idx, idx + 1]);
    setPopup(null);
    e.preventDefault();
  };

  const onTokenEnter = (idx: number) => {
    if (anchor.current === null) return;
    const a = anchor.current;
    finishSelection([Math.min(a, idx), Math.max(a, idx) + 1]);
  };

  const onTokenUp = (e: React.MouseEvent, idx: number) => {
    const a = anchor.current;
    anchor.current = null;
    // A click without a drag opens the token popup — or, in a workbench
    // mode, hands the token to the mode; a drag leaves a range.
    if (a === idx) {
      if (onTokenClick) {
        onTokenClick(idx);
        return;
      }
      const token = tokenByIdx.get(idx);
      if (token) setPopup({ token, x: e.clientX, y: e.clientY });
    }
  };

  // Fix 8: a click on the pane background (not on a token) or Escape
  // clears whatever is highlighted.
  const clearAll = useCallback(() => {
    anchor.current = null;
    setPopup(null);
    finishSelection(null);
    onClearSelection?.();
  }, [finishSelection, onClearSelection]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearAll]);

  // Bring a highlighted hit into view once the page has rendered.
  useEffect(() => {
    if (!highlight || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(`[data-token="${highlight[0]}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') (el as HTMLElement).scrollIntoView({ block: 'center' });
  }, [highlight, page]);

  const canPrev = index > 0;
  const canNext = index >= 0 && index < pages.length - 1;

  // One mark per token, so rendering a run is a lookup rather than a scan.
  const markByToken = useMemo(() => {
    const m = new Map<number, Mark>();
    for (const mk of marks ?? []) {
      for (let i = mk.start; i < mk.end; i++) m.set(i, mk);
    }
    return m;
  }, [marks]);

  // The whole-book contract check in miniature, on the page in front of the
  // user: if these disagree the overlay is pointing at the wrong words, and
  // the reader says so rather than highlighting confidently and wrongly.
  const misaligned = page != null && displayCount !== page.tokens.length;

  return (
    <div className="flex flex-col h-full">
      {toolbar ?? (
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border-light bg-app-surface">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate(index - 1)}
            disabled={!canPrev || loading}
            className="px-2 py-1 text-sm border border-app-border-medium rounded disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <button
            onClick={() => onNavigate(index + 1)}
            disabled={!canNext || loading}
            className="px-2 py-1 text-sm border border-app-border-medium rounded disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
        <div className="text-xs text-app-text-secondary" data-testid="page-locator">
          {page ? (labels ?? Pages.empty()).label(page.part_index, page.page_id) : '—'}
        </div>
        <div className="text-xs text-app-text-secondary" data-testid="token-count">
          {page ? `${page.tokens.length.toLocaleString()} tokens` : ''}
          {selection && (
            <span className="text-app-accent">
              {' '}· selected {selection[0]}–{selection[1] - 1}
            </span>
          )}
        </div>
      </div>
      )}

      {misaligned && (
        <div className="px-4 py-2 text-xs text-app-error bg-red-50 border-b border-app-border-light" role="alert">
          Token overlay disabled on this page: the text shows {displayCount} words but the
          corpus reports {page!.tokens.length} tokens. Run the alignment check
          (Debug) and report the page.
        </div>
      )}

      {error && (
        <div className="px-4 py-2 text-sm text-app-error" role="alert">
          {error}
        </div>
      )}

      <div
        ref={(el) => {
          bodyRef.current = el;
          if (paneRef) paneRef.current = el;
        }}
        onScroll={onScroll ? (e) => onScroll((e.target as HTMLDivElement).scrollTop) : undefined}
        className="flex-1 overflow-y-auto px-8 py-6"
        data-testid="reader-pane"
        onClick={(e) => {
          if (e.target === e.currentTarget) clearAll();
        }}
      >
        {loading && !page && <div className="text-sm text-app-text-secondary">Loading page…</div>}
        {page && (
          <div
            className="arabic page-body text-2xl select-text max-w-3xl mx-auto break-words"
            dir="rtl"
            onMouseLeave={() => { anchor.current = null; }}
            data-testid="page-body"
          >
            {runs.map((run, i) =>
              run.token === null || misaligned ? (
                <span key={i} className={run.heading !== undefined ? 'page-heading' : undefined}>
                  {run.text}
                </span>
              ) : (
                <span
                  key={i}
                  className={`${interaction === 'tokens' ? 'tok' : ''} ${
                    run.heading !== undefined ? 'page-heading' : ''
                  } ${
                    inSelection(run.token, selection) ? 'tok-selected' : ''
                  } ${inSelection(run.token, highlight ?? null) ? highlightClass : ''} ${
                    layerClass?.(run.token) ?? ''
                  } ${markByToken.get(run.token)?.className ?? ''}`}
                  title={markByToken.get(run.token)?.title}
                  data-token={run.token}
                  data-mark={markByToken.get(run.token)?.id}
                  onClick={
                    interaction === 'text'
                      ? (e) => {
                          // A drag through a word is a selection, not a click
                          // on it.
                          if (!(window.getSelection()?.isCollapsed ?? true)) return;
                          const idx = run.token as number;
                          const id = markByToken.get(idx)?.id;
                          e.stopPropagation();
                          // An annotation is the more particular thing, so it
                          // wins; otherwise the word's own data (10 D).
                          if (id != null && onMarkClick) {
                            onMarkClick(id);
                            return;
                          }
                          const token = tokenByIdx.get(idx);
                          if (token) setPopup({ token, x: e.clientX, y: e.clientY });
                        }
                      : undefined
                  }
                  onMouseDown={interaction === 'tokens' ? (e) => onTokenDown(e, run.token as number) : undefined}
                  onMouseEnter={interaction === 'tokens' ? () => onTokenEnter(run.token as number) : undefined}
                  onMouseUp={interaction === 'tokens' ? (e) => onTokenUp(e, run.token as number) : undefined}
                >
                  {run.text}
                </span>
              )
            )}
          </div>
        )}
        {!page && !loading && !error && (
          <div className="text-sm text-app-text-secondary">Choose a book to read.</div>
        )}
      </div>

      {popup && (
        <TokenPopup
          token={popup.token}
          position={{ x: popup.x, y: popup.y }}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}
