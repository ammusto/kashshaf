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
    // The gap below the card is inside the measured element, so the spacer
    // that replaces this page later is exactly as tall as the space it took.
    <div ref={ref} data-page-index={index} data-page-label={label} className="pb-6">
      {startsPart && (
        <div className="flex items-center gap-3 pb-6 select-none" dir="rtl">
          <span className="h-0.5 flex-1 bg-app-border-medium rounded-full" />
          <span className="text-xs font-semibold text-app-text-secondary uppercase tracking-wide">
            {partLabel}
          </span>
          <span className="h-0.5 flex-1 bg-app-border-medium rounded-full" />
        </div>
      )}
      <article className="bg-app-surface border border-app-border-light rounded shadow-app-sm overflow-hidden">
        {/* The printed page number as a folio number: top-right corner, no
            band, no rule, muted. */}
        <div className="flex justify-end px-10 pt-5 select-none">
          <span className="text-xs font-medium text-app-text-tertiary tabular-nums">{label}</span>
        </div>
        <div className="px-10 pt-3 pb-8">
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
                  data-highlight={run.highlighted ? 'true' : undefined}
                  data-highlight-first={isFirst ? 'true' : undefined}
                  onClick={token ? (e) => onWordClick(e, token) : undefined}
                  // A highlight changes colour only. A weight or a border
                  // would reflow the line and change the page's height after
                  // it was measured, which moves everything below it.
                  className={`cursor-pointer rounded px-0.5 transition-colors duration-100
                    ${run.highlighted
                      ? 'bg-red-100 text-red-700'
                      : 'hover:bg-app-accent-light'
                    }`}
                >
                  {run.text}
                </span>
              );
            })}
          </div>
        </div>
      </article>
    </div>
  );
}
