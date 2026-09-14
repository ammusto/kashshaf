import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  stripHtml,
  buildCharToTokenMap,
  getTokenCount,
  TokenPopup,
  type Token,
} from '@kashshaf/shared';
import type { Page, PageRef } from '../api/lab';

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

/** One run of characters that belongs to a single token, or to none. */
interface Run {
  text: string;
  token: number | null;
}

/** Split the display text into runs of constant token index. */
export function toRuns(plain: string, charToToken: (number | null)[]): Run[] {
  const runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= plain.length; i++) {
    if (i === plain.length || charToToken[i] !== charToToken[i - 1]) {
      runs.push({ text: plain.slice(start, i), token: charToToken[start] });
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
  highlight,
  layerClass,
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
  /**
   * A token range to mark and scroll to — a concordance hit, a section
   * heading (spec §7.3 click-through). Distinct from the user's selection.
   */
  highlight?: [number, number] | null;
  /**
   * Extra CSS class per token index — the workbench's highlight layers
   * (transmitters, verbs, matn, chain outline), spec §7.2/§7.4.
   */
  layerClass?: (idx: number) => string | null;
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
  const bodyRef = useRef<HTMLDivElement>(null);

  const { runs, tokenByIdx, displayCount } = useMemo(() => {
    if (!page) return { runs: [] as Run[], tokenByIdx: new Map<number, Token>(), displayCount: 0 };
    const plain = stripHtml(page.body);
    const map = buildCharToTokenMap(plain);
    const byIdx = new Map<number, Token>();
    for (const t of page.tokens) byIdx.set(t.idx, t);
    return { runs: toRuns(plain, map), tokenByIdx: byIdx, displayCount: getTokenCount(map) };
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

  // Bring a highlighted hit into view once the page has rendered.
  useEffect(() => {
    if (!highlight || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(`[data-token="${highlight[0]}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [highlight, page]);

  const canPrev = index > 0;
  const canNext = index >= 0 && index < pages.length - 1;

  // The whole-book contract check in miniature, on the page in front of the
  // user: if these disagree the overlay is pointing at the wrong words, and
  // the reader says so rather than highlighting confidently and wrongly.
  const misaligned = page != null && displayCount !== page.tokens.length;

  return (
    <div className="flex flex-col h-full">
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
          {page
            ? `${page.part_label || `Part ${page.part_index}`} : ${page.page_number || page.page_id}`
            : '—'}
          {pages.length > 0 && (
            <span className="text-app-text-tertiary">
              {' '}· page {index + 1} of {pages.length.toLocaleString()}
            </span>
          )}
        </div>
        <div className="text-xs text-app-text-tertiary" data-testid="token-count">
          {page ? `${page.tokens.length.toLocaleString()} tokens` : ''}
          {selection && (
            <span className="text-app-accent">
              {' '}· selected {selection[0]}–{selection[1] - 1}
            </span>
          )}
        </div>
      </div>

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

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-8 py-6">
        {loading && !page && <div className="text-sm text-app-text-tertiary">Loading page…</div>}
        {page && (
          <div
            className="arabic text-2xl select-text max-w-3xl mx-auto"
            dir="rtl"
            onMouseLeave={() => { anchor.current = null; }}
            data-testid="page-body"
          >
            {runs.map((run, i) =>
              run.token === null || misaligned ? (
                <span key={i}>{run.text}</span>
              ) : (
                <span
                  key={i}
                  className={`tok ${inSelection(run.token, selection) ? 'tok-selected' : ''} ${
                    inSelection(run.token, highlight ?? null) ? 'tok-hit' : ''
                  } ${layerClass?.(run.token) ?? ''}`}
                  data-token={run.token}
                  onMouseDown={(e) => onTokenDown(e, run.token as number)}
                  onMouseEnter={() => onTokenEnter(run.token as number)}
                  onMouseUp={(e) => onTokenUp(e, run.token as number)}
                >
                  {run.text}
                </span>
              )
            )}
          </div>
        )}
        {!page && !loading && !error && (
          <div className="text-sm text-app-text-tertiary">Choose a book to read.</div>
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
