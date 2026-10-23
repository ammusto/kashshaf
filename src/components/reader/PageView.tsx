import { useEffect, useMemo, useRef } from 'react';
import type { Token } from '../../types';
import { readBody, buildCharToTokenMap, getHighlightRanges, type HeadingRange } from '@kashshaf/shared';

/**
 * One page of the continuous reader.
 *
 * Every page builds its own char-to-token map from its own body. That is the
 * alignment contract (Lab spec §3.3) and the reason the stack is a stack of
 * independent pages rather than one concatenated string: nothing here can
 * move a token index, because no page can see another page's text.
 *
 * The text is rendered `white-space: pre-line`: the body's newlines (a
 * median of six a page in corpus 4.4.0, verse and lists above all) are line
 * breaks, and runs of spaces still collapse. A `<title>` heading is drawn
 * inline in its own colour and nothing else: the corpus puts a newline on
 * either side of four headings in five, and where it does not (`*<title>`,
 * a heading inside a sentence) the text must read as written. Neither
 * changes the string the token map is built from.
 */

interface PageViewProps {
  /** Index in the book's spine; the reader's key for everything about this page. */
  index: number;
  body: string;
  tokens: Token[];
  /** Token indices to highlight on this page, for the search that is running. */
  matched: readonly number[];
  /** A proximity search's page-level terms: highlighted too, in a second colour. */
  pageTerms?: readonly number[];
  /** A highlighted match runs in from the page before / out onto the next: a mark at that edge. */
  continues?: { prev: boolean; next: boolean };
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
  /** Part of the match. */
  highlighted: boolean;
  /** A page-level term of a proximity search (and not part of the match). */
  secondary: boolean;
  /** The id of the `<title>` heading this run is part of, when it is. */
  heading?: number;
}

/**
 * Split the display text into runs of constant token index, highlight state
 * and heading. Passing no headings gives exactly the old behaviour.
 */
export function toRuns(
  plain: string,
  charToToken: (number | null)[],
  highlighted: Set<number>,
  secondary: Set<number> = new Set(),
  headings: HeadingRange[] = []
): Run[] {
  const runs: Run[] = [];
  if (plain.length === 0) return runs;
  const state = (i: number) => (highlighted.has(i) ? 1 : secondary.has(i) ? 2 : 0);
  // A heading id per character, so a boundary is a change like any other.
  const headingAtChar: (number | undefined)[] = new Array(plain.length);
  for (const h of headings) {
    for (let i = h.start; i < h.end && i < plain.length; i++) headingAtChar[i] = h.id;
  }
  let start = 0;
  for (let i = 1; i <= plain.length; i++) {
    const boundary =
      i === plain.length ||
      charToToken[i] !== charToToken[i - 1] ||
      state(i) !== state(i - 1) ||
      headingAtChar[i] !== headingAtChar[i - 1];
    if (boundary) {
      const s = state(start);
      const run: Run = { text: plain.slice(start, i), token: charToToken[start], highlighted: s === 1, secondary: s === 2 };
      if (headingAtChar[start] !== undefined) run.heading = headingAtChar[start];
      runs.push(run);
      start = i;
    }
  }
  return runs;
}

/**
 * The runs grouped for rendering: consecutive runs of one heading become one
 * span, so the heading can be styled and found as a whole; everything else
 * stays as it is, except that a run of two or more newlines is drawn as one.
 * The corpus (4.4.0) puts a blank line before one heading in six, a layout
 * residue to be fixed in the data; until then it is not drawn. The token map
 * was built from the untouched string, so no index moves.
 */
export function groupRuns(runs: Run[]): Array<{ heading: number; runs: Run[] } | Run> {
  const out: Array<{ heading: number; runs: Run[] } | Run> = [];
  for (const run of runs) {
    if (run.heading === undefined) {
      out.push(run.token === null && run.text.includes('\n\n') ? { ...run, text: run.text.replace(/\n{2,}/g, '\n') } : run);
      continue;
    }
    const last = out[out.length - 1];
    if (last && 'runs' in last && last.heading === run.heading) last.runs.push(run);
    else out.push({ heading: run.heading, runs: [run] });
  }
  return out;
}

function renderRun(
  run: Run,
  key: number,
  tokenByIdx: Map<number, Token>,
  onWordClick: (e: React.MouseEvent, token: Token) => void
) {
  if (run.token === null) return <span key={key}>{run.text}</span>;
  const token = tokenByIdx.get(run.token);
  return (
    <span
      key={key}
      data-token={run.token}
      data-highlight={run.highlighted ? 'true' : run.secondary ? 'page' : undefined}
      onClick={token ? (e) => onWordClick(e, token) : undefined}
      // A highlight changes colour only. A weight or a border would reflow
      // the line and change the page's height after it was measured, which
      // moves everything below it.
      className={`cursor-pointer rounded px-0.5 transition-colors duration-100
        ${run.highlighted ? 'bg-red-100 text-red-700' : run.secondary ? 'bg-amber-100 text-amber-800' : 'hover:bg-app-accent-light'}`}
    >
      {run.text}
    </span>
  );
}

export function PageView({
  index,
  body,
  tokens,
  matched,
  pageTerms,
  continues,
  label,
  startsPart,
  partLabel,
  onWordClick,
  onMeasure,
  onMount,
}: PageViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  // The highlight lists are compared by content, not identity: a caller
  // that builds them during render must not make this page re-measure.
  // (`runs` below is what the measure effect keys on.)
  const matchedKey = matched.join(',');
  const pageTermsKey = pageTerms ? pageTerms.join(',') : '';

  const { runs, groups, tokenByIdx } = useMemo(() => {
    const { plain, headings } = readBody(body);
    const charToToken = buildCharToTokenMap(plain);
    const matchedSet = new Set(matched);
    const highlighted = new Set<number>();
    for (const range of getHighlightRanges(charToToken, matchedSet)) {
      for (let i = range.start; i < range.end; i++) highlighted.add(i);
    }
    const secondary = new Set<number>();
    if (pageTerms && pageTerms.length > 0) {
      for (const range of getHighlightRanges(charToToken, new Set(pageTerms))) {
        for (let i = range.start; i < range.end; i++) secondary.add(i);
      }
    }
    const byIdx = new Map<number, Token>();
    for (const t of tokens) byIdx.set(t.idx, t);
    const runs = toRuns(plain, charToToken, highlighted, secondary, headings);
    return { runs, groups: groupRuns(runs), tokenByIdx: byIdx };
    // The lists are read through their content keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, tokens, matchedKey, pageTermsKey]);

  // Measure after layout, and again when the text or the window width change
  // the wrapping. The spacer that replaces this page uses the last height
  // reported, so it has to be right before the page is unmounted.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(index, el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    // The same box as above: `contentRect` is the content box, the gap
    // below the card (`pb-6`) shorter, and two measurements of one card
    // that disagree are a state update each.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) onMeasure(index, (e.target as HTMLElement).getBoundingClientRect().height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, runs, onMeasure]);

  useEffect(() => {
    onMount(index, ref.current);
    return () => onMount(index, null);
  }, [index, onMount]);

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
        {/* A match that began on the page before: a mark at the top edge,
            where the text starts. Colour only, like the highlight itself. */}
        {continues?.prev && (
          <div
            className="mx-10 h-0.5 rounded-full bg-red-300"
            data-testid="continues-prev"
            title="The highlighted match begins on the previous page"
            aria-label="The highlighted match begins on the previous page"
          />
        )}
        <div className="px-10 pt-3 pb-8">
          <div
            dir="rtl"
            data-testid="page-text"
            className="text-xl leading-loose font-arabic text-app-text-primary select-text whitespace-pre-line"
          >
            {groups.map((g, i) =>
              'runs' in g ? (
                <span key={i} data-heading={g.heading} className="text-app-heading">
                  {g.runs.map((run, j) => renderRun(run, j, tokenByIdx, onWordClick))}
                </span>
              ) : (
                renderRun(g, i, tokenByIdx, onWordClick)
              )
            )}
          </div>
        </div>
        {/* And one that runs on to the next page: a mark at the bottom edge. */}
        {continues?.next && (
          <div
            className="mx-10 mb-3 h-0.5 rounded-full bg-red-300"
            data-testid="continues-next"
            title="The highlighted match continues on the next page"
            aria-label="The highlighted match continues on the next page"
          />
        )}
      </article>
    </div>
  );
}
