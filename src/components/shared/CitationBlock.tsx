import { useState, useMemo } from 'react';
import type { BookMetadata } from '../../types';
import {
  parseCitation,
  formatCitation,
  stripCitationMarkup,
  type CitationStyle,
} from '../../utils/citation';

interface CitationBlockProps {
  book: BookMetadata;
  /** Volume label as printed; only relevant when withPageRef is true. */
  volume?: string;
  /** Page number as printed; only relevant when withPageRef is true. */
  page?: string;
  /**
   * Whether the consumer wants a vol/page reference appended. When this is
   * true and `book.paginated` is falsy, we render a warning and silently
   * suppress the vol/page reference (per spec: "still create the citation
   * but it should NOT include the vol and page number").
   */
  withPageRef?: boolean;
  /** Default style to render with. */
  defaultStyle?: CitationStyle;
}

export function CitationBlock({
  book,
  volume,
  page,
  withPageRef = false,
  defaultStyle = 'chicago',
}: CitationBlockProps) {
  const [style, setStyle] = useState<CitationStyle>(defaultStyle);
  const [copied, setCopied] = useState(false);

  const citation = useMemo(() => parseCitation(book.citation_json), [book.citation_json]);

  // Suppress page reference when the underlying source doesn't have reliable
  // pagination matching the printed edition. We still render the citation,
  // just without vol/page.
  const isPaginated = book.paginated === true;
  const effectiveIncludePageRef = withPageRef && isPaginated;
  const showPaginationWarning = withPageRef && !isPaginated;

  const formattedHtml = useMemo(() => {
    if (!citation) return '';
    return formatCitation(citation, style, {
      volume,
      page,
      includePageRef: effectiveIncludePageRef,
    });
  }, [citation, style, volume, page, effectiveIncludePageRef]);

  if (!citation) {
    return (
      <div className="text-sm text-app-text-tertiary italic">
        No citation data is available for this text.
      </div>
    );
  }

  const handleCopy = async () => {
    const plain = stripCitationMarkup(formattedHtml);
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy citation:', err);
    }
  };

  return (
    <div className="space-y-3">
      {/* Style selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-app-text-tertiary font-medium">Style:</span>
        <div className="flex gap-1">
          <StyleButton
            label="Chicago"
            active={style === 'chicago'}
            onClick={() => setStyle('chicago')}
          />
          <StyleButton
            label="MLA"
            active={style === 'mla'}
            onClick={() => setStyle('mla')}
          />
        </div>
        <button
          onClick={handleCopy}
          className="ml-auto px-3 py-1 text-xs font-medium rounded
                     border border-app-border-light text-app-text-secondary
                     hover:bg-app-surface-variant transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Pagination warning when relevant */}
      {showPaginationWarning && (
        <div className="px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-800">
          Pagination in this text does not match the printed edition. Volume and page
          number have been omitted from the citation.
        </div>
      )}

      {/* Rendered citation */}
      <div
        className="px-4 py-3 rounded-lg bg-app-surface-variant border border-app-border-light
                   text-base text-app-text-primary leading-relaxed"
        dir="auto"
        dangerouslySetInnerHTML={{ __html: formattedHtml }}
      />

      {/* Per-book warnings from the citation_json itself, if any */}
      {citation.warnings.length > 0 && (
        <ul className="text-xs text-app-text-tertiary list-disc pl-5 space-y-0.5">
          {citation.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StyleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded border transition-colors
        ${active
          ? 'bg-app-accent text-white border-app-accent'
          : 'border-app-border-light text-app-text-secondary hover:bg-app-surface-variant'
        }`}
    >
      {label}
    </button>
  );
}
