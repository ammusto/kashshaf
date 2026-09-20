import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

// Check if a character is Arabic
function isArabic(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x0600 && code <= 0x06FF) || // Arabic
         (code >= 0x0750 && code <= 0x077F) || // Arabic Supplement
         (code >= 0x08A0 && code <= 0x08FF);   // Arabic Extended-A
}

/**
 * An Arabic run: from one Arabic letter to the last, with the spaces and
 * Arabic punctuation between. The spaces belong to the run: split word by
 * word, each word is its own right-to-left box and the boxes are laid out
 * left to right, so a phrase reads backwards.
 */
const ARABIC_RUN = /([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF](?:[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\s]*[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF])?)/;

// Parse content and wrap Arabic phrases in right-to-left spans
export function parseContent(content: string): React.ReactNode[] {
  return content
    .split(ARABIC_RUN)
    .filter((part) => part.length > 0)
    .map((part, key) =>
      isArabic(part[0]) ? (
        <span key={key} className="font-arabic text-base" dir="rtl">
          {part}
        </span>
      ) : (
        <span key={key}>{part}</span>
      )
    );
}

export interface TooltipRow {
  label: string;
  value?: string;
  /** If true, value will be parsed for Arabic text and styled accordingly */
  parseArabic?: boolean;
}

interface BaseTooltipProps {
  position: { x: number; y: number };
  width?: number;
}

interface SimpleTooltipProps extends BaseTooltipProps {
  content: string;
  rows?: never;
}

interface RowsTooltipProps extends BaseTooltipProps {
  content?: never;
  rows: TooltipRow[];
}

type TooltipContentProps = SimpleTooltipProps | RowsTooltipProps;

/**
 * Tooltip content renderer - used internally by Tooltip and useTooltip
 */
export function TooltipContent({ position, width = 200, ...props }: TooltipContentProps) {
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [arrowPosition, setArrowPosition] = useState<'top' | 'bottom'>('bottom');
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tooltipWidth = width;
    const tooltipHeight = props.rows ? props.rows.length * 28 + 24 : 80;
    const padding = 8;

    // Calculate horizontal position (centered on trigger)
    let left = position.x - tooltipWidth / 2;

    // Clamp to viewport bounds
    if (left < padding) {
      left = padding;
    } else if (left + tooltipWidth > window.innerWidth - padding) {
      left = window.innerWidth - tooltipWidth - padding;
    }

    // Calculate vertical position (prefer above, fallback to below)
    let top: number;
    if (position.y - tooltipHeight - padding > 0) {
      // Show above
      top = position.y - tooltipHeight - padding;
      setArrowPosition('bottom');
    } else {
      // Show below
      top = position.y + padding;
      setArrowPosition('top');
    }

    setTooltipStyle({ left, top });
  }, [position, width, props.rows]);

  const isSimple = 'content' in props && props.content !== undefined;

  return createPortal(
    <div
      ref={tooltipRef}
      className={`fixed z-[9999] px-3 py-2 text-xs text-app-text-primary bg-white rounded-md shadow-lg border border-app-border-medium whitespace-normal text-left leading-relaxed pointer-events-none`}
      style={{ ...tooltipStyle, width: `${width}px` }}
    >
      {isSimple ? (
        // Simple text content with Arabic parsing
        parseContent(props.content)
      ) : (
        // Structured rows
        <div className="space-y-1.5">
          {props.rows.map((row, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <span className="text-xs text-app-text-secondary w-12 flex-shrink-0">
                {row.label}:
              </span>
              <span
                dir={row.parseArabic ? 'rtl' : 'ltr'}
                className={`text-xs text-app-text-primary flex-1 ${row.parseArabic ? 'text-right' : ''}`}
              >
                {row.value ? (
                  row.parseArabic ? parseContent(row.value) : row.value
                ) : (
                  '—'
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`absolute w-2 h-2 bg-white border-app-border-medium rotate-45 left-1/2 -translate-x-1/2 ${
          arrowPosition === 'bottom'
            ? 'bottom-[-5px] border-b border-r'
            : 'top-[-5px] border-t border-l'
        }`}
      />
    </div>,
    document.body
  );
}

interface TooltipTriggerProps {
  content: string;
  children?: React.ReactNode;
}

/**
 * Simple info tooltip with ? trigger icon
 * Used for inline help text
 */
export function InfoTooltip({ content }: TooltipTriggerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isVisible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    }
  }, [isVisible]);

  return (
    <span
      ref={triggerRef}
      className="inline-flex items-center"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      <span className="w-4 h-4 flex items-center justify-center rounded-full bg-app-surface-variant text-app-text-tertiary text-[10px] font-medium cursor-help hover:bg-app-accent-light hover:text-app-accent transition-colors">
        ?
      </span>
      {isVisible && (
        <TooltipContent content={content} position={position} />
      )}
    </span>
  );
}

/**
 * Hook for managing tooltip state - for custom trigger elements
 * Returns handlers to attach to a trigger element
 */
export function useTooltip() {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handlers = {
    onMouseEnter: (e: React.MouseEvent) => {
      setIsVisible(true);
      setPosition({ x: e.clientX, y: e.clientY });
    },
    onMouseMove: (e: React.MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });
    },
    onMouseLeave: () => {
      setIsVisible(false);
    },
  };

  return { isVisible, position, handlers };
}

/**
 * Metadata tooltip for search results
 * Shows title, author (looked up by ID), death, genre, corpus
 */
export function MetadataTooltip({
  book,
  position,
  authorsMap,
}: {
  book: {
    title?: string;
    author_id?: number;
    death_ah?: number;
  };
  position: { x: number; y: number };
  authorsMap?: Map<number, string>;
  /** Kept for callsite compatibility; no longer rendered. */
  genresMap?: Map<number, string>;
}) {
  const authorName = book.author_id !== undefined && authorsMap ? authorsMap.get(book.author_id) : undefined;

  const rows: TooltipRow[] = [
    { label: 'Title', value: book.title, parseArabic: true },
    { label: 'Author', value: authorName, parseArabic: true },
    { label: 'Death', value: book.death_ah ? `${book.death_ah} AH` : undefined },
  ];

  return <TooltipContent rows={rows} position={position} width={320} />;
}
