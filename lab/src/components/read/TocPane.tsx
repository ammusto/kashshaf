import { useEffect, useMemo, useRef, useState } from 'react';
import type { TocNode } from '../../api/workspace';
import type { Pages } from '../../api/pages';

/**
 * The table of contents (spec 1.5 §B2, §C3).
 *
 * Nested by the `parent` the heading markup carries, not flattened: a chapter
 * and the sections under it are one thing in the book and one thing here.
 * Clicking an entry jumps to its page; whichever entry the reader is inside
 * stays highlighted as they page through.
 */

export function TocPane({
  tree,
  pages,
  currentId,
  onJump,
  onClose,
  loading,
  error,
}: {
  tree: TocNode[];
  pages: Pages;
  /** The entry the open page sits under, from `entryForPage`. */
  currentId: number | null;
  onJump: (node: TocNode) => void;
  onClose: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [filter, setFilter] = useState('');
  const currentRef = useRef<HTMLButtonElement | null>(null);

  // Follow the reader: when the page moves into another section, bring that
  // entry into view rather than leaving the pane where it was.
  useEffect(() => {
    const el = currentRef.current;
    // jsdom has no scrollIntoView, and a pane that throws here would take the
    // reader down with it.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  const needle = filter.trim();
  const shown = useMemo(() => (needle ? prune(tree, needle) : tree), [tree, needle]);

  return (
    <aside className="w-72 shrink-0 border-l border-app-border-light bg-app-surface flex flex-col min-h-0" data-testid="toc-pane">
      <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2">
        <h2 className="text-sm font-semibold flex-1">Contents</h2>
        <button onClick={onClose} title="Hide the contents (Ctrl+T)" className="text-app-text-tertiary hover:text-app-text-primary px-1">
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

      <div className="flex-1 overflow-y-auto py-1">
        {loading && <p className="px-3 py-2 text-xs text-app-text-tertiary">Loading the contents…</p>}
        {error && (
          <p className="px-3 py-2 text-xs text-app-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && tree.length === 0 && (
          <p className="px-3 py-2 text-xs text-app-text-tertiary">This text has no headings in the corpus.</p>
        )}
        {shown.map((n) => (
          <Entry key={`${n.id}-${n.part_index}-${n.page_id}`} node={n} pages={pages} currentId={currentId} onJump={onJump} currentRef={currentRef} />
        ))}
      </div>
    </aside>
  );
}

function Entry({
  node,
  pages,
  currentId,
  onJump,
  currentRef,
}: {
  node: TocNode;
  pages: Pages;
  currentId: number | null;
  onJump: (n: TocNode) => void;
  currentRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
  const isCurrent = node.id === currentId;
  return (
    <>
      <button
        ref={(el) => {
          if (isCurrent) currentRef.current = el;
        }}
        onClick={() => onJump(node)}
        aria-current={isCurrent ? 'true' : undefined}
        className={`w-full flex items-baseline gap-2 px-3 py-1 text-right hover:bg-app-surface-variant ${
          isCurrent ? 'bg-app-accent-light text-app-accent' : ''
        }`}
        style={{ paddingRight: `${0.75 + node.depth * 0.75}rem` }}
      >
        <span className="flex-1 min-w-0 font-arabic text-sm leading-snug truncate" dir="rtl" title={node.title}>
          {node.title}
        </span>
        <span className="text-[11px] text-app-text-tertiary tabular-nums shrink-0">{pages.label(node.part_index, node.page_id)}</span>
      </button>
      {node.children.map((c) => (
        <Entry key={`${c.id}-${c.part_index}-${c.page_id}`} node={c} pages={pages} currentId={currentId} onJump={onJump} currentRef={currentRef} />
      ))}
    </>
  );
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
