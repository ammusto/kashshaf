# Kashshaf UI Specification
## Medieval Arabic Text Research Environment - Interface Design

**Version:** 2.0
**Last Updated:** December 2025

---

## Technology Stack

### Frontend
- **Framework:** React 18 (TypeScript)
- **Desktop:** Tauri 2.x (Rust backend, OS WebView)
- **Styling:** TailwindCSS 3.x with custom design system
- **Virtualization:** TanStack React Virtual (for results list)
- **State:** React useState/useMemo (no external state library)
- **Arabic Fonts:** Local font stack with system fallbacks

### Backend (Rust)
- **Search:** Tantivy 0.25
- **Data:** SQLite via rusqlite
- **IPC:** Tauri commands (@tauri-apps/api)

### Platform
- **Windows:** Edge WebView2 (built into Windows 10+)
- **macOS:** Safari WebView (built into macOS)
- **Linux:** WebKitGTK

---

## Color Scheme (Light Professional Academic)

**Tailwind Config (`tailwind.config.js`):**

```javascript
module.exports = {
  theme: {
    extend: {
      colors: {
        'app-bg': '#FAFAFA',
        'app-surface': '#FFFFFF',
        'app-surface-variant': '#F5F5F5',
        'app-text-primary': '#1A1A1A',
        'app-text-secondary': '#666666',
        'app-text-tertiary': '#999999',
        'app-accent': '#2C5F8D',
        'app-accent-hover': '#1E4A6F',
        'app-accent-light': '#E8F1F8',
        'app-border-light': '#E0E0E0',
        'app-border-medium': '#CCCCCC',
        'app-border-focus': '#2C5F8D',
        'app-success': '#28A745',
        'app-warning': '#FFC107',
        'app-error': '#DC3545',
      },
      boxShadow: {
        'app-sm': '0 1px 2px rgba(0,0,0,0.05)',
        'app-md': '0 2px 8px rgba(0,0,0,0.08)',
        'app-lg': '0 4px 16px rgba(0,0,0,0.12)',
      },
      fontFamily: {
        'arabic': ['Noto Naskh Arabic', 'Amiri', 'serif'],
      }
    }
  }
}
```

**Typography:**
- **Arabic text:** `font-arabic` class (Noto Naskh Arabic, Amiri fallback)
- **UI/Latin:** System fonts (Inter, SF Pro)
- **Sizes:** Body 20px (Arabic), UI labels 12-14px
- **Line height:** 1.8 for Arabic (`leading-loose`), 1.5 for UI

---

## Application Layout

### Main Window Structure

```jsx
<div className="h-screen w-screen flex bg-app-bg overflow-hidden">
  {/* Left Sidebar - Toggleable, 320px */}
  <Sidebar isOpen={sidebarOpen} onToggle={toggle} />

  {/* Main Content - Two Panels with Draggable Splitter */}
  <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">

    {/* READER PANEL (Top, default 60%) */}
    <div style={{ flex: splitterRatio }} className="overflow-hidden rounded-xl shadow-app-md">
      <ReaderPanel
        currentPage={currentPage}
        tokens={pageTokens}
        matchedTokenIndices={matchedTokenIndices}
        onNavigate={handleNavigatePage}
      />
    </div>

    {/* Draggable Splitter */}
    <DraggableSplitter ratio={splitterRatio} onDrag={setSplitterRatio} />

    {/* RESULTS PANEL (Bottom, default 40%) */}
    <div style={{ flex: 1 - splitterRatio }} className="overflow-hidden rounded-xl shadow-app-md">
      <ResultsPanel
        results={searchResults}
        onResultClick={handleResultClick}
        onLoadMore={handleLoadMore}
        loading={loading}
        loadingMore={loadingMore}
      />
    </div>
  </div>

  {/* Modals */}
  {textSelectionModalOpen && <TextSelectionModal />}
</div>
```

### Visual Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Window Chrome (Tauri native)                                    │
├──────────────────────────────────────────────────────────────────┤
│┌────────┐                                                        │
││        │     READER PANEL (Top ~60%)                            │
││ SIDE   │  ┌──────────────────────────────────────────────────┐  │
││ BAR    │  │ [Book Title]              [Vol:Page] [← Prev][Next →]│
││        │  ├──────────────────────────────────────────────────┤  │
││ Search │  │                                                  │  │
││ Mode   │  │  Arabic text with tashkeel preserved             │  │
││ Filters│  │  Click any word → morphological popup            │  │
││        │  │  Highlighted tokens shown in red                 │  │
││        │  │                                                  │  │
││        │  └──────────────────────────────────────────────────┘  │
││        │                                                        │
││        │  ═══════════════════════════════════════════════════   │
││        │              ↕ Draggable Splitter                      │
││        │                                                        │
││        │     RESULTS PANEL (Bottom ~40%)                        │
││        │  ┌────────┬───────────────────────────┬────────────┐  │
││        │  │Vol:Page│    Context with Highlight  │   Title    │  │
││        │  ├────────┼───────────────────────────┼────────────┤  │
││        │  │ 1:150  │ ...والعقل الأول هو...     │ كتاب العلم │  │
││        │  │ 2:45   │ ...قال في العقل الكلي...  │ الفتوحات  │  │
│└────────┘  └────────┴───────────────────────────┴────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Sidebar Component (320px)

### Structure

```jsx
function Sidebar({ isOpen, onToggle, onSearch, onProximitySearch, loading }) {
  // State for search inputs
  const [searchInputs, setSearchInputs] = useState([{ id: 0, query: '', mode: 'lemma', clitic: false }]);
  const [activeTab, setActiveTab] = useState<'and' | 'or'>('and');

  // Proximity search state
  const [proximityMode, setProximityMode] = useState(false);
  const [term1, setTerm1] = useState({ query: '', field: 'lemma' });
  const [term2, setTerm2] = useState({ query: '', field: 'lemma' });
  const [distance, setDistance] = useState(10);

  return (
    <div className={`bg-app-surface border-r border-app-border-light
                    transition-all duration-300 flex flex-col
                    ${isOpen ? 'w-80' : 'w-12'}`}>
      {/* Collapsed state */}
      {!isOpen && <CollapsedSidebar onToggle={onToggle} />}

      {/* Expanded state */}
      {isOpen && (
        <div className="flex flex-col h-full p-4 space-y-3">
          {/* Header */}
          <Header onToggle={onToggle} indexedPages={indexedPages} />

          {/* Search Section */}
          <SearchSection
            searchInputs={searchInputs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onInputChange={updateInput}
            onAddInput={addInput}
            onRemoveInput={removeInput}
            onSearch={handleSearch}
            loading={loading}
          />

          <Divider />

          {/* Proximity Search Toggle */}
          <ProximitySection
            enabled={proximityMode}
            onToggle={() => setProximityMode(!proximityMode)}
            term1={term1}
            term2={term2}
            distance={distance}
            onSearch={handleProximitySearch}
          />

          <Divider />

          {/* Browse Texts Button */}
          <button onClick={openTextSelection}>
            Browse Texts ({selectedTextsCount} selected)
          </button>
        </div>
      )}
    </div>
  );
}
```

### Search Input Component

```jsx
function SearchInput({ input, onUpdate, onRemove, showRemove }) {
  return (
    <div className="space-y-1.5">
      {/* Query input */}
      <input
        type="text"
        dir="rtl"
        value={input.query}
        onChange={(e) => onUpdate({ ...input, query: e.target.value })}
        placeholder="ابحث..."
        className="w-full h-9 px-3 rounded-md border border-app-border-medium
                 focus:outline-none focus:border-app-accent
                 text-right font-arabic text-lg"
      />

      {/* Mode selector + clitic toggle */}
      <div className="flex items-center gap-2">
        {/* Mode buttons: Surface | Lemma | Root */}
        <div className="flex gap-1 flex-1">
          {['surface', 'lemma', 'root'].map(mode => (
            <button
              key={mode}
              onClick={() => onUpdate({ ...input, mode })}
              className={`flex-1 h-7 rounded text-xs font-medium
                ${input.mode === mode
                  ? 'bg-app-accent text-white'
                  : 'bg-app-surface-variant hover:bg-app-accent-light'}`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

        {/* Clitic toggle (surface mode only) */}
        {input.mode === 'surface' && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={input.clitic}
              onChange={(e) => onUpdate({ ...input, clitic: e.target.checked })}
              className="w-4 h-4 rounded"
            />
            <span className="text-xs text-app-text-secondary">+clitics</span>
          </label>
        )}

        {/* Remove button */}
        {showRemove && (
          <button onClick={onRemove} className="text-app-text-tertiary hover:text-app-error">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
```

### Proximity Search Section

```jsx
function ProximitySection({ enabled, onToggle, term1, term2, distance, onSearch }) {
  return (
    <div className="space-y-2">
      <button
        onClick={onToggle}
        className={`w-full h-8 rounded text-sm font-medium
          ${enabled ? 'bg-app-accent text-white' : 'bg-app-surface-variant'}`}
      >
        Proximity Search
      </button>

      {enabled && (
        <div className="space-y-2 p-3 bg-app-surface-variant rounded-lg">
          {/* Term 1 */}
          <div className="flex gap-2">
            <input
              dir="rtl"
              value={term1.query}
              placeholder="Term 1"
              className="flex-1 h-8 px-2 rounded border text-right font-arabic"
            />
            <select value={term1.field} className="h-8 px-2 rounded border text-xs">
              <option value="surface">Surface</option>
              <option value="lemma">Lemma</option>
              <option value="root">Root</option>
            </select>
          </div>

          {/* Distance */}
          <div className="flex items-center justify-center gap-2">
            <span className="text-xs text-app-text-secondary">within</span>
            <input
              type="number"
              value={distance}
              min={1}
              max={100}
              className="w-16 h-7 px-2 rounded border text-center text-sm"
            />
            <span className="text-xs text-app-text-secondary">tokens of</span>
          </div>

          {/* Term 2 */}
          <div className="flex gap-2">
            <input
              dir="rtl"
              value={term2.query}
              placeholder="Term 2"
              className="flex-1 h-8 px-2 rounded border text-right font-arabic"
            />
            <select value={term2.field} className="h-8 px-2 rounded border text-xs">
              <option value="surface">Surface</option>
              <option value="lemma">Lemma</option>
              <option value="root">Root</option>
            </select>
          </div>

          <button
            onClick={onSearch}
            className="w-full h-8 bg-app-accent text-white rounded text-sm font-semibold"
          >
            Search Proximity
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Reader Panel

### Structure

```jsx
function ReaderPanel({ currentPage, tokens, matchedTokenIndices, onNavigate }) {
  const [selectedToken, setSelectedToken] = useState(null);
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });

  const matchedIndicesSet = useMemo(() => new Set(matchedTokenIndices), [matchedTokenIndices]);

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-20 border-b border-app-border-light px-8 flex items-center gap-4">
        <h2 dir="rtl" className="font-arabic text-2xl flex-1 truncate">
          {currentPage?.title || 'No text loaded'}
        </h2>
        {currentPage?.loadTimeMs && (
          <span className="text-xs text-app-text-tertiary">{currentPage.loadTimeMs}ms</span>
        )}
        {currentPage?.meta && (
          <span className="text-sm text-app-accent bg-app-accent-light px-3 py-1 rounded">
            {currentPage.meta}
          </span>
        )}
        <div className="flex gap-2">
          <button onClick={() => onNavigate(-1)}>← Prev</button>
          <button onClick={() => onNavigate(1)}>Next →</button>
        </div>
      </div>

      {/* Text Content */}
      <div className="flex-1 overflow-y-auto" onClick={handleClosePopup}>
        {!currentPage?.body ? (
          <EmptyState />
        ) : (
          <div className="max-w-4xl mx-auto px-16 py-12">
            <BodyRenderer
              body={currentPage.body}
              tokens={tokens}
              matchedIndicesSet={matchedIndicesSet}
              onWordClick={handleWordClick}
            />
          </div>
        )}
      </div>

      {/* Token Popup */}
      {selectedToken && (
        <TokenPopup
          token={selectedToken}
          position={popupPosition}
          onClose={() => setSelectedToken(null)}
        />
      )}
    </div>
  );
}
```

### Body Renderer (Display Text with Highlighting)

```jsx
function BodyRenderer({ body, tokens, matchedIndicesSet, onWordClick }) {
  const content = useMemo(() => {
    const plainText = stripHtml(body);
    if (!plainText.length) return null;

    // Build character → token index mapping
    const charToToken = buildCharToTokenMap(plainText);

    // Get highlight ranges for matched tokens
    const highlightRanges = getHighlightRanges(charToToken, matchedIndicesSet);
    const highlightedChars = new Set();
    highlightRanges.forEach(range => {
      for (let i = range.start; i < range.end; i++) highlightedChars.add(i);
    });

    // Build spans
    const elements = [];
    let i = 0;
    while (i < plainText.length) {
      const tokenIdx = charToToken[i];
      const isHighlighted = highlightedChars.has(i);

      // Find extent of current token
      let end = i + 1;
      if (tokenIdx !== null) {
        while (end < plainText.length && charToToken[end] === tokenIdx) end++;
      }

      const text = plainText.slice(i, end);

      if (tokenIdx !== null) {
        const token = tokens.find(t => t.idx === tokenIdx);
        elements.push(
          <span
            key={i}
            onClick={token ? (e) => onWordClick(e, token) : undefined}
            className={`cursor-pointer rounded px-0.5 transition-colors
              ${isHighlighted
                ? 'bg-red-100 text-red-700 font-semibold border-b-2 border-red-400'
                : 'hover:bg-app-accent-light'}`}
          >
            {text}
          </span>
        );
      } else {
        if (text === '\n') elements.push(<br key={i} />);
        else elements.push(text);
      }
      i = end;
    }
    return elements;
  }, [body, tokens, matchedIndicesSet, onWordClick]);

  return (
    <div dir="rtl" className="text-xl leading-loose font-arabic text-app-text-primary select-text">
      {content}
    </div>
  );
}
```

### Token Popup

```jsx
function TokenPopup({ token, position, onClose }) {
  const popupRef = useRef(null);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={popupRef}
      className="fixed bg-white border border-app-border-medium rounded-lg shadow-app-lg w-64 z-50"
      style={{ left: position.x, top: position.y + 10 }}
    >
      <div className="p-4">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-semibold">Token Information</h3>
          <button onClick={onClose} className="text-app-text-tertiary">×</button>
        </div>
        <hr className="my-2" />
        <InfoRow label="Surface" value={token.surface} rtl />
        <InfoRow label="Lemma" value={token.lemma} rtl />
        <InfoRow label="Root" value={token.root} rtl />
        <InfoRow label="POS" value={token.pos} />
        <InfoRow label="Features" value={token.features.join(', ')} small />
        <InfoRow label="Clitics" value={token.clitics.join(', ')} small />
      </div>
    </div>
  );
}
```

---

## Results Panel

### Structure (Virtualized)

```jsx
function ResultsPanel({ results, onResultClick, onLoadMore, loading, loadingMore }) {
  const parentRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: results?.results.length || 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,  // ROW_HEIGHT
    overscan: 5,
  });

  // Infinite scroll
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - scrollTop - clientHeight < 200 && !loadingMore) {
        onLoadMore();
      }
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadingMore, onLoadMore]);

  return (
    <div className="h-full flex flex-col bg-app-surface border-t-2 border-app-border-light">
      {/* Header */}
      <div className="h-10 bg-app-surface-variant px-6 flex items-center">
        <span className="text-xs font-semibold uppercase">Results</span>
        <div className="flex-1" />
        <span className="text-xs">
          {results?.total_hits.toLocaleString()} hits · {results?.elapsed_ms}ms
        </span>
      </div>

      {/* Column Headers */}
      <div className="sticky top-0 bg-white border-b h-8 px-6 flex items-center gap-6 z-10">
        <div className="w-16 text-center text-xs font-semibold text-app-text-secondary">Vol:Pg</div>
        <div className="flex-1 text-center text-xs font-semibold text-app-text-secondary">Context</div>
        <div className="w-48 text-right text-xs font-semibold text-app-text-secondary">Title</div>
      </div>

      {/* Virtualized Rows */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(virtualRow => {
            const result = results.results[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <ResultRow result={result} onClick={() => onResultClick(result)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

### Result Row

```jsx
function ResultRow({ result, onClick }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });

  // Build snippet with highlighting
  const snippetContent = useMemo(() => {
    const plainText = stripHtml(result.body || '');
    const charToToken = buildCharToTokenMap(plainText);
    const firstMatchIdx = result.matched_token_indices?.[0] ?? 0;
    const snippetRange = getSnippetRange(charToToken, firstMatchIdx, 10);
    const snippetText = plainText.slice(snippetRange.start, snippetRange.end);

    // Map and highlight
    const snippetCharToToken = buildCharToTokenMap(snippetText);
    const adjustedMatches = new Set(
      result.matched_token_indices
        .map(idx => idx - snippetRange.startToken)
        .filter(idx => idx >= 0)
    );
    const ranges = getHighlightRanges(snippetCharToToken, adjustedMatches);

    // Build highlighted elements
    const elements = [];
    let lastEnd = 0;
    for (const range of ranges) {
      if (range.start > lastEnd) elements.push(snippetText.slice(lastEnd, range.start));
      elements.push(
        <span key={range.start} className="bg-red-100 text-red-700 font-semibold px-0.5 rounded">
          {snippetText.slice(range.start, range.end)}
        </span>
      );
      lastEnd = range.end;
    }
    if (lastEnd < snippetText.length) elements.push(snippetText.slice(lastEnd));
    return elements;
  }, [result]);

  return (
    <>
      <div
        onClick={onClick}
        className="h-12 px-6 flex items-center gap-6 cursor-pointer
                 hover:bg-app-surface-variant transition-colors border-b border-app-border-light"
      >
        {/* Vol:Page */}
        <div className="w-16 text-sm text-app-text-primary text-center">
          {result.part_label}:{result.page_number}
        </div>

        {/* Context */}
        <div className="flex-1 min-w-0">
          <p dir="rtl" className="text-xl font-arabic text-right truncate leading-relaxed">
            {snippetContent}
          </p>
        </div>

        {/* Title */}
        <div
          className="w-48 min-w-0"
          onMouseEnter={(e) => {
            setShowTooltip(true);
            setTooltipPosition({ x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <p dir="rtl" className="text-xl font-arabic text-app-accent truncate text-right">
            {result.title}
          </p>
        </div>
      </div>

      {/* Metadata Tooltip */}
      {showTooltip && (
        <MetadataTooltip result={result} position={tooltipPosition} />
      )}
    </>
  );
}
```

### Metadata Tooltip

```jsx
function MetadataTooltip({ result, position }) {
  return (
    <div
      className="fixed bg-white border border-app-border-medium rounded-lg shadow-app-lg
                 p-4 space-y-2 w-80 z-50 pointer-events-none"
      style={{ left: position.x - 160, top: position.y - 170 }}
    >
      <TooltipRow label="Title" value={result.title} rtl />
      <TooltipRow label="Author" value={result.author} rtl />
      <TooltipRow label="Death" value={result.death_ah ? `${result.death_ah} AH` : undefined} />
      <TooltipRow label="Genre" value={result.genre} />
      <TooltipRow label="Corpus" value={result.corpus} />
    </div>
  );
}
```

---

## Draggable Splitter

```jsx
function DraggableSplitter({ ratio, onDrag }) {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const container = document.querySelector('.flex-1.flex.flex-col');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = (e.clientY - rect.top) / rect.height;
      if (newRatio > 0.2 && newRatio < 0.8) onDrag(newRatio);
    };

    const handleMouseUp = () => setIsDragging(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onDrag]);

  return (
    <div
      onMouseDown={() => setIsDragging(true)}
      className={`h-1.5 bg-app-border-light cursor-row-resize rounded-full
                hover:bg-app-accent transition-colors
                ${isDragging ? 'bg-app-accent' : ''}`}
    />
  );
}
```

**Persistence:**
```jsx
// In App.tsx
useEffect(() => {
  const saved = localStorage.getItem('splitterRatio');
  if (saved) setSplitterRatio(parseFloat(saved));
}, []);

useEffect(() => {
  localStorage.setItem('splitterRatio', splitterRatio.toString());
}, [splitterRatio]);
```

---

## Text Selection Modal

```jsx
function TextSelectionModal({ isOpen, onClose, selectedIds, onSelectionChange }) {
  const [books, setBooks] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [genreFilter, setGenreFilter] = useState('');

  // Load books on mount
  useEffect(() => {
    if (isOpen) loadBooks();
  }, [isOpen]);

  const filteredBooks = useMemo(() => {
    return books.filter(book => {
      const matchesSearch = !searchQuery ||
        book.title.includes(searchQuery) ||
        book.author?.includes(searchQuery);
      const matchesGenre = !genreFilter || book.genre === genreFilter;
      return matchesSearch && matchesGenre;
    });
  }, [books, searchQuery, genreFilter]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-[800px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b flex items-center gap-4">
          <h2 className="text-lg font-semibold">Select Texts</h2>
          <div className="flex-1" />
          <button onClick={onClose}>×</button>
        </div>

        {/* Filters */}
        <div className="p-4 border-b flex gap-4">
          <input
            type="text"
            dir="rtl"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search titles or authors..."
            className="flex-1 h-9 px-3 border rounded font-arabic"
          />
          <select
            value={genreFilter}
            onChange={(e) => setGenreFilter(e.target.value)}
            className="h-9 px-3 border rounded"
          >
            <option value="">All genres</option>
            {genres.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        {/* Book List (Virtualized) */}
        <div className="flex-1 overflow-auto p-4">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              onClick={() => toggleSelection(book.id)}
              className={`p-3 rounded cursor-pointer mb-2
                ${selectedIds.has(book.id)
                  ? 'bg-app-accent-light border border-app-accent'
                  : 'bg-app-surface-variant hover:bg-app-border-light'}`}
            >
              <p dir="rtl" className="font-arabic text-lg">{book.title}</p>
              <p dir="rtl" className="font-arabic text-sm text-app-text-secondary">
                {book.author} ({book.death_ah} AH)
              </p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex justify-between items-center">
          <span className="text-sm text-app-text-secondary">
            {selectedIds.size} texts selected
          </span>
          <div className="flex gap-2">
            <button onClick={() => clearSelection()}>Clear</button>
            <button onClick={onClose} className="bg-app-accent text-white px-4 py-2 rounded">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## State Management Pattern

**App.tsx manages all global state:**

```jsx
function App() {
  // Search state
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Current search terms (for position matching)
  const currentSearchTermsRef = useRef<SearchTermForPositions[]>([]);
  const isProximitySearchRef = useRef(false);

  // Page display state
  const [currentPage, setCurrentPage] = useState<PageState | null>(null);
  const [pageTokens, setPageTokens] = useState<Token[]>([]);
  const [matchedTokenIndices, setMatchedTokenIndices] = useState<number[]>([]);

  // Navigation state
  const [currentBookId, setCurrentBookId] = useState<number | null>(null);
  const [currentPartIndex, setCurrentPartIndex] = useState(0);
  const [currentPageId, setCurrentPageId] = useState(1);

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splitterRatio, setSplitterRatio] = useState(0.6);
  const [textSelectionModalOpen, setTextSelectionModalOpen] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [stats, setStats] = useState<AppStats | null>(null);

  // Handlers...
}
```

**No external state library** - React's useState and useMemo are sufficient for this application's complexity level.

---

## Performance Optimizations

### Virtualized Results List
- TanStack React Virtual handles 2000+ results smoothly
- Row height fixed at 48px for stable virtualization
- Overscan of 5 rows for smooth scrolling

### Memoization
```jsx
// Expensive computations memoized
const matchedIndicesSet = useMemo(() => new Set(matchedTokenIndices), [matchedTokenIndices]);
const snippetContent = useMemo(() => buildSnippet(result), [result]);
```

### Lazy Loading
- Tokens loaded on-demand when page is displayed
- Infinite scroll loads 250 results at a time
- Book list filtered client-side after initial load

---

## Accessibility

- **RTL support:** Arabic text uses `dir="rtl"` and right-alignment
- **Focus indicators:** All interactive elements have visible focus rings
- **Color contrast:** Text meets WCAG AA (4.5:1 ratio)
- **Text selection:** Native browser selection enabled (`select-text` class)

---

## Missing Features (Future)

- [ ] Dark mode
- [ ] Font size adjustment
- [ ] Search history
- [ ] Bookmarks/favorites
- [ ] Export results
- [ ] Side-by-side text comparison
- [ ] Multiple tabs

---

**End of UI Specification**
