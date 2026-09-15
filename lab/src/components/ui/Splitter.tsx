import { useEffect, useRef, useState } from 'react';

/**
 * The draggable divider between the text and its results, following
 * Kashshaf's `ui/DraggableSplitter`: same grab area, same indicator, same
 * 20-80 bounds, so the two apps feel alike.
 */
export function Splitter({ ratio, onDrag }: { ratio: number; onDrag: (r: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const from = useRef<{ height: number; y: number; ratio: number } | null>(null);

  const start = (e: React.MouseEvent) => {
    const parent = ref.current?.parentElement;
    if (parent) {
      from.current = { height: parent.getBoundingClientRect().height, y: e.clientY, ratio };
    }
    setDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const f = from.current;
      if (!f) return;
      const next = f.ratio + (e.clientY - f.y) / f.height;
      if (next > 0.2 && next < 0.8) onDrag(next);
    };
    const up = () => {
      setDragging(false);
      from.current = null;
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, [dragging, onDrag]);

  return (
    <div
      ref={ref}
      onMouseDown={start}
      role="separator"
      aria-orientation="horizontal"
      data-testid="splitter"
      className={`h-1.5 cursor-row-resize transition-colors flex-shrink-0 relative group mb-2 ${
        dragging ? 'bg-app-accent' : 'bg-app-border-medium hover:bg-app-accent'
      }`}
      style={{ touchAction: 'none', userSelect: 'none' }}
    >
      <div className="absolute inset-x-0 -top-1 -bottom-1" />
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-1 rounded-full transition-colors ${
          dragging ? 'bg-white' : 'bg-app-text-tertiary group-hover:bg-white'
        }`}
      />
    </div>
  );
}

/**
 * A pane whose width is dragged by its right border and remembered, as
 * Kashshaf's sidebar is (Phase 7 D).
 */
export function useDragWidth(key: string, initial: number, min = 200, max = 640) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => setWidth(Math.min(max, Math.max(min, e.clientX)));
    const up = () => setDragging(false);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, min, max]);

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      /* private window, or storage disabled: the width just does not persist */
    }
  }, [key, width]);

  /** Put this on the pane; it draws its own grab strip on the right edge. */
  const handle = (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      role="separator"
      aria-orientation="vertical"
      data-testid="width-handle"
      className={`absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-app-accent transition-colors z-10 ${
        dragging ? 'bg-app-accent' : 'bg-transparent'
      }`}
    />
  );

  return { width, handle };
}
