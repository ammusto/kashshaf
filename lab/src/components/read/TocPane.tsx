import { useEffect, useMemo, useRef, useState } from 'react';
import { noteColor, type Note, type TocNode } from '../../api/workspace';
import { noteFirstLine } from '../../api/noteText';
import type { Pages } from '../../api/pages';

/**
 * The table of contents (spec 1.5 §B2, §C3; Phase 8 B).
 *
 * Nested by the `parent` the heading markup carries, not flattened: a chapter
 * and the sections under it are one thing in the book and one thing here.
 * Only the top level opens by default, because a long book's full tree is
 * thousands of entries and none of them are the one being looked for.
 *
 * A row is two controls, not one. The triangle opens the subtree and the
 * title jumps to the page; neither does the other's job.
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
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set<number>());
  const currentRef = useRef<HTMLButtonElement | null>(null);

  const ancestors = useMemo(() => ancestorsOf(tree), [tree]);

  // Follow the reader into a closed subtree. A highlight on a hidden entry
  // marks nothing, so paging into a section opens the path down to it.
  useEffect(() => {
    if (currentId == null) return;
    const path = ancestors.get(currentId);
    if (!path || path.length === 0) return;
    setOpen((prev) => {
      if (path.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of path) next.add(id);
      return next;
    });
  }, [currentId, ancestors]);

  // And bring it into view once it is on screen.
  useEffect(() => {
    const el = currentRef.current;
    // jsdom has no scrollIntoView, and a pane that throws here would take the
    // reader down with it.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [currentId, open]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const needle = filter.trim();
  const shown = useMemo(() => (needle ? prune(tree, needle) : tree), [tree, needle]);

  return (
    <aside className="w-72 shrink-0 border-l border-app-border-light bg-app-surface flex flex-col min-h-0" data-testid="toc-pane">
      <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2">
        <h2 className="text-sm font-semibold flex-1">Contents</h2>
        <button onClick={onClose} title="Hide the contents (Ctrl+T)" className="text-app-text-secondary hover:text-app-text-primary px-1">
          ✕
        </button>
      </div>

      {tree.length > 12 && (
        <div className="px-3 py-2 border-b border-app-border-light">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter headings…"
            aria-label="Filter headings"
            dir="rtl"
            className="w-full px-2 py-1 font-arabic text-base border border-app-border-medium rounded focus:outline-none focus:border-app-border-focus"
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {loading && <p className="px-3 py-2 text-xs text-app-text-secondary">Loading the contents…</p>}
        {error && (
          <p className="px-3 py-2 text-xs text-app-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && tree.length === 0 && (
          <p className="px-3 py-2 text-xs text-app-text-secondary">This text has no headings in the corpus.</p>
        )}
        {shown.map((n, i) => (
          <Entry
            key={`${n.id}-${n.part_index}-${n.page_id}`}
            node={n}
            guides={[]}
            last={i === shown.length - 1}
            pages={pages}
            currentId={currentId}
            onJump={onJump}
            currentRef={currentRef}
            open={open}
            toggle={toggle}
            /* A filtered tree is already the answer; hiding half of it again
               would mean opening the entries that the filter just found. */
            forceOpen={needle !== ''}
          />
        ))}
      </div>

      {onJumpNote && <Annotations notes={notes} pages={pages} onJump={onJumpNote} />}
    </aside>
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

function Entry({
  node,
  pages,
  currentId,
  onJump,
  currentRef,
  open,
  toggle,
  forceOpen,
  guides,
  last,
}: {
  node: TocNode;
  pages: Pages;
  currentId: number | null;
  onJump: (n: TocNode) => void;
  currentRef: React.MutableRefObject<HTMLButtonElement | null>;
  open: ReadonlySet<number>;
  toggle: (id: number) => void;
  forceOpen: boolean;
  /** For each ancestor, whether it still has a sibling below it (10 E). */
  guides: boolean[];
  /** Whether this entry is the last of its own siblings. */
  last: boolean;
}) {
  const isCurrent = node.id === currentId;
  const hasChildren = node.children.length > 0;
  const expanded = forceOpen || open.has(node.id);

  return (
    <>
      <div
        dir="rtl"
        className={`flex items-baseline hover:bg-app-surface-variant ${isCurrent ? 'bg-app-accent-light text-app-accent' : ''}`}
        style={{ paddingRight: '0.75rem' }}
      >
        {/* The tree, drawn rather than implied by margin (10 E). The glyphs
            are the mirror of the usual ones because the pane reads right to
            left: the branch has to point at the title, which is to the
            left of it. */}
        {node.depth > 0 && (
          <span className="font-mono text-xs leading-6 whitespace-pre select-none text-app-text-secondary shrink-0" aria-hidden="true" data-testid={`guide-${node.id}`}>
            {guides.map((more) => (more ? '\u2502  ' : '   ')).join('')}
            {last ? '\u2518\u2500\u2500' : '\u2524\u2500\u2500'}
          </span>
        )}
        {hasChildren ? (
          <button
            onClick={() => toggle(node.id)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
            data-testid={`toc-toggle-${node.id}`}
            className="w-5 shrink-0 py-1 text-[10px] leading-none text-app-text-secondary hover:text-app-text-primary"
          >
            <span className={`inline-block transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} aria-hidden="true">
              ▸
            </span>
          </button>
        ) : (
          /* Leaves get no triangle, but they keep the column, so titles at one
             depth line up whether or not they have children. */
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}

        <button
          ref={(el) => {
            if (isCurrent) currentRef.current = el;
          }}
          onClick={() => onJump(node)}
          aria-current={isCurrent ? 'true' : undefined}
          className="flex-1 min-w-0 flex items-baseline gap-2 py-1 pl-3 text-right"
        >
          <span className="flex-1 min-w-0 font-arabic text-sm leading-snug truncate" title={node.title}>
            {node.title}
          </span>
          <span dir="ltr" className="text-[11px] text-app-text-secondary tabular-nums shrink-0">
            {pages.label(node.part_index, node.page_id)}
          </span>
        </button>
      </div>

      {expanded &&
        node.children.map((c, i) => (
          <Entry
            key={`${c.id}-${c.part_index}-${c.page_id}`}
            node={c}
            guides={[...guides, !last]}
            last={i === node.children.length - 1}
            pages={pages}
            currentId={currentId}
            onJump={onJump}
            currentRef={currentRef}
            open={open}
            toggle={toggle}
            forceOpen={forceOpen}
          />
        ))}
    </>
  );
}

/** Every entry's line of ancestors, so the pane can open the path to one. */
export function ancestorsOf(tree: TocNode[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const walk = (nodes: TocNode[], path: number[]) => {
    for (const n of nodes) {
      out.set(n.id, path);
      walk(n.children, [...path, n.id]);
    }
  };
  walk(tree, []);
  return out;
}

/**
 * Keep an entry if it matches, or if anything under it does — a filter that
 * dropped the parents would flatten the tree it is filtering.
 */
export function prune(nodes: TocNode[], needle: string): TocNode[] {
  const out: TocNode[] = [];
  for (const n of nodes) {
    const children = prune(n.children, needle);
    if (children.length > 0 || n.title.includes(needle)) out.push({ ...n, children });
  }
  return out;
}
