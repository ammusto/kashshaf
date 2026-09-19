import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * A book's table of contents as a tree, shared by Kashshaf's reader and
 * Lab's Read panel.
 *
 * Nested by the `parent` the heading markup carries, not flattened: a chapter
 * and the sections under it are one thing in the book and one thing here.
 * Only the top level opens by default, because a long book's full tree is
 * thousands of entries and none of them are the one being looked for.
 *
 * What is drawn is the list of rows that are open — the tree walked down to
 * the closed entries — and of those only the ones in view, through a
 * virtualiser. Tārīkh Dimashq has 10,000 headings, one chapter of it 2,400
 * sections; opening that chapter mounts a few dozen rows, not 2,400, and a
 * re-render of the pane costs the same whatever the book.
 *
 * A row is two controls, not one. The triangle opens the subtree and the
 * title jumps to the page; neither does the other's job. Depth is shown by
 * indentation alone.
 *
 * Pages are keyed by `(part_index, page_id)`, never by `page_id` alone: 45
 * books restart their page ids in every part.
 */

/** One heading. The shape `toc.db` serves, in both apps. */
export interface TocEntry {
  id: number;
  parent: number;
  title: string;
  part_index: number;
  page_id: number;
  page_number: string;
  depth: number;
  children: TocEntry[];
}

/** A heading as a flat row, which is what `entryForPage` walks. */
export interface TocRowLike {
  id: number;
  parent: number;
  title: string;
  part_index: number;
  page_id: number;
  page_number: string;
}

export interface TocTreeProps<N extends TocEntry = TocEntry> {
  tree: N[];
  /** The page label as the book prints it (`24`, or `3:24` in a multi-part book). */
  label: (partIndex: number, pageId: number) => string;
  /** The entry the page in view sits under, from `entryForPage`. */
  currentId: number | null;
  onJump: (node: N) => void;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  /** What to show when the book has no headings. */
  empty?: ReactNode;
  /** Something below the list, in the same pane (Lab's annotations). */
  footer?: ReactNode;
  /** Heading of the pane. */
  title?: string;
  /** The close button's tooltip. */
  closeTitle?: string;
  /** Layout of the `<aside>` itself; the default is Lab's fixed width. */
  className?: string;
  style?: React.CSSProperties;
  /** Drawn inside the aside before the header (a drag handle, say). */
  children?: ReactNode;
}

/** Every row is one line, truncated, so its height is known without measuring. */
export const TOC_ROW_HEIGHT = 30;
/** Rows drawn beyond the visible ones, above and below. */
const OVERSCAN = 10;
/**
 * The pane's height before it has one: the first frame, and jsdom, where a
 * rect is always empty. Drawing a screenful then is cheap and means the
 * list is never blank for want of a measurement.
 */
const FALLBACK_HEIGHT = 800;

/** A row of the list as drawn: an open entry, at its depth. */
interface VisibleRow {
  node: TocEntry;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export function TocTree<N extends TocEntry = TocEntry>({
  tree,
  label,
  currentId,
  onJump,
  onClose,
  loading,
  error,
  empty,
  footer,
  title = 'Contents',
  closeTitle = 'Hide the contents (Ctrl+T)',
  className = 'w-72 shrink-0 border-l border-app-border-light bg-app-surface flex flex-col min-h-0',
  style,
  children,
}: TocTreeProps<N>) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set<number>());
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const needle = filter.trim();
  const shown = useMemo(() => (needle ? prune(tree, needle) : tree), [tree, needle]);
  // A filtered tree is already the answer; hiding half of it again would
  // mean opening the entries that the filter just found.
  const forceOpen = needle !== '';
  const rows = useMemo(() => visibleRows(shown, open, forceOpen), [shown, open, forceOpen]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TOC_ROW_HEIGHT,
    overscan: OVERSCAN,
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (!el) return;
      const report = () => {
        const r = el.getBoundingClientRect();
        cb({ width: Math.round(r.width), height: r.height > 0 ? Math.round(r.height) : FALLBACK_HEIGHT });
      };
      report();
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(report);
      ro.observe(el);
      return () => ro.disconnect();
    },
  });

  // And bring the current entry into view once its path is open.
  const currentIndex = currentId == null ? -1 : rows.findIndex((r) => r.node.id === currentId);
  useEffect(() => {
    if (currentIndex >= 0) virtualizer.scrollToIndex(currentIndex, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  return (
    <aside className={className} style={style} data-testid="toc-pane">
      {children}
      <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2">
        <h2 className="text-sm font-semibold flex-1">{title}</h2>
        <button onClick={onClose} title={closeTitle} aria-label={closeTitle} className="text-app-text-secondary hover:text-app-text-primary px-1">
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

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-1">
        {loading && <p className="px-3 py-2 text-xs text-app-text-secondary">Loading the contents…</p>}
        {error && (
          <p className="px-3 py-2 text-xs text-app-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && tree.length === 0 && (
          empty ?? <p className="px-3 py-2 text-xs text-app-text-secondary">This text has no headings in the corpus.</p>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <Row
                key={`${row.node.id}-${row.node.part_index}-${row.node.page_id}`}
                row={row}
                top={item.start}
                label={label}
                isCurrent={row.node.id === currentId}
                onJump={onJump as (n: TocEntry) => void}
                toggle={toggle}
              />
            );
          })}
        </div>
      </div>

      {footer}
    </aside>
  );
}

function Row({
  row,
  top,
  label,
  isCurrent,
  onJump,
  toggle,
}: {
  row: VisibleRow;
  top: number;
  label: (partIndex: number, pageId: number) => string;
  isCurrent: boolean;
  onJump: (n: TocEntry) => void;
  toggle: (id: number) => void;
}) {
  const { node, depth, hasChildren, expanded } = row;
  return (
    <div
      dir="rtl"
      data-depth={depth}
      className={`absolute left-0 right-0 flex items-center hover:bg-app-surface-variant ${isCurrent ? 'bg-app-accent-light text-app-accent' : ''}`}
      /* Depth is indentation, nothing else: each level steps in by one em on
         the reading side. */
      style={{ top, height: TOC_ROW_HEIGHT, paddingRight: `${0.5 + depth}rem` }}
    >
      {hasChildren ? (
        <button
          onClick={() => toggle(node.id)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
          data-testid={`toc-toggle-${node.id}`}
          className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-app-text-secondary hover:text-app-text-primary hover:bg-app-border-light"
        >
          {/* A triangle the size of a click target. It points left, into the
              title, because the pane reads right to left; open, it points down. */}
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            className={`transition-transform duration-150 ${expanded ? '-rotate-90' : ''}`}
          >
            <path d="M11 2 L4 8 L11 14 Z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        /* Leaves get no triangle, but they keep the column, so titles at one
           depth line up whether or not they have children. */
        <span className="w-7 shrink-0" aria-hidden="true" />
      )}

      <button
        onClick={() => onJump(node)}
        aria-current={isCurrent ? 'true' : undefined}
        className="flex-1 min-w-0 h-full flex items-center gap-2 pl-3 text-right"
      >
        <span className="flex-1 min-w-0 font-arabic text-sm leading-snug truncate" title={node.title}>
          {node.title}
        </span>
        <span dir="ltr" className="text-[11px] text-app-text-secondary tabular-nums shrink-0">
          {label(node.part_index, node.page_id)}
        </span>
      </button>
    </div>
  );
}

/**
 * The rows the list draws: every entry whose ancestors are all open, in tree
 * order. One pass with an explicit stack, so a deep tree cannot overflow it.
 */
export function visibleRows(tree: TocEntry[], open: ReadonlySet<number>, forceOpen: boolean): VisibleRow[] {
  const out: VisibleRow[] = [];
  const stack: { node: TocEntry; depth: number }[] = [];
  for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], depth: 0 });
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && (forceOpen || open.has(node.id));
    out.push({ node, depth, hasChildren, expanded });
    if (expanded) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }
  return out;
}

/** Every entry's line of ancestors, so the pane can open the path to one. */
export function ancestorsOf(tree: TocEntry[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const walk = (nodes: TocEntry[], path: number[]) => {
    for (const n of nodes) {
      out.set(n.id, path);
      if (n.children.length > 0) walk(n.children, [...path, n.id]);
    }
  };
  walk(tree, []);
  return out;
}

/**
 * Keep an entry if it matches, or if anything under it does — a filter that
 * dropped the parents would flatten the tree it is filtering.
 */
export function prune<N extends TocEntry>(nodes: N[], needle: string): N[] {
  const out: N[] = [];
  for (const n of nodes) {
    const children = prune(n.children as N[], needle);
    if (children.length > 0 || n.title.includes(needle)) out.push({ ...n, children });
  }
  return out;
}

/** The tree as rows in reading order, which is what `entryForPage` walks. */
export function flattenToc<N extends TocEntry>(tree: N[]): N[] {
  const out: N[] = [];
  const walk = (nodes: N[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children as N[]);
    }
  };
  walk(tree);
  // toc.db orders rows by (part_index, page_id, id); a nested tree walked
  // depth-first gives the same order only if children never precede their
  // parent's page, so sort to be sure.
  out.sort((a, b) => a.part_index - b.part_index || a.page_id - b.page_id || a.id - b.id);
  return out;
}

/**
 * The entry a page sits under: the last one at or before it, by
 * `(part_index, page_id)`. `rows` must be in reading order; the search is
 * binary, because it runs on every page the reader passes.
 */
export function entryForPage<R extends TocRowLike>(rows: R[], partIndex: number, pageId: number): R | null {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (r.part_index < partIndex || (r.part_index === partIndex && r.page_id <= pageId)) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? rows[lo - 1] : null;
}
