import { useState, useEffect, useRef } from 'react';

/** The reader's share of the height: what a drag may reach. */
export const SPLITTER_MIN_RATIO = 0.2;
/** At this ratio the results pane is at its minimum draggable height. */
export const SPLITTER_MAX_RATIO = 0.8;

interface DraggableSplitterProps {
  ratio: number;
  onDrag: (ratio: number) => void;
}

export function DraggableSplitter({ ratio, onDrag }: DraggableSplitterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const splitterRef = useRef<HTMLDivElement>(null);
  const dragInfoRef = useRef<{
    containerTop: number;
    containerHeight: number;
    startY: number;
    startRatio: number;
  } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    const splitter = splitterRef.current;
    if (splitter) {
      const parent = splitter.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        // Capture starting position and current ratio
        dragInfoRef.current = {
          containerTop: rect.top,
          containerHeight: rect.height,
          startY: e.clientY,
          startRatio: ratio,
        };
      }
    }
    setIsDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dragInfo = dragInfoRef.current;
      if (!dragInfo) return;

      // Calculate delta from start position and convert to ratio change
      const deltaY = e.clientY - dragInfo.startY;
      const deltaRatio = deltaY / dragInfo.containerHeight;
      const newRatio = dragInfo.startRatio + deltaRatio;

      // Constrain to the named bounds.
      if (newRatio > SPLITTER_MIN_RATIO && newRatio < SPLITTER_MAX_RATIO) {
        onDrag(newRatio);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragInfoRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onDrag]);

  return (
    <div
      ref={splitterRef}
      data-testid="splitter"
      onMouseDown={handleMouseDown}
      className={`
        h-1.5 cursor-row-resize transition-colors flex-shrink-0 relative group mb-2
        ${isDragging ? 'bg-app-accent' : 'bg-app-border-medium hover:bg-app-accent'}
      `}
      style={{ touchAction: 'none', userSelect: 'none' }}
    >
      {/* Wider hit area */}
      <div className="absolute inset-x-0 -top-1 -bottom-1" />
      {/* Visual indicator */}
      <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                      w-12 h-1 rounded-full transition-colors
                      ${isDragging ? 'bg-white' : 'bg-app-text-tertiary group-hover:bg-white'}`} />
    </div>
  );
}
