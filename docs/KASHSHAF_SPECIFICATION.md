# Kashshaf Specification
## Medieval Arabic Text Research Environment

**Version:** 3.1
**Last Updated:** January 2026

---

## 1. System Purpose

Desktop application for linguistically precise search of medieval Arabic texts (≤1500 CE).

**Core capabilities:**
- Lemma/root/surface search with morphological precision
- Boolean queries (AND/OR combinations)
- Wildcard search with prefix/infix patterns
- Name search for Arabic personal names with pattern generation
- Exact proximity queries across morphological fields
- Concordance mode with KWIC display
- Transparent token-level morphological overlay (click any word)
- Period/author/genre filtering
- Search history with auto-save and reload
- Metadata browsing with text/author views
- Export to CSV/Excel (search results, metadata)
- **Online mode** for API-based usage without local corpus download
- Seamless switching between offline (local) and online (API) modes

**Not in scope:**
- LLM/AI features
- Multi-user/cloud deployment
- Text editing or annotation
- Syntactic parsing
- Web/mobile versions (desktop-only via Tauri)

---

## 2. Architecture

```
┌─────────────────────────────────────┐
│     UI Layer (React + TailwindCSS)  │  Search UI, results, text reader, token overlay
├─────────────────────────────────────┤
│         API Abstraction Layer       │  Switches between Offline/Online modes
├────────────────┬────────────────────┤
│  Offline Mode  │    Online Mode     │
│  (Tauri IPC)   │   (HTTP/REST)      │
├────────────────┼────────────────────┤
│ Local Tantivy  │  api.kashshaf.com  │
│ Local SQLite   │  Remote API        │
└────────────────┴────────────────────┘
     Local settings.db (both modes)
```

**Core principle:** API abstraction layer provides unified interface for both modes. Offline uses Tantivy + SQLite. Online uses REST API. Settings persist locally in both modes.

---

## 3. Operating Modes

Kashshaf supports two operating modes to accommodate users with different storage constraints.

### 3.1 Startup Flow

```
App Launch
    ↓
Check corpus exists (tantivy_index + corpus.db)?
    ↓
┌───YES───┐                    ┌───NO────┐
↓                              ↓
Offline Mode                   Check user_settings
(no mode selection)            ↓
                        ┌──────────────────┐
                        │skip_download_prompt│
                        │    = "true"?      │
                        └──────────────────┘
                              ↓
                    ┌───YES───┴───NO────┐
                    ↓                   ↓
             Check mode setting    Show Download Dialog
                    ↓                   ↓
              mode="online"?    ┌───────────────────┐
                    ↓           │ • "Download" (8.2GB)│
              Online Mode       │ • "Use Online"     │
                                │ □ Don't show again │
                                └───────────────────┘
                                        ↓
                            ┌──Download──┴──Online──┐
                            ↓                       ↓
                     Download corpus          Online Mode
                            ↓                 (save setting)
                     Offline Mode
```

### 3.2 Offline Mode

The default and preferred mode when corpus data is available locally.

**Characteristics:**
- Uses local Tantivy index for all search operations
- Uses local corpus.db for token retrieval
- Uses local settings.db for search history
- No network connection required after initial setup
- No "Online Mode" button visible in toolbar
- Best performance (<100ms typical search latency)

**Requirements:**
- `tantivy_index/` directory (~5.5 GB)
- `corpus.db` file (~2.75 GB)
- `settings.db` file (minimal, auto-created)

**Behavior:**
- Once corpus is downloaded, app always runs in Offline Mode
- No option to switch to Online Mode when corpus exists
- Mode selection is automatic and transparent to user

### 3.3 Online Mode

Alternative mode for users who cannot download the 8.2 GB corpus.

**Characteristics:**
- All search operations via `https://api.kashshaf.com`
- All page/token retrieval via REST API
- Books metadata loaded from `/books` endpoint
- Local settings.db still used for search history
- "Online Mode" indicator visible in toolbar
- Clicking toolbar indicator offers option to download corpus
- Requires active internet connection

**API Integration:**
- Search endpoints: `/search`, `/search/combined`, `/search/proximity`, `/search/name`, `/search/wildcard`
- Page endpoints: `/page`, `/page/tokens`, `/page/matches`
- Metadata: `/books`
- See [KASHSHAF_API_SPEC.md](KASHSHAF_API_SPEC.md) for complete API documentation

**Limitations:**
- Higher latency (network-dependent)
- Rate limited (10 req/sec, burst 30)
- Requires internet connectivity

### 3.4 Mode Persistence

**Storage:** `settings.db` (SQLite)

```sql
user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
```

**Settings Keys:**
| Key | Values | Description |
|-----|--------|-------------|
| `skip_download_prompt` | `"true"` / `"false"` | Skip download dialog on startup |
| `mode` | `"online"` | Operating mode when corpus not present |

**Rules:**
- `mode` setting only applies when corpus is not present
- Once corpus is downloaded, `mode` setting is ignored
- `skip_download_prompt` only affects first-launch behavior
- Settings persist across app restarts

### 3.5 Mode Switching

**Offline → Online:** Not possible. Once corpus exists, always offline.

**Online → Offline:** User clicks toolbar indicator, downloads corpus, app restarts in offline mode.

**Rationale:** Offline mode is always preferred for performance. Online mode exists only as a fallback for users with storage constraints.

---

## 4. Technology Stack

### Runtime (Deployed App)
- **Frontend:** React 18 + TailwindCSS + TanStack Virtual (virtualized lists)
- **Desktop:** Tauri 2.x (native, Rust-powered)
- **Backend:** Rust
- **Search:** Tantivy 0.25 (embedded, Rust-native)
- **Data:** SQLite via rusqlite (tokens + metadata + search history)
- **Export:** SheetJS (xlsx) for Excel export

### Data Preparation (Offline Only)
- **NLP:** Python + CAMeL Tools (BERTUnfactoredDisambiguator for Classical Arabic)
- **Pipeline:** One-time preprocessing, not shipped with app

### Platform
- **Desktop:** Native GUI (Windows, macOS, Linux via Tauri)
- **Dual-mode:** Offline-first with optional online API mode

---

## 4. Project Structure

```
kashshaf/
├── app/                              # Tauri application
│   ├── src/                          # React frontend (TypeScript)
│   │   ├── App.tsx                   # Main component, state management
│   │   ├── components/
│   │   │   ├── Sidebar.tsx           # Main search interface
│   │   │   ├── Toolbar.tsx           # App toolbar
│   │   │   ├── SearchTabs.tsx        # Tab-based search sessions
│   │   │   ├── ConcordanceSidebar.tsx
│   │   │   ├── modals/               # Modal dialogs
│   │   │   │   ├── TextSelectionModal.tsx
│   │   │   │   ├── SavedSearchesModal.tsx
│   │   │   │   ├── BooksModal.tsx
│   │   │   │   └── MetadataBrowser.tsx
│   │   │   ├── panels/               # Main content panels
│   │   │   │   ├── ReaderPanel.tsx   # Text display with token overlay
│   │   │   │   ├── ResultsPanel.tsx  # Virtualized search results
│   │   │   │   └── ConcordancePanel.tsx
│   │   │   ├── sidebar/              # Search panel sub-components
│   │   │   │   ├── BooleanSearchPanel.tsx
│   │   │   │   ├── ProximitySearchPanel.tsx
│   │   │   │   ├── CorpusSelector.tsx
│   │   │   │   └── SearchInputRow.tsx
│   │   │   ├── name-search/          # Name search components
│   │   │   │   ├── NameSearchForm.tsx
│   │   │   │   └── NameInputGroup.tsx
│   │   │   ├── ui/                   # Reusable UI components
│   │   │   │   ├── Toast.tsx
│   │   │   │   ├── Tooltip.tsx
│   │   │   │   ├── TokenPopup.tsx
│   │   │   │   └── DraggableSplitter.tsx
│   │   │   └── shared/               # Shared search components
│   │   │       ├── SearchResultRow.tsx
│   │   │       └── VirtualizedResultsList.tsx
│   │   ├── api/
│   │   │   ├── index.ts              # API factory and SearchAPI interface
│   │   │   ├── tauri.ts              # Tauri command bindings (offline)
│   │   │   ├── offline.ts            # OfflineAPI implementation (Tauri IPC)
│   │   │   └── online.ts             # OnlineAPI implementation (HTTP fetch)
│   │   ├── contexts/
│   │   │   ├── BooksContext.tsx      # Global books metadata cache
│   │   │   ├── OperatingModeContext.tsx # Online/Offline mode state
│   │   │   └── SearchTabsContext.tsx # Tab state management
│   │   ├── hooks/
│   │   │   ├── useSearch.ts          # Search logic hook
│   │   │   ├── useSearchTabs.ts      # Tab management hook
│   │   │   └── useReaderNavigation.ts
│   │   ├── types/
│   │   │   ├── index.ts              # Core type definitions
│   │   │   └── search.ts             # Search-specific types
│   │   ├── constants/
│   │   │   └── search.ts             # Search constants
│   │   └── utils/
│   │       ├── arabicTokenizer.ts    # Display text → token mapping
│   │       ├── namePatterns.ts       # Arabic name pattern generation
│   │       ├── wildcardValidation.ts # Wildcard query validation
│   │       └── exportData.ts         # CSV/Excel export utilities
│   │
│   └── src-tauri/                    # Rust backend
│       └── src/
│           ├── main.rs               # Tauri app + command registration
│           ├── lib.rs                # Library exports
│           ├── commands.rs           # All Tauri commands (API surface)
│           ├── search.rs             # Tantivy search engine
│           ├── cache.rs              # LRU token cache with SQLite loader
│           ├── tokens.rs             # Token and PageKey types
│           ├── state.rs              # AppState (search engine + cache)
│           └── error.rs              # Error types
│
├── data-processing/                  # Offline data preparation (Python)
│   └── scripts/
│       ├── process_batch.py          # CAMeL BERT processing
│       ├── build_sqlite_tokens.py    # Token deduplication → SQLite
│       ├── ingest_to_index.py        # Tantivy index builder
│       └── test_pipeline.py          # End-to-end pipeline testing
│
├── data/
│   ├── raw/texts/                    # OpenITI source JSON (immutable)
│   ├── processed/books/              # JSONL output from CAMeL processing
│   ├── tantivy_index/                # Full-text search index
│   └── corpus.db                     # SQLite token database
│
└── docs/                             # Specification documents
```

---

## 5. Data Model

### 5.1 Tantivy Index (~5.5 GB)

**Granularity:** One document per page

**Stored fields** (retrievable, displayed to user):
```
id            : u64     # Book ID
part_index    : u64     # Part array index (0, 1, 2...)
page_id       : u64     # Page ID from source
author_id     : u64     # Author identifier
corpus        : String  # "nusus", "shamela", etc.
author        : String  # Arabic author name
title         : String  # Arabic book title
death_ah      : u64     # Author death year (Hijri)
century_ah    : u64     # Century (calculated: death_ah / 100 + 1)
genre         : String  # "taṣawwuf", "fiqh", etc.
part_label    : String  # "Part 1", "Vol. 2", etc.
page_number   : String  # Manuscript page number
body          : String  # Full text with HTML + tashkeel (display only)
```

**Indexed fields** (searchable, not stored):
```
surface_text         : String  # Original word forms (normalized, no tashkeel)
lemma_text           : String  # Lemmatized forms from CAMeL
root_text            : String  # Arabic triconsonantal roots
noclitic_surface_text: String  # Surface without wa/fa/bi/li/ka proclitics
```

**All indexed fields use whitespace tokenizer** to ensure positions match token array indices exactly.

### 5.2 SQLite Database (~2.75 GB)

**Normalized lookup tables:**
```sql
roots        (id INTEGER PRIMARY KEY, root TEXT UNIQUE)
lemmas       (id INTEGER PRIMARY KEY, lemma TEXT UNIQUE)
pos_types    (id INTEGER PRIMARY KEY, pos TEXT UNIQUE)
feature_sets (id INTEGER PRIMARY KEY, features TEXT)  -- JSON array
clitic_sets  (id INTEGER PRIMARY KEY, clitics TEXT)   -- JSON array
```

**Token definitions (deduplicated):**
```sql
token_definitions (
    id INTEGER PRIMARY KEY,
    surface TEXT NOT NULL,
    lemma_id INTEGER REFERENCES lemmas(id),
    root_id INTEGER REFERENCES roots(id),
    pos_id INTEGER REFERENCES pos_types(id),
    feature_set_id INTEGER REFERENCES feature_sets(id),
    clitic_set_id INTEGER REFERENCES clitic_sets(id)
)
```

**Page token arrays:**
```sql
page_tokens (
    id INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    token_ids BLOB NOT NULL,  -- Binary packed u32 IDs (little-endian)
    PRIMARY KEY (id, part_index, page_id)
)
```

**Metadata tables:**
```sql
books (id, corpus, title, author_id, author, death_ah, century_ah, genre,
       page_count, token_count, original_id, date, paginated, tags, book_meta, author_meta)
pages (id, part_index, page_id, part_label, page_number, token_count)
```

**Search History table:**
```sql
saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_type TEXT NOT NULL,        -- 'boolean', 'proximity', 'name'
    query_data TEXT NOT NULL,         -- JSON serialized search parameters
    display_label TEXT,               -- Human-readable label
    book_filter_count INTEGER DEFAULT 0,
    book_ids TEXT,                    -- JSON array of filtered book IDs
    created_at TEXT NOT NULL,         -- ISO timestamp
    last_used_at TEXT NOT NULL        -- ISO timestamp (updated on load)
)
```

**User settings table (settings.db):**
```sql
user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
```

Settings keys:
- `skip_download_prompt`: `"true"` or `"false"` - skip download dialog on startup
- `mode`: `"online"` - operating mode when corpus not present

*Note: The `user_settings` table is stored in `settings.db`, not `corpus.db`, so it persists regardless of corpus download status.*

**Compression achieved:**
- 50M tokens × 80 bytes = 4 GB (if stored as full objects)
- After dedup: (500K unique × 80 bytes) + (50M IDs × 4 bytes) = 240 MB
- **94% compression ratio**

---

## 6. Search Modes

### 6.1 Surface Search
- Matches exact normalized word forms
- Example: `كتاب` matches `كتاب` but not `الكتاب` or `كتب`
- **Clitic toggle:** When enabled, also matches `والكتاب`, `فكتاب`, `بكتاب`, `لكتاب`, `ككتاب`
- **Wildcard support:** Enabled only in surface mode (see Section 7.4)

### 6.2 Lemma Search (default)
- Matches base forms + all inflections via CAMeL lemmatization
- Example: `كتاب` matches `كتب`, `كتابا`, `كتابين`, `الكتاب`, `والكتاب`
- Automatically ignores clitics and case endings

### 6.3 Root Search
- Matches all derivations from Arabic triconsonantal root
- Example: root `ك.ت.ب` matches `كتاب`, `كاتب`, `مكتوب`, `كتابة`, `مكتبة`
- Broadest search mode

---

## 7. Query Types

### 7.1 Boolean Queries (Combined Search)

**AND terms:** All must appear in page
**OR terms:** At least one must appear

```
UI: Multiple search inputs with AND/OR tabs
Backend: combined_search(and_terms, or_terms, filters, limit, offset)
```

### 7.2 Proximity Queries

**Syntax:** Two terms within N tokens of each other

**Same-field proximity:**
```
lemma:كتاب ~10 lemma:علم    # Both lemmas within 10 tokens
```

**Cross-field proximity (two-phase):**
```
root:عقل ~5 surface:الحقيقة  # Root within 5 tokens of surface form
```

### 7.3 Filters

```
book_ids: [338, 701, 1024]     # Specific books only
author_id: 1610
death_ah_min: 200
death_ah_max: 400
century_ah: 3
genre: "taṣawwuf"
corpus: "nusus"
```

### 7.4 Wildcard Search

**Surface mode only.** Supports `*` for prefix and infix matching.

**Validation rules:**
1. Only one `*` per search input
2. `*` cannot be at start of word (`*منصور` invalid)
3. Internal `*` requires 2+ characters before (`أح*مد` valid, `أ*مد` invalid)
4. Wildcard can appear in any word position in a phrase
5. Solo wildcard term is valid (`أب*` alone is fine)

**Examples:**
```
أب*         # Prefix: matches أبو, أبي, أبا, أب, etc.
أح*مد       # Infix: matches أحمد, أحامد, etc.
ابن ال*     # Phrase with wildcard: "ابن" followed by any word starting with "ال"
```

**Implementation:** Uses Tantivy regex queries (`.*` expansion)

### 7.5 Name Search

**Purpose:** Find Arabic personal names with their various forms and combinations.

**Name components:**
- **Kunya (كنية):** e.g., أبو منصور (max 2 per form)
- **Nasab (نسب):** e.g., معمر بن أحمد بن زياد (patronymic chain)
- **Nisba (نسبة):** e.g., الأصبهاني (unlimited)
- **Shuhra (شهرة):** Known-as designation

**Pattern generation:**
```typescript
interface NameFormData {
  kunyas: string[];           // Max 2
  nasab: string;              // "معمر بن أحمد بن زياد"
  nisbas: string[];           // Unlimited
  shuhra: string;             // Optional
  allowRareKunyaNisba: boolean;    // kunya + nisba only
  allowKunyaNasab: boolean;        // kunya + 1st nasab
  allowOneNasab: boolean;          // single nasab name
  allowOneNasabNisba: boolean;     // 1st nasab + nisba
  allowTwoNasab: boolean;          // 2-part nasab only
}
```

**Generated patterns include:**
- Kunya variants (أبو/أبا/أبي permutations)
- Full combinations (kunya + nasab + nisba)
- Partial combinations based on checkboxes
- Proclitic expansion (و/ف/ب/ل/ك prefixes)
- Shuhra patterns: `المعروف ب...`, `المشهور ب...`

**Multi-name search:** Up to 4 name forms can be searched simultaneously with OR logic.

---

## 8. Search Execution

### 8.1 Simple Search Flow
```
User query → normalize_arabic() → Tantivy query
  ↓
Tantivy index → matching page IDs + positions
  ↓
Fetch stored fields (body, metadata)
  ↓
Return SearchResults with matched_token_indices
```
**Performance:** <100ms

### 8.2 Combined Search Flow
```
and_terms + or_terms → build_boolean_query()
  ↓
Surface mode + clitic toggle? → expand_with_clitics()
  ↓
BooleanQuery: (and1 AND and2 AND ...) AND (or1 OR or2 OR ...)
  ↓
Execute Tantivy query → collect results
```

### 8.3 Cross-Field Proximity Flow

**Phase 1 - Candidate Retrieval (Tantivy):**
```
Query: field1:term1 AND field2:term2
Returns: All pages containing both terms
```

**Phase 2 - Token Verification (SQLite):**
```
For each candidate page:
  1. Load token_ids BLOB from page_tokens table
  2. Unpack binary array to Vec<u32>
  3. Lookup token definitions (cached in memory)
  4. Find positions where field1 matches term1
  5. Find positions where field2 matches term2
  6. Calculate: min(abs(idx1 - idx2)) for all pairs
  7. Keep if distance ≤ threshold
```

**Why two phases?**
- Tantivy cannot measure distance across different indexed fields
- Token array in SQLite provides unified position space (idx)
- Guarantees linguistically accurate results

**Performance:** <500ms (varies with candidates)

### 8.4 Wildcard Search Flow
```
Validate query (wildcardValidation.ts)
  ↓
Parse wildcard position and type (prefix/infix)
  ↓
Convert to Tantivy regex: أب* → أب.*
  ↓
Execute regex query on surface_text field
  ↓
Return SearchResults
```

### 8.5 Name Search Flow
```
Generate patterns from form data (namePatterns.ts)
  ↓
Expand with proclitics (و/ف/ب/ل/ك)
  ↓
Build OR query across all patterns
  ↓
Execute phrase queries in Tantivy
  ↓
Return SearchResults
```

---

## 9. Token Overlay

**User interaction:** Click any word in text display

**Display:**
```
Surface:  والعقل
Lemma:    عقل
Root:     عقل
POS:      NOUN
Features: MASC, SG, DEF
Clitics:  wa, al
```

**Implementation:**
```
Click event → identify character position
  ↓
Build char-to-token mapping (arabicTokenizer.ts)
  ↓
Map position → token_idx
  ↓
Check token cache for page
  ↓
If not cached:
  1. Query SQLite: get token_ids BLOB
  2. Unpack + lookup definitions
  3. Cache Vec<Token>
  ↓
Extract token at idx → display popup
```

**Performance:** <50ms (cached), <60ms (first load)

---

## 10. Data Pipeline (Offline)

**Executed once during data preparation, not part of runtime app.**

### Stage 1: Source Data (OpenITI JSON)
- **Location:** `data/raw/texts/*.json`
- **Format:** Book-level with parts[] → pages[] structure
- **Content:** Original text with HTML tags and tashkeel

### Stage 2: CAMeL Processing (`process_batch.py`)
```python
For each page:
  1. preprocess_for_camel(body):
     - clean_html()
     - strip_punct()
     - strip_latin()
     - strip_digits()
     - normalize_unicode()
     - normalize_alef()
     - normalize_alef_maksura()

  2. tokenize_arabic(text):
     - Walk character by character
     - Arabic letters → accumulate word
     - Tashkeel → skip (part of word but stripped)
     - Non-Arabic → word boundary

  3. BERTUnfactoredDisambiguator.disambiguate(tokens):
     - Returns morphological analysis per token

  4. Extract: surface, lemma, root, pos, features, clitics
```

**Output:** JSONL files in `data/processed/books/{book_id}.jsonl`

### Stage 3: Build SQLite (`build_sqlite_tokens.py`)
```
Pass 1: Scan all JSONL, collect unique token definitions
Pass 2: Insert deduplicated tokens + page token arrays
```

### Stage 4: Build Tantivy Index (`ingest_to_index.py`)
```
For each page in JSONL:
  1. Index: surface_text, lemma_text, root_text (whitespace tokenizer)
  2. Store: body, metadata fields
  3. Do NOT store tokens (they're in SQLite)
```

---

## 11. Frontend Architecture

### State Management
React Context + hooks pattern (no Redux/Zustand):

**BooksContext:** Global cache of all book metadata loaded at startup
**SearchTabsContext:** Tab-based search session management

```typescript
// Tab state (per search session)
interface TabState {
  id: string;
  searchMode: 'boolean' | 'proximity';
  andInputs: SearchInput[];
  orInputs: SearchInput[];
  proximityQuery: ProximitySearchQuery | null;
  results: SearchResults | null;
  loading: boolean;
}

// App-level state
appSearchMode: 'terms' | 'names' | 'concordance'
selectedBookIds: Set<number>
splitterRatio: number  // Persisted to localStorage
```

**OperatingModeContext:** Manages online/offline mode state

```typescript
interface OperatingModeState {
  mode: 'online' | 'offline';
  corpusExists: boolean;
  isLoading: boolean;
}
```

### API Abstraction Layer

The API abstraction layer provides a unified interface for both operating modes. Components use the same API regardless of whether the app is online or offline.

**Interface Definition (`api/index.ts`):**
```typescript
interface SearchAPI {
  // Search operations
  search(query: string, mode: string, filters: SearchFilters, limit: number, offset: number): Promise<SearchResults>;
  combinedSearch(andTerms: SearchTerm[], orTerms: SearchTerm[], filters: SearchFilters, limit: number, offset: number): Promise<SearchResults>;
  proximitySearch(term1: SearchTerm, term2: SearchTerm, distance: number, filters: SearchFilters, limit: number, offset: number): Promise<SearchResults>;
  nameSearch(forms: NameForm[], filters: SearchFilters, limit: number, offset: number): Promise<SearchResults>;
  wildcardSearch(query: string, filters: SearchFilters, limit: number, offset: number): Promise<SearchResults>;

  // Page operations
  getPage(id: number, partIndex: number, pageId: number): Promise<SearchResult | null>;
  getPageTokens(id: number, partIndex: number, pageId: number): Promise<Token[]>;
  getMatchPositions(id: number, partIndex: number, pageId: number, query: string, mode: string): Promise<number[]>;
  getMatchPositionsCombined(id: number, partIndex: number, pageId: number, terms: SearchTerm[]): Promise<number[]>;

  // Metadata
  getAllBooks(): Promise<BookMetadata[]>;
}
```

**Implementations:**
- `OfflineAPI` (`api/offline.ts`): Uses Tauri `invoke()` commands to call Rust backend
- `OnlineAPI` (`api/online.ts`): Uses `fetch()` to call `https://api.kashshaf.com`

**Factory Pattern:**
```typescript
// api/index.ts
export function createAPI(mode: 'online' | 'offline'): SearchAPI {
  return mode === 'online' ? new OnlineAPI() : new OfflineAPI();
}
```

**Usage in Components:**
```typescript
const { api } = useOperatingMode();
const results = await api.search(query, mode, filters, limit, offset);
```

### Key Components

**Sidebar.tsx:**
- Mode tabs: Terms, Names, Concordance
- Boolean search interface (AND/OR tabs)
- Multiple search inputs with add/remove
- Mode selector (Surface/Lemma/Root)
- Clitic toggle (surface mode only)
- Wildcard validation feedback
- Filter controls
- Proximity search section

**NameSearchForm.tsx:**
- Kunya input (up to 2)
- Nasab input with بن/بنت parsing
- Nisba inputs (unlimited)
- Shuhra input
- Pattern generation checkboxes
- Pattern preview panel

**ResultsPanel.tsx:**
- Virtualized list (TanStack React Virtual)
- Displays: vol/page, context snippet with highlighting, title
- Metadata tooltip on hover
- Infinite scroll pagination
- Export dropdown (CSV/Excel)

**ConcordancePanel.tsx:**
- KWIC display format
- Virtualized concordance lines
- Export to CSV

**ReaderPanel.tsx:**
- Renders body text with tashkeel preserved
- Character-to-token mapping for highlighting
- Click word → token popup with morphological info
- Prev/Next page navigation

**MetadataBrowser.tsx:**
- Text Browser: filterable list of all texts
- Author Browser: aggregated author view with book counts
- Detail views for individual texts
- Export metadata to CSV/Excel

**SavedSearchesModal.tsx:**
- Lists search history by type (boolean/proximity/name)
- Shows book filter count and last used time
- Click to reload search
- Delete searches

### Display-to-Token Mapping (`arabicTokenizer.ts`)

**Core principle:** Token indices are semantic positions (Nth Arabic word), matching Python pipeline exactly.

**Preprocessing must match Python:**
```typescript
// Skip during token counting (same as Python strips):
shouldSkipForTokenCounting(char):
  - PUNCT_SYMBOLS (matching UNICODE_PUNCT_SYMBOLS)
  - Latin letters (A-Za-z, U+00C0-U+024F, U+1E00-U+1EFF)
  - Digits (0-9, Arabic-Indic ٠-٩)

buildCharToTokenMap(text):
  For each character:
    - Skip punctuation/Latin/digits (don't affect token count)
    - Arabic letter → map to currentTokenIdx
    - Tashkil → map to currentTokenIdx (part of word)
    - Whitespace → word boundary, increment tokenIdx
```

**Usage:**
```typescript
// Search highlighting
const charToToken = buildCharToTokenMap(stripHtml(body))
const highlights = getHighlightRanges(charToToken, matchedIndicesSet)

// Token click
const tokenIdx = charToToken[clickPosition]
const token = tokens.find(t => t.idx === tokenIdx)
```

---

## 12. Backend API (Tauri Commands)

All commands defined in `src-tauri/src/commands.rs`:

### Search Commands
```rust
search(query, mode, filters, limit, offset) → SearchResults
combined_search(and_terms, or_terms, filters, limit, offset) → SearchResults
proximity_search(term1, field1, term2, field2, distance, filters, limit, offset) → SearchResults
wildcard_search(query, filters, limit, offset) → SearchResults
name_search(forms, filters, limit, offset) → SearchResults
concordance_search(query, mode, ignore_clitics, filters, limit, offset) → SearchResults
```

### Page Access
```rust
get_page(id, part_index, page_id) → Option<SearchResult>
get_page_tokens(id, part_index, page_id) → Vec<Token>
get_page_with_matches(id, part_index, page_id, query, mode) → Option<PageWithMatches>
get_match_positions(id, part_index, page_id, query, mode) → Vec<u32>
get_match_positions_combined(id, part_index, page_id, terms) → Vec<u32>
get_name_match_positions(id, part_index, page_id, patterns) → Vec<u32>
```

### Metadata
```rust
get_all_books() → Vec<BookMetadata>
list_books(genre, corpus, century_ah, limit, offset) → Vec<BookMetadata>
list_books_filtered(death_ah_min, death_ah_max, genres, author_search, limit, offset) → Vec<BookMetadata>
search_authors(query) → Vec<(author, death_ah, book_count)>
get_book(id) → BookMetadata
get_genres() → Vec<(genre, count)>
get_centuries() → Vec<(century_ah, count)>
get_stats() → AppStats
```

### Search History
```rust
save_search(search_type, query_data, display_label, book_filter_count, book_ids) → i64
list_saved_searches(limit) → Vec<SavedSearch>
load_search(id) → Option<SavedSearch>  // Also updates last_used_at
delete_search(id) → ()
```

### Caching
```rust
get_cache_stats() → (current_size, capacity)
clear_token_cache()
```

### Export
```rust
export_concordance(query, mode, ignore_clitics, filters, max_results) → String  // File path
```

### User Settings (Online Mode Support)
```rust
get_user_setting(key: String) → Result<Option<String>, KashshafError>
set_user_setting(key: String, value: String) → Result<(), KashshafError>
corpus_exists() → Result<bool, KashshafError>
```

These commands support the operating mode system:
- `get_user_setting`: Retrieves a value from the `user_settings` table
- `set_user_setting`: Stores a key-value pair in the `user_settings` table
- `corpus_exists`: Checks if both `tantivy_index/` and `corpus.db` exist

---

## 13. Key Data Structures

### Token
```typescript
interface Token {
  idx: number;              // Position in token array
  surface: string;          // Normalized form (no tashkeel)
  noclitic_surface?: string; // Without proclitics
  lemma: string;            // Base form from CAMeL
  root?: string;            // Triconsonantal root
  pos: string;              // Part of speech
  features: string[];       // [MASC, SG, NOMINATIVE, ...]
  clitics: string[];        // [wa, al, ...] proclitics/suffixes
}
```

### SearchResult
```typescript
interface SearchResult {
  id: number;
  part_index: number;
  page_id: number;
  author_id?: number;
  corpus: string;
  author: string;
  title: string;
  death_ah?: number;
  century_ah?: number;
  genre?: string;
  part_label: string;
  page_number: string;
  body?: string;           // Only in get_page, not search results
  score: number;
  matched_token_indices: number[];
}
```

### SearchResults
```typescript
interface SearchResults {
  query: string;
  mode: 'surface' | 'lemma' | 'root';
  total_hits: number;
  results: SearchResult[];
  elapsed_ms: number;
}
```

### SavedSearch
```typescript
interface SavedSearch {
  id: number;
  search_type: 'boolean' | 'proximity' | 'name';
  query_data: string;        // JSON serialized parameters
  display_label?: string;
  book_filter_count: number;
  book_ids?: string;         // JSON array
  created_at: string;        // ISO timestamp
  last_used_at: string;      // ISO timestamp
}
```

### NameFormData
```typescript
interface NameFormData {
  id: string;
  kunyas: string[];
  nasab: string;
  nisbas: string[];
  shuhra: string;
  allowRareKunyaNisba: boolean;
  allowKunyaNasab: boolean;
  allowOneNasab: boolean;
  allowOneNasabNisba: boolean;
  allowTwoNasab: boolean;
}
```

### PageKey (Rust)
```rust
pub struct PageKey {
    pub id: u64,
    pub part_index: u64,
    pub page_id: u64,
}
```

---

## 14. Caching System

### Token Cache (Rust LRU)
```rust
TokenCache {
    cache: LruCache<PageKey, Arc<Vec<Token>>>,
    capacity: 1000 pages,
    db_path: PathBuf,
    lookup_tables: {
        lemmas: HashMap<i64, String>,
        roots: HashMap<i64, String>,
        pos_types: HashMap<i64, String>,
        feature_sets: HashMap<i64, Vec<String>>,
        clitic_sets: HashMap<i64, Vec<String>>,
    }
}
```

**Load process:**
1. Check cache for PageKey
2. If miss: query SQLite, unpack blob, lookup definitions
3. Cache result with Arc for shared ownership
4. Return Arc<Vec<Token>>

**Performance:**
- Cache hit: <1ms
- Cache miss: 5-15ms

### Books Cache (Frontend)
- Loaded at app startup via `get_all_books()`
- Stored in BooksContext
- Eliminates repeated metadata queries

---

## 15. Export System

### Search Results Export
- **Formats:** CSV, Excel (xlsx)
- **Fields:** Book ID, Title, Author, Death Year, Century, Genre, Volume, Page, Score, Context
- **Limit:** Configurable max results (default 10,000)

### Metadata Export
- **Texts:** All book metadata with filtering
- **Authors:** Aggregated author data with book counts
- **Formats:** CSV, Excel (xlsx)

### Concordance Export
- Backend-generated CSV for large result sets
- Includes KWIC context

### Implementation
- Frontend uses SheetJS (xlsx) for Excel generation
- UTF-8 BOM for Arabic text compatibility
- Native file save dialog via Tauri

---

## 16. Storage Requirements

| Component | Size | Notes |
|-----------|------|-------|
| Tantivy Index | ~5.5 GB | Stored + inverted indexes |
| SQLite Databases | ~2.75 GB | Tokens + metadata + search history |
| **Total Deployed** | **~12.3 GB** | Shipped with app |
| Processed JSONLs | 10-15 GB | Optional, for rebuilding |
| Raw OpenITI | 5.8 GB | Development only |

---

## 17. Performance Targets

### Offline Mode
| Operation | Target | Method |
|-----------|--------|--------|
| Simple search | <100ms | Tantivy index lookup |
| Combined search | <150ms | Boolean query |
| Wildcard search | <500ms | Regex query |
| Name search | <300ms | Multi-pattern OR query |
| Cross-field proximity | <800ms | Two-phase (Tantivy + SQLite) |
| Token overlay (cached) | <50ms | Memory lookup |
| Token overlay (uncached) | <60ms | SQLite query |
| Page load | <200ms | Tantivy stored fields |
| App startup | <3s | Index mmap + load books |
| Export 10K results | <5s | Parallel fetch + serialize |

### Online Mode
| Operation | Target | Notes |
|-----------|--------|-------|
| Simple search | <500ms | Network + API processing |
| Combined search | <600ms | Network + API processing |
| Wildcard search | <800ms | Network + regex query |
| Name search | <700ms | Network + multi-pattern |
| Page/token fetch | <400ms | Network + data retrieval |
| App startup | <2s | No index loading, fetch books |

*Online mode performance is network-dependent. Targets assume typical broadband connection.*

---

## 18. Design Principles

1. **Body is source of truth for display** - Tantivy `body` field preserves original text with tashkeel and HTML
2. **Token positions match across layers** - Whitespace tokenizer ensures Tantivy positions = array indices
3. **Preprocessing consistency** - TypeScript tokenizer mirrors Python exactly for highlighting
4. **Tantivy for search, SQLite for tokens** - Right tool for each job
5. **Offline-first with online fallback** - Local data preferred, API available for users without storage
6. **Desktop-optimized** - Native performance via Tauri
7. **Linguistically precise** - NLP accuracy over fuzzy matching
8. **Search history persistence** - Auto-save searches for reproducibility
9. **Export-friendly** - Support research workflows with CSV/Excel export
10. **Mode transparency** - API abstraction layer ensures consistent UX regardless of operating mode

---

## 19. Completion Status

### Core Search (V1)
- [x] Lemma search is correct and fast (<100ms)
- [x] Root search works
- [x] Surface search with clitic expansion
- [x] Boolean queries (AND/OR)
- [x] Cross-field proximity is exact (<500ms)
- [x] Token overlay on click (<60ms)
- [x] Period/author/genre filtering
- [x] Text display with tashkeel preserved
- [x] Token cache with SQLite backend
- [x] Virtualized results list
- [x] Infinite scroll pagination

### Advanced Features (V2)
- [x] Wildcard search (prefix/infix patterns)
- [x] Name search with pattern generation
- [x] Concordance mode with KWIC display
- [x] Tab-based search sessions
- [x] Saved search persistence
- [x] Search reload from history
- [x] Metadata browser (texts + authors)
- [x] Export to CSV/Excel

### UI/UX (V2)
- [x] Refactored component architecture
- [x] Books context for metadata caching
- [x] Wildcard validation feedback
- [x] Pattern preview for name search
- [x] Toolbar with quick actions

### Online Mode (V2)
- [x] Online mode (API-based usage without local corpus)
- [x] Mode selection dialog on first launch
- [x] API abstraction layer for seamless mode switching
- [x] OperatingModeContext for mode state management
- [x] Toolbar indicator for online mode
- [x] User settings persistence (skip_download_prompt, mode)

---

**End of Specification**
