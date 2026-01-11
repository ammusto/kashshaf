import { useState, useRef, useEffect, useCallback } from 'react';
import type { AppSearchMode, CombinedSearchQuery, ProximitySearchQuery } from '../types/search';
import type { NameFormData } from '../utils/namePatterns';
import { NameSearchForm } from './name-search';
import { Toast } from './ui';
import { BooleanSearchPanel } from './sidebar/BooleanSearchPanel';
import { ProximitySearchPanel } from './sidebar/ProximitySearchPanel';
import { CorpusSelector } from './sidebar/CorpusSelector';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../constants/search';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  onSearch: (combined: CombinedSearchQuery) => void;
  onProximitySearch: (query: ProximitySearchQuery) => void;
  onNameSearch: () => void;
  onOpenTextSelection: () => void;
  onSaveCollection?: () => void;
  loading: boolean;
  indexedPages: number;
  selectedTextsCount: number;
  appSearchMode: AppSearchMode;
  onAppSearchModeChange: (mode: AppSearchMode) => void;
  nameFormData: NameFormData[];
  onNameFormDataChange: (forms: NameFormData[]) => void;
  generatedPatterns: string[][];
}

const MIN_WIDTH = SIDEBAR_MIN_WIDTH;
const MAX_WIDTH = SIDEBAR_MAX_WIDTH;

export function Sidebar({
  isOpen,
  onToggle,
  onSearch,
  onProximitySearch,
  onNameSearch,
  onOpenTextSelection,
  onSaveCollection,
  loading,
  indexedPages: _indexedPages,
  selectedTextsCount,
  appSearchMode,
  onAppSearchModeChange,
  nameFormData,
  onNameFormDataChange,
  generatedPatterns,
}: SidebarProps) {
  // Term search mode: 'boolean' or 'proximity' (only used when appSearchMode === 'terms')
  const [termSearchMode, setTermSearchMode] = useState<'boolean' | 'proximity'>('boolean');

  // Toast state for validation errors
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Sidebar width state with drag
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebarWidth');
    return saved ? parseInt(saved, 10) : MIN_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Save width to localStorage
  useEffect(() => {
    localStorage.setItem('sidebarWidth', width.toString());
  }, [width]);

  // Handle drag resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = e.clientX;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  if (!isOpen) {
    return (
      <div className="w-14 bg-white border-r border-app-border-light flex flex-col items-center py-4 shadow-sm">
        <button
          onClick={onToggle}
          className="p-2.5 bg-app-surface-variant rounded-lg hover:bg-app-accent-light transition-colors"
          title="Open sidebar"
        >
          <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={sidebarRef}
      style={{ width }}
      className="bg-white border-r border-app-border-light flex flex-col transition-colors duration-300 shadow-sm relative"
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-app-accent transition-colors z-10 ${isDragging ? 'bg-app-accent' : 'bg-transparent'
          }`}
      />

      <div className="p-5 space-y-4 flex flex-col h-full overflow-hidden">
        {/* Header with Mode Selector */}
        <div className="flex items-center gap-2 h-10 flex-shrink-0">
          <button
            onClick={() => onAppSearchModeChange('terms')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              appSearchMode === 'terms'
                ? 'bg-app-accent text-white shadow-sm'
                : 'bg-white text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
            }`}
          >
            Terms
          </button>
          <button
            onClick={() => onAppSearchModeChange('names')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              appSearchMode === 'names'
                ? 'bg-app-accent text-white shadow-sm'
                : 'bg-white text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
            }`}
          >
            Names
          </button>
          <button
            onClick={onToggle}
            className="p-2 bg-app-surface-variant rounded-lg hover:bg-app-accent-light transition-colors flex-shrink-0"
            title="Collapse sidebar"
          >
            <svg className="w-4 h-4 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Search Section - conditional based on appSearchMode */}
        {appSearchMode === 'terms' && (
          <div className="space-y-3 flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Boolean / Proximity Mode Toggle */}
            <div className="flex gap-1 h-9 flex-shrink-0">
              <button
                onClick={() => setTermSearchMode('boolean')}
                className={`flex-1 rounded-md text-sm font-semibold transition-colors ${termSearchMode === 'boolean'
                  ? 'bg-app-accent text-white shadow-sm'
                  : 'bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
                  }`}
              >
                Boolean
              </button>
              <button
                onClick={() => setTermSearchMode('proximity')}
                className={`flex-1 rounded-md text-sm font-semibold transition-colors ${termSearchMode === 'proximity'
                  ? 'bg-app-accent text-white shadow-sm'
                  : 'bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light border border-app-border-light'
                  }`}
              >
                Proximity
              </button>
            </div>

            {/* Boolean Search UI */}
            {termSearchMode === 'boolean' && (
              <BooleanSearchPanel
                onSearch={onSearch}
                onClearForm={() => {}}
                loading={loading}
                showToast={showToast}
              />
            )}

            {/* Proximity Search UI */}
            {termSearchMode === 'proximity' && (
              <ProximitySearchPanel
                onSearch={onProximitySearch}
                onClearForm={() => {}}
                loading={loading}
              />
            )}
          </div>
        )}

        {/* Name Search Section */}
        {appSearchMode === 'names' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <NameSearchForm
              forms={nameFormData}
              onFormsChange={onNameFormDataChange}
              onSearch={onNameSearch}
              loading={loading}
              generatedPatterns={generatedPatterns}
            />
          </div>
        )}

        <div className="h-px bg-app-border-light flex-shrink-0" />

        {/* Text Selection Section - stays at bottom */}
        <CorpusSelector
          selectedTextsCount={selectedTextsCount}
          onOpenTextSelection={onOpenTextSelection}
          onSaveCollection={onSaveCollection}
        />
      </div>

      {/* Toast for validation errors */}
      {toastMessage && (
        <Toast
          message={toastMessage}
          type="error"
          onClose={() => setToastMessage(null)}
        />
      )}
    </div>
  );
}
