import { useState } from 'react';
import { TocTree } from '@kashshaf/shared';
import { noteColor, type Note, type TocNode } from '../../api/workspace';
import { noteFirstLine } from '../../api/noteText';
import type { Pages } from '../../api/pages';

/**
 * The table of contents (spec 1.5 §B2, §C3; Phase 8 B).
 *
 * The tree — connectors, triangles, the path opened to the page in view — is
 * `TocTree` in `@kashshaf/shared`, which Kashshaf's reader draws too. What is
 * Lab's is below it: the annotations list (9 B1).
 */

export function TocPane({
  tree,
  pages,
  currentId,
  onJump,
  onClose,
  loading,
  error,
  notes = [],
  onJumpNote,
}: {
  tree: TocNode[];
  pages: Pages;
  /** The entry the open page sits under, from `entryForPage`. */
  currentId: number | null;
  onJump: (node: TocNode) => void;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  /** This text's annotations, in reading order (9 B1). */
  notes?: Note[];
  onJumpNote?: (n: Note) => void;
}) {
  return (
    <TocTree
      tree={tree}
      label={(part, page) => pages.label(part, page)}
      currentId={currentId}
      onJump={onJump}
      onClose={onClose}
      loading={loading}
      error={error}
      footer={onJumpNote ? <Annotations notes={notes} pages={pages} onJump={onJumpNote} /> : undefined}
    />
  );
}

/**
 * The text's annotations, under the contents (9 B1). Closed to begin with:
 * it is a second list in a narrow pane, and the contents are what the pane
 * is for.
 */
function Annotations({ notes, pages, onJump }: { notes: Note[]; pages: Pages; onJump: (n: Note) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-t border-app-border-light" data-testid="annotations-section">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-app-surface-variant"
        data-testid="annotations-toggle"
      >
        <span className={`inline-block text-[10px] leading-none transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="text-sm font-semibold flex-1">Annotations</span>
        <span className="text-xs text-app-text-secondary tabular-nums">{notes.length}</span>
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-app-border-light" data-testid="annotations-list">
          {notes.length === 0 && <p className="px-3 py-2 text-xs text-app-text-secondary">Select some words and press Annotate.</p>}
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => onJump(n)}
              className="w-full flex items-start gap-2 px-3 py-1.5 text-right border-b border-app-border-light hover:bg-app-surface-variant"
              data-testid={`annotation-${n.id}`}
            >
              <span className={`mt-1 w-2.5 h-2.5 shrink-0 rounded-sm tok-note tok-note-${noteColor(n.color)}`} aria-hidden="true" />
              {/* 10 C: the note, not the words it is on; those are in the
                  text, one click away. */}
              <span className="flex-1 min-w-0 text-sm leading-snug truncate" dir="auto">
                {noteFirstLine(n.text, 60) || '(empty note)'}
              </span>
              <span className="text-[11px] text-app-text-secondary tabular-nums shrink-0 mt-0.5" dir="ltr">
                {pages.label(n.part_index, n.page_id)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Lab's own helpers kept their names; the implementations are the shared ones.
export { ancestorsOf, prune } from '@kashshaf/shared';
