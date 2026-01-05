import { useState, useRef, useEffect, useCallback } from 'react';

interface SearchTabProps {
  id: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

function SearchTab({ label, isActive, onClick, onClose }: SearchTabProps) {
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      className={`relative flex items-center gap-1 px-3 py-1.5 rounded-t-lg cursor-pointer
                  text-sm transition-colors flex-shrink-0
                  ${isActive
                    ? 'bg-white text-app-text-primary font-medium shadow-sm'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}
      style={{ maxWidth: '200px', minWidth: '60px' }}
      onClick={onClick}
      title={label}
    >
      <span className="truncate flex-1" dir="rtl">{label}</span>
      <button
        onClick={handleClose}
        className="w-4 h-4 flex-shrink-0 rounded hover:bg-red-100 flex items-center justify-center
                   text-app-text-tertiary hover:text-red-600 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export interface TabData {
  id: string;
  label: string;
  fullQuery: string;
}

interface SearchTabsProps {
  tabs: TabData[];
  activeTabId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
}

export function SearchTabs({ tabs, activeTabId, onTabClick, onTabClose }: SearchTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [showNavButtons, setShowNavButtons] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const container = containerRef.current;
    const tabsEl = tabsRef.current;
    if (!container || !tabsEl) return;

    const isOverflowing = tabsEl.scrollWidth > container.clientWidth;
    setShowNavButtons(isOverflowing);

    if (isOverflowing) {
      setCanScrollLeft(tabsEl.scrollLeft > 0);
      setCanScrollRight(tabsEl.scrollLeft < tabsEl.scrollWidth - tabsEl.clientWidth - 1);
    }
  }, []);

  useEffect(() => {
    updateScrollState();
    window.addEventListener('resize', updateScrollState);
    return () => window.removeEventListener('resize', updateScrollState);
  }, [updateScrollState, tabs.length]);

  const scrollLeft = () => {
    const tabsEl = tabsRef.current;
    if (!tabsEl) return;
    tabsEl.scrollBy({ left: -150, behavior: 'smooth' });
  };

  const scrollRight = () => {
    const tabsEl = tabsRef.current;
    if (!tabsEl) return;
    tabsEl.scrollBy({ left: 150, behavior: 'smooth' });
  };

  const handleScroll = () => {
    updateScrollState();
  };

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="flex items-center gap-1">
      {/* Left scroll button */}
      {showNavButtons && (
        <button
          onClick={scrollLeft}
          disabled={!canScrollLeft}
          className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded
                      transition-colors ${canScrollLeft
                        ? 'text-app-text-secondary hover:bg-gray-200 hover:text-app-text-primary'
                        : 'text-gray-300 cursor-not-allowed'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Tabs container */}
      <div
        ref={tabsRef}
        className="flex overflow-hidden gap-1 flex-1"
        onScroll={handleScroll}
      >
        {tabs.map((tab) => (
          <SearchTab
            key={tab.id}
            id={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            onClick={() => onTabClick(tab.id)}
            onClose={() => onTabClose(tab.id)}
          />
        ))}
      </div>

      {/* Right scroll button */}
      {showNavButtons && (
        <button
          onClick={scrollRight}
          disabled={!canScrollRight}
          className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded
                      transition-colors ${canScrollRight
                        ? 'text-app-text-secondary hover:bg-gray-200 hover:text-app-text-primary'
                        : 'text-gray-300 cursor-not-allowed'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
