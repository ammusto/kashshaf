import { useCallback, useEffect, useRef, useState } from 'react';
import { TocTree } from '@kashshaf/shared';
import type { TocNode } from '../../types';
import type { BookToc } from '../../hooks/useBookToc';
import { clampTocWidth } from '../../hooks/useTocPane';

/**
 * The contents pane on the right of the reader.
 *
 * The tree itself is `TocTree` from `@kashshaf/shared`, the same component
 * Lab's Read panel draws; this wraps it with what is Kashshaf's: the width
 * dragged from its left border, and what to say when there is nothing to
 * draw — a book with no headings, a corpus or server that cannot serve one.
 */

interface ReaderTocPaneProps {
  toc: BookToc;
  /** The entry the page in view sits under. */
  currentId: number | null;
  label: (partIndex: number, pageId: number) => string;
  onJump: (node: TocNode) => void;
  onClose: () => void;
  width: number;
  onWidth: (w: number) => void;
  /** Why the source cannot serve a table of contents, when it cannot. */
  unavailableMessage: string;
}

export function ReaderTocPane({ toc, currentId, label, onJump, onClose, width, onWidth, unavailableMessage }: ReaderTocPaneProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  // The border is dragged leftwards to widen: the pane is on the right.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      start.current = { x: e.clientX, width };
      setDragging(true);
    },
    [width]
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = start.current;
      if (!s) return;
      onWidth(clampTocWidth(s.width + (s.x - e.clientX)));
    };
    const onUp = () => {
      start.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onWidth]);

  const nothing =
    toc.availability === 'unavailable' ? (
      <p className="px-3 py-2 text-xs text-app-text-secondary" data-testid="toc-unavailable">
        {unavailableMessage}
      </p>
    ) : (
      <div className="px-3 py-2 text-xs text-app-text-secondary space-y-2" data-testid="toc-empty">
        <p>This text has no table of contents.</p>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 rounded border border-app-border-medium text-app-text-secondary hover:text-app-accent hover:border-app-accent"
        >
          Collapse
        </button>
      </div>
    );

  return (
    <TocTree
      tree={toc.tree}
      label={label}
      currentId={currentId}
      onJump={onJump}
      onClose={onClose}
      loading={toc.availability === 'loading'}
      error={toc.error}
      empty={nothing}
      title="Contents"
      closeTitle="Hide the contents (Ctrl+T)"
      className="relative shrink-0 border-l border-app-border-light bg-app-surface flex flex-col min-h-0"
      style={{ width }}
    >
      {/* The drag handle on the left border, as the search sidebar has on its right. */}
      <div
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the contents"
        data-testid="toc-resize"
        className={`absolute top-0 left-0 w-1 h-full cursor-ew-resize hover:bg-app-accent transition-colors z-10 ${
          dragging ? 'bg-app-accent' : 'bg-transparent'
        }`}
      />
    </TocTree>
  );
}
