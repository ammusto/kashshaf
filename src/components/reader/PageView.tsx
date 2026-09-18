import { useEffect, useMemo, useRef } from 'react';
import type { Token } from '../../types';
import { stripHtml, buildCharToTokenMap, getHighlightRanges } from '@kashshaf/shared';

/**
 * One page of the continuous reader.
 *
 * Every page builds its own char-to-token map from its own body. That is the
 * alignment contract (Lab spec §3.3) and the reason the stack is a stack of
 * independent pages rather than one concatenated string: nothing here can
 * move a token index, because no page can see another page's text.
 */

interface PageViewProps {
  /** Index in the book's spine; the reader's key for everything about this page. */
  index: number;
  body: string;
  tokens: Token[];
  /** Token indices to highlight on this page, for the search that is running. */
  matched: readonly number[];
  /** `part_label:page_number`, or the page number alone in a single-part book. */
  label: string;
  /** This page opens a new part: draw the divider above it. */
  startsPart: boolean;
  partLabel: string;
  onWordClick: (e: React.MouseEvent, token: Token) => void;
  /** Report the rendered height so a spacer can stand in for this page later. */
  onMeasure: (index: number, height: number) => void;
  /** Register the element with the reader's observer. */
  onMount: (index: number, el: HTMLElement | null) => void;
}

interface Run {
  text: string;
  token: number | null;
  highlighted: boolean;
}

/** Split the display text into runs of constant token index and highlight state. */
export function toRuns(
  plain: string,
  charToToken: (number | null)[],
  highlighted: Set<number>
): Run[] {
  const runs: Run[] = [];
  if (plain.length === 0) return runs;
  let start = 0;
  for (let i = 1; i <= plain.length; i++) {
    const boundary =
      i === plain.length ||
      charToToken[i] !== charToToken[i - 1] ||
      highlighted.has(i) !== highlighted.has(i - 1);
    if (boundary) {
      runs.push({ text: plain.slice(start, i), token: charToToken[start], highlighted: highlighted.has(start) });
      start = i;
    }
  }
  return runs;
}

export function PageView({
  index,
  body,
  tokens,
  matched,
  label,
  startsPart,
  partLabel,
  onWordClick,
  onMeasure,
  onMount,
}: PageViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  const { runs, tokenByIdx } = useMemo(() => {
    const plain = stripHtml(body);
    const charToToken = buildCharToTokenMap(plain);
    const matchedSet = new Set(matched);
    const highlighted = new Set<number>();
    for (const range of getHighlightRanges(charToToken, matchedSet)) {
      for (let i = range.start; i < range.end; i++) highlighted.add(i);
    }
    const byIdx = new Map<number, Token>();
    for (const t of tokens) byIdx.set(t.idx, t);
    return { runs: toRuns(plain, charToToken, highlighted), tokenByIdx: byIdx };
  }, [body, tokens, matched]);

  // Measure after layout, and again when the text or the window width change
  // the wrapping. The spacer that replaces this page uses the last height
  // reported, so it has to be right before the page is unmounted.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(index, el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) onMeasure(index, e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, runs, onMeasure]);

  useEffect(() => {
    onMount(index, ref.current);
    return () => onMount(index, null);
  }, [index, onMount]);

  let firstHighlightSeen = false;

  return (
    <div ref={ref} data-page-index={index} data-page-label={label}>
      {startsPart && (
        <div className="flex items-center gap-3 px-16 pt-8 pb-2 select-none" dir="rtl">
          <span className="h-px flex-1 bg-app-border-medium" />
          <span className="text-xs font-medium text-app-text-tertiary uppercase tracking-wide">
            {partLabel}
          </span>
          <span className="h-px flex-1 bg-app-border-medium" />
        </div>
      )}
      <div className="flex items-center gap-3 px-16 pt-6 pb-1 select-none" dir="rtl">
        <span className="text-xs text-app-text-tertiary tabular-nums">{label}</span>
        <span className="h-px flex-1 bg-app-border-light" />
      </div>
      <div className="px-16 pb-10">
        <div dir="rtl" className="text-xl leading-loose font-arabic text-app-text-primary select-text">
          {runs.map((run, i) => {
            if (run.token === null) {
              return run.text === '\n' ? <br key={i} /> : <span key={i}>{run.text}</span>;
            }
            const token = tokenByIdx.get(run.token);
            const isFirst = run.highlighted && !firstHighlightSeen;
            if (isFirst) firstHighlightSeen = true;
            return (
              <span
                key={i}
                data-token={run.token}
                data-highlight-first={isFirst ? 'true' : undefined}
                onClick={token ? (e) => onWordClick(e, token) : undefined}
                className={`cursor-pointer rounded px-0.5 transition-colors duration-100
                  ${run.highlighted
                    ? 'bg-red-100 text-red-700 font-semibold border-b-2 border-red-400'
                    : 'hover:bg-app-accent-light'
                  }`}
              >
                {run.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
