import { useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { formatCitation, parseCitation, stripCitationMarkup, type CitationStyle } from '@kashshaf/shared';

/**
 * The text's citation (9 C), ported from Kashshaf's `CitationBlock` so the
 * two apps cite a book identically. The formatting itself is
 * `@kashshaf/shared/utils/citation`, which both import: Chicago and MLA off
 * the `citation_json` the corpus ships, and one Copy button.
 *
 * The volume and page are passed in rather than read from the book, because
 * they are where the reader is, not what the book is.
 */
export function CitationBlock({
  book,
  volume,
  page,
  withPageRef = false,
  defaultStyle = 'chicago',
}: {
  book: BookMetadata;
  /** Volume as printed; only used when `withPageRef`. */
  volume?: string;
  /** Page as printed; only used when `withPageRef`. */
  page?: string;
  withPageRef?: boolean;
  defaultStyle?: CitationStyle;
}) {
  const [style, setStyle] = useState<CitationStyle>(defaultStyle);
  const [copied, setCopied] = useState(false);

  const citation = useMemo(() => parseCitation(book.citation_json), [book.citation_json]);

  // A text whose pagination does not follow the printed edition still gets a
  // citation; it just cannot honestly carry a page.
  const isPaginated = book.paginated === true;
  const includePageRef = withPageRef && isPaginated;
  const warnPagination = withPageRef && !isPaginated;

  const html = useMemo(
    () => (citation ? formatCitation(citation, style, { volume, page, includePageRef }) : ''),
    [citation, style, volume, page, includePageRef]
  );

  if (!citation) {
    return <p className="text-sm text-app-text-secondary italic">No citation data is available for this text.</p>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripCitationMarkup(html));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // A clipboard the browser will not give us is not worth an error box;
      // the citation is on screen and can be selected.
    }
  };

  return (
    <div className="space-y-3" data-testid="citation-block">
      <div className="flex items-center gap-2">
        <span className="text-sm text-app-text-secondary font-medium">Style:</span>
        <div className="flex gap-1">
          {(['chicago', 'mla'] as CitationStyle[]).map((s) => (
            <button
              key={s}
              onClick={() => setStyle(s)}
              aria-pressed={style === s}
              className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${
                style === s
                  ? 'bg-app-accent text-white border-app-accent'
                  : 'border-app-border-light text-app-text-secondary hover:bg-app-surface-variant'
              }`}
            >
              {s === 'mla' ? 'MLA' : 'Chicago'}
            </button>
          ))}
        </div>
        <button
          onClick={() => void copy()}
          className="ltr:ml-auto px-3 py-1 text-xs font-medium rounded border border-app-border-light
                     text-app-text-secondary hover:bg-app-surface-variant transition-colors"
          data-testid="copy-citation"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {warnPagination && (
        <p className="px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-800">
          Pagination in this text does not match the printed edition. Volume and page number have been omitted from the
          citation.
        </p>
      )}

      <div
        className="px-4 py-3 rounded-lg bg-app-surface-variant border border-app-border-light text-base leading-relaxed"
        dir="auto"
        data-testid="citation-text"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {citation.warnings.length > 0 && (
        <ul className="text-xs text-app-text-secondary list-disc ltr:pl-5 rtl:pr-5 space-y-0.5">
          {citation.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
