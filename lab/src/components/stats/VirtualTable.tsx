import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * A sortable, virtualised table with a sticky header (spec §7.3): every
 * Stats tab renders its rows through this, so a 50,000-row frequency list
 * costs the same as a 50-row one.
 */

export interface Column<T> {
  key: string;
  label: string;
  /** What is shown; defaults to `String(sortValue(row))`. */
  render?: (row: T) => React.ReactNode;
  /** What the column sorts by; a `null` sorts last. */
  sortValue: (row: T) => string | number | null | undefined;
  /** Arabic columns are right-to-left and use the Arabic face. */
  rtl?: boolean;
  align?: 'left' | 'right';
  width?: string;
  /** Column starts sorted this way; the first such column wins. */
  defaultSort?: 'asc' | 'desc';
}

export const ROW_HEIGHT = 32;

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ar');
}

export function VirtualTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  onRowCtrlClick,
  scrollToKey,
  height = 480,
  dir,
  emptyText = 'Nothing to show.',
  testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
  /** Ctrl/⌘-click, when it should do something other than a plain click. */
  onRowCtrlClick?: (row: T) => void;
  /** Scroll the row with this key into view whenever it changes. */
  scrollToKey?: string | number | null;
  /** Pixels, or `'fill'` to take the parent's height (the parent must have one). */
  height?: number | 'fill';
  /**
   * Lay the columns out right to left. A concordance reads the way its text
   * does (spec 1.5 §E): the first column is the rightmost one.
   */
  dir?: 'ltr' | 'rtl';
  emptyText?: string;
  testId?: string;
}) {
  const initial = columns.find((c) => c.defaultSort);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    initial ? { key: initial.key, dir: initial.defaultSort! } : null
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const withIndex = rows.map((r, i) => ({ r, i }));
    withIndex.sort((x, y) => {
      const c = compare(col.sortValue(x.r), col.sortValue(y.r));
      return (sort.dir === 'asc' ? c : -c) || x.i - y.i;
    });
    return withIndex.map((x) => x.r);
  }, [rows, sort, columns]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Until the scroll element has been measured (first paint; always, under
  // jsdom) the virtualiser lays out nothing. Rather than a blank table, show
  // the first screen of rows plainly; the virtual layout takes over as soon
  // as a measurement exists.
  useEffect(() => {
    if (scrollToKey == null) return;
    const i = sorted.findIndex((r, k) => rowKey(r, k) === scrollToKey);
    if (i >= 0) {
      try {
        virtualizer.scrollToIndex(i, { align: 'center' });
      } catch {
        /* unmeasured under jsdom */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToKey, sorted]);
  const measured = virtualizer.getVirtualItems();
  const fallback = measured.length === 0 && sorted.length > 0;
  const fallbackRows = height === 'fill' ? 40 : Math.ceil(height / ROW_HEIGHT) + 8;
  const items = fallback
    ? sorted.slice(0, fallbackRows).map((_, index) => ({ index, start: index * ROW_HEIGHT, size: ROW_HEIGHT }))
    : measured;
  const totalSize = fallback ? sorted.length * ROW_HEIGHT : virtualizer.getTotalSize();

  const toggle = (key: string) =>
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const grid = columns.map((c) => c.width ?? 'minmax(80px, 1fr)').join(' ');

  return (
    <div className={`border border-app-border-light rounded overflow-hidden bg-app-surface ${height === 'fill' ? 'h-full flex flex-col' : ''}`} data-testid={testId}>
      <div
        role="row"
        dir={dir}
        className="grid text-xs font-medium text-app-text-secondary bg-app-surface-variant border-b border-app-border-light"
        style={{ gridTemplateColumns: grid }}
      >
        {columns.map((c) => (
          <button
            key={c.key}
            role="columnheader"
            onClick={() => toggle(c.key)}
            className={`px-2 py-1.5 truncate hover:bg-app-border-light ${c.align === 'right' ? 'text-right' : 'text-left'}`}
            dir={dir}
            title={`Sort by ${c.label}`}
          >
            {c.label}
            {sort?.key === c.key && <span className="ml-1">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
          </button>
        ))}
      </div>
      <div ref={parentRef} className={height === 'fill' ? 'flex-1 min-h-0' : ''} style={{ height: height === 'fill' ? undefined : height, overflow: 'auto' }}>
        {sorted.length === 0 ? (
          <div className="p-4 text-sm text-app-text-tertiary">{emptyText}</div>
        ) : (
          <div style={{ height: totalSize, position: 'relative' }}>
            {items.map((v) => {
              const row = sorted[v.index];
              return (
                <div
                  key={rowKey(row, v.index)}
                  role="row"
                  dir={dir}
                  onClick={onRowClick || onRowCtrlClick ? (e) => ((e.ctrlKey || e.metaKey) && onRowCtrlClick ? onRowCtrlClick(row) : onRowClick?.(row)) : undefined}
                  className={`grid items-center text-sm border-b border-app-border-light ${
                    onRowClick ? 'cursor-pointer hover:bg-app-accent-light' : ''
                  }`}
                  style={{
                    gridTemplateColumns: grid,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: v.size,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      role="cell"
                      dir={c.rtl ? 'rtl' : 'ltr'}
                      className={`px-2 truncate ${c.rtl ? 'font-arabic text-base' : ''} ${
                        c.align === 'right' ? 'text-right' : c.align === 'left' ? 'text-left' : ''
                      } ${c.align === 'right' && !c.rtl ? 'tabular-nums' : ''}`}
                    >
                      {c.render ? c.render(row) : String(c.sortValue(row) ?? '—')}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A number for a table cell: integers plain, rates to 1–2 decimals. */
export function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
