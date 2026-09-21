import { useMemo, useState } from 'react';
import { secondaryIsAfter } from '@kashshaf/shared';
import { createPortal } from 'react-dom';
import { buildCharToTokenMap, getHighlightRanges, getSnippetRange } from '@kashshaf/shared';
import type { Hit } from '../../api/search';
import { readBody } from '../../api/bodyText';
import type { Pages } from '../../api/pages';

/**
 * One search result, reproducing Kashshaf's `shared/SearchResultRow`: the same
 * row height and spacing, the same 50-token snippet with the hit no more than
 * five words in, the same red highlight, the same hover card on the title.
 *
 * What differs is only what Lab knows: every hit is in the open text, so the
 * title column carries the page's heading instead of the book.
 */

const MAX_TOKENS = 50;
const MAX_FROM_START = 5;

export function ResultRow({
  hit,
  pages,
  section,
  onClick,
}: {
  hit: Hit;
  pages: Pages;
  /** The heading this page sits under, shown where Kashshaf shows the book. */
  section: string | null;
  onClick: () => void;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const snippet = useMemo(() => {
    const { plain } = readBody(hit.body);
    if (!plain) return null;
    // An engine of 0.8.0 sends the snippet cut, with the token it starts
    // at; an older one the page, cut here the same way.
    let text: string;
    let startToken: number;
    let truncatedStart: boolean;
    if (hit.snippet_start_token !== undefined) {
      text = plain;
      startToken = hit.snippet_start_token;
      truncatedStart = startToken > 0;
    } else {
      const charToToken = buildCharToTokenMap(plain);
      const first = hit.matched[0] ?? 0;
      const before = Math.min(first, MAX_FROM_START);
      const range = getSnippetRange(charToToken, first, before, MAX_TOKENS - before - 1, MAX_FROM_START);
      text = plain.slice(range.start, range.end);
      startToken = range.startToken;
      truncatedStart = range.truncatedStart;
    }

    const local = new Set<number>();
    for (const idx of hit.matched) {
      const adjusted = idx - startToken;
      if (adjusted >= 0) local.add(adjusted);
    }
    const ranges = getHighlightRanges(buildCharToTokenMap(text), local);
    if (ranges.length === 0) return truncatedStart ? `… ${text}` : text;

    const out: React.ReactNode[] = [];
    if (truncatedStart) out.push('… ');
    let last = 0;
    for (const r of ranges) {
      if (r.start > last) out.push(text.slice(last, r.start));
      out.push(
        <span key={r.start} className="bg-red-100 text-red-700 font-semibold px-0.5 rounded">
          {text.slice(r.start, r.end)}
        </span>
      );
      last = r.end;
    }
    if (last < text.length) out.push(text.slice(last));
    return <>{out}</>;
  }, [hit.body, hit.matched, hit.snippet_start_token]);

  return (
    <>
      <div
        onClick={onClick}
        data-testid="search-hit"
        className="h-12 px-6 flex items-center gap-6 cursor-pointer hover:bg-app-surface-variant
                   transition-colors border-b border-app-border-light"
      >
        <div className="w-16 flex-shrink-0 flex items-center justify-center rounded py-2 px-3">
          <span className="text-sm text-app-text-primary tabular-nums">
            {pages.label(hit.part_index, hit.page_id)}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p dir="rtl" className="text-xl text-app-text-primary truncate font-arabic text-right leading-relaxed arabic">
            {snippet}
          </p>
        </div>
        {/* A match across a page break: this row is the primary page's, and
            says at its edge where the rest is (C1 label). */}
        {hit.crosses_page && hit.secondary && (
          <span dir="ltr" className="flex-shrink-0 text-[11px] text-app-text-tertiary italic whitespace-nowrap" data-testid="continuation">
            {(() => {
              const i = pages.indexOf(hit.part_index, hit.page_id);
              const j = pages.indexOf(hit.secondary.part_index, hit.secondary.page_id);
              const after = i >= 0 && j >= 0 ? j > i : secondaryIsAfter(hit, hit.secondary);
              return `${after ? 'continues on' : 'continues from'} p. ${pages.label(hit.secondary.part_index, hit.secondary.page_id)}`;
            })()}
          </span>
        )}


        <div
          className="w-56 flex-shrink-0 min-w-0"
          onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setTip(null)}
        >
          <p dir="rtl" className="text-lg font-medium text-app-accent truncate text-right font-arabic">
            {section ?? ''}
          </p>
        </div>
      </div>

      {tip &&
        section &&
        createPortal(
          <div
            className="fixed z-50 max-w-sm px-3 py-2 rounded-lg bg-app-surface border border-app-border-medium shadow-lg
                       text-sm font-arabic pointer-events-none"
            dir="rtl"
            style={{ left: tip.x + 14, top: tip.y + 14 }}
          >
            {section}
          </div>,
          document.body
        )}
    </>
  );
}
