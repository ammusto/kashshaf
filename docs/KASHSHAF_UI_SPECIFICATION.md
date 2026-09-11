# Kashshaf UI Specification
## Premodern Arabic Text Research Environment — Interface Design

**Version:** 3.0
**Last Updated:** September 2026
**App version described:** 0.4.1

This document describes the interface as implemented in `src/` at v0.4.1. It replaces the v2.0 UI specification (December 2025), whose JSX sketches no longer matched the components. Where a component's behaviour is surprising or inconsistent, that is recorded in §16 rather than smoothed over. System behaviour (search semantics, data model, backend) lives in [KASHSHAF_SPECIFICATION.md](KASHSHAF_SPECIFICATION.md).

---

## 1. Technology Stack

| Layer | Technology |
|---|---|
| Framework | React 18.3 + TypeScript 5.6, Vite 6 |
| Styling | Tailwind CSS **4.1** via `@tailwindcss/postcss`; tokens in `@theme` in `src/styles/index.css`; no `tailwind.config.js` |
| Virtualization | `@tanstack/react-virtual` 3 (results list, book lists, metadata tables) |
| State | React hooks + three contexts (`OperatingMode`, `SearchTabs`, `Books`); no external store |
| Desktop shell | Tauri 2 (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) |
| Web build | `VITE_TARGET=web`; Tauri imports aliased to `src/stubs/*`; `isWebTarget()` gates desktop-only UI |
| Window | Title `al-Kashshāf`, default 1200×800, resizable |

---

## 2. Design Tokens (`src/styles/index.css`)

```css
@import "tailwindcss";
@source "../";            /* scoped to src/ so Tailwind never scans data/ */

@theme {
  --color-app-bg:               #FAFAFA;
  --color-app-surface:          #FFFFFF;
  --color-app-surface-variant:  #F5F5F5;
  --color-app-text-primary:     #1A1A1A;
  --color-app-text-secondary:   #666666;
  --color-app-text-tertiary:    #999999;
  --color-app-accent:           #2C5F8D;
  --color-app-accent-hover:     #1E4A6F;
  --color-app-accent-light:     #E8F1F8;
  --color-app-highlight-surface:#FFF4CC;   /* defined, unused */
  --color-app-highlight-lemma:  #D4EDDA;   /* defined, unused */
  --color-app-highlight-root:   #E0E7FF;   /* defined, unused */
  --color-app-border-light:     #E0E0E0;
  --color-app-border-medium:    #CCCCCC;
  --color-app-border-focus:     #2C5F8D;   /* defined, unused */
  --color-app-success:          #28A745;   /* unused; components use green-600 */
  --color-app-warning:          #FFC107;   /* unused; components use amber/yellow */
  --color-app-error:            #DC3545;

  --font-arabic: 'Scheherazade New', 'Amiri', 'Noto Naskh Arabic', sans-serif;
  --font-ui:     'Inter', system-ui, -apple-system, sans-serif;

  --shadow-app-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-app-md: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-app-lg: 0 4px 16px rgba(0,0,0,0.12);
}
```

**Fonts.** Scheherazade New is bundled from `public/fonts/` in four weights (Regular 400, Medium 500, SemiBold 600, Bold 700, `font-display: swap`). Amiri and Inter are loaded from Google Fonts in `index.html`. `body` uses the Inter stack directly; the `font-ui` utility is never used.

**Sizes.** Root `16px`; no custom size tokens. Arabic content uses stock Tailwind sizes: `text-lg` (18px) in inputs and result titles, `text-xl` (20px) in the reader body and snippets, `text-2xl` (24px) in metadata rows, `text-4xl` (36px) for book detail titles. Reader line height is `leading-loose` (2.0).

**Highlight.** Matched tokens in the reader: `bg-red-100 text-red-700 font-semibold border-b-2 border-red-400`. In result snippets: the same without the underline. There is **no per-mode colour**; the three `highlight-*` tokens are dead.

**Semantic colours in use outside tokens.** Red (`red-50/100/500/600/700`) for errors, delete, highlights; green (`green-600/700`) for save-collection; amber (`amber-100/200/800`) for the Online Mode button; yellow (`yellow-50/200/800`) for warnings; blue (`blue-100/700`) for the web version badge and Boolean badge; purple (`purple-100/700`) Proximity badge; orange (`orange-100/700`) Wildcard badge; gray (`gray-200/300/600`) inactive tabs.

**Missing token.** `bg-app-accent-dark` / `hover:bg-app-accent-dark` is used in 9 files but `--color-app-accent-dark` is not defined, so those hover states do nothing. The defined hover token is `app-accent-hover` (used only by the four Search buttons).

**Scrollbars.** WebKit only: 8px, track `#F5F5F5`, thumb `#CCCCCC` (hover `#999999`), radius 4px.

**RTL.** No global `dir`. Arabic elements set `dir="rtl"` (or `dir="auto"`) and `text-right` individually. Chrome (sidebar left, toolbar order, checkboxes) is LTR. The `.arabic` class (`line-height: 2; direction: rtl`) is used only on result snippets.

**No dark mode**, no animations beyond `transition-colors`, `animate-spin`, and the Toast slide.

---

## 3. Application Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ UpdateBanner (desktop, only when an optional corpus update is available)     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Toolbar h-10  [≡ Menu] [Browse Texts] [History] [Saved] [Collections] [Help] │
│                                                    …  [Online Mode] [Web vX] │
├──────────┬───────────────────────────────────────────────────────────────────┤
│          │ p-4                                                               │
│ Sidebar  │ [tab][tab][tab]                      ← SearchTabs (hidden if 0)   │
│ 400–700  │ ┌───────────────────────────────────────────────────────────────┐ │
│ px, or   │ │ ReaderPanel            flex: splitterRatio (default 0.6)      │ │
│ 56px     │ │ [Cite] Title - Author   12ms  [vol]:[page][Go]  [← Prev][Next →]│ │
│ collapsed│ │ ─────────────────────────────────────────────────────────────  │ │
│          │ │  Arabic body, tashkil preserved, RTL, click word → TokenPopup  │ │
│ Terms /  │ └───────────────────────────────────────────────────────────────┘ │
│ Names    │ ═══════════════ DraggableSplitter (row resize, 0.2–0.8) ═══════   │
│          │ ┌───────────────────────────────────────────────────────────────┐ │
│ Boolean/ │ │ ResultsPanel           flex: 1 − splitterRatio                │ │
│ Proximity│ │ Results  [Variants] [Export (n)]        250 / 12,345 · 45ms   │ │
│          │ │ VOL:PG │            CONTEXT                    │    TITLE      │ │
│ Corpus   │ │  1:150 │ …والعقل الأول هو…                     │ كتاب العلم    │ │
│          │ └───────────────────────────────────────────────────────────────┘ │
└──────────┴───────────────────────────────────────────────────────────────────┘
```

- Root: `div.h-screen.w-screen.flex.flex-col.bg-app-bg.overflow-hidden`.
- When **Help** is active, the whole tabs/reader/results column is unmounted and `HelpPanel` fills it.
- Reader wrapper: `rounded-b-xl shadow-app-md bg-white mb-3` (square top so it joins the tab bar). Results wrapper: `rounded-xl shadow-app-md`.
- Splitter: `h-1.5 cursor-row-resize` with a 12×4 grab pill; commits only when the new ratio is strictly between 0.2 and 0.8; persisted to `localStorage.splitterRatio`.
- Sidebar open width persisted to `localStorage.sidebarWidth`, clamped to `[400, 700]` (`SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`); collapsed width `w-14`.

**Pre-layout screens**
- Loading: full-screen spinner with "Loading..." (mode resolving) or "Checking corpus data...".
- Download: when the desktop app has no usable corpus, `DownloadModal` **replaces the entire app** (lazy-loaded).

---

## 4. Toolbar (`Toolbar.tsx`)

Single 40px row, `bg-white border-b`. Buttons share `px-3 py-1.5 rounded-md text-sm font-medium bg-app-surface-variant hover:bg-app-accent-light` with a 16px stroke icon.

| # | Label | Action | Visible |
|---|---|---|---|
| 1 | **Menu** (hamburger) | Native Tauri popup menu at the button: Settings (no-op), Check for Updates, Delete Local Data, Quit | desktop |
| 2 | **Browse Texts** | Opens MetadataBrowser | always |
| 3 | **History** | Opens SearchHistoryModal | always |
| 4 | **Saved** | Opens SavedSearchesModal | always |
| 5 | **Collections** | Opens CollectionsModal | always |
| 6 | **Help** | Toggles HelpPanel; active state `bg-app-accent text-white` | always |
| 7 | **Online Mode** (globe, amber) | Fetches corpus status and opens DownloadModal; tooltip "Currently using online mode. Click to download corpus for offline use." | desktop online mode |
| 8 | `Web v0.4.1` badge (`bg-blue-100 text-blue-700`) | none | web |

The toolbar also owns the desktop update flow: `checkAppUpdate()` on mount; required update → blocking `AppUpdateModal`; optional → modal unless `skip_app_update_prompt` is `"true"`. Native menu `check-for-updates` resets that flag and shows an "Up to Date" modal ("You're running the latest version of Kashshaf (v0.4.1).") when nothing is newer. Native menu `delete-local-data` opens `DeleteDataModal`.

There is no offline indicator, no stats readout, and no settings screen.

---

## 5. Search Tabs (`SearchTabs.tsx`)

- One tab is created per executed search; there is no "+" button, no rename, and no maximum.
- Tab: `px-3 py-1.5 rounded-t-lg text-sm`, `minWidth 60px`, `maxWidth 200px`. Active `bg-white shadow-sm font-medium`; inactive `bg-gray-200 text-gray-600`. Label is RTL, truncated, with the full label as `title`.
- Close ×: `hover:bg-red-100 hover:text-red-600`; closing the active tab activates the tab to its left; closing the last tab empties reader and results.
- Overflow: when tabs exceed the container, ‹ › chevrons appear and scroll ±150px.
- Labels: boolean → first AND term (else first OR term, else "Search"); proximity → `term1 ~ term2`; name → kunya + nasab + nisba of the first form, truncated to 40 chars.
- No keyboard shortcuts.

---

## 6. Sidebar (`Sidebar.tsx`, `sidebar/`, `name-search/`)

### 6.1 Header
`[ Terms ][ Names ] [‹]` — two equal `flex-1` buttons (active `bg-app-accent text-white shadow-sm`) and a collapse button ("Collapse sidebar"). Collapsed state shows a single › button ("Open sidebar").

Under **Terms**, a second row toggles **Boolean** / **Proximity**.

### 6.2 Boolean search (`BooleanSearchPanel`)

```
SEARCH                                   Clear form
[ AND ][ OR ]                 ← independent input lists per tab
┌─────────────────────────────────────────────────┐
│ [x]                              ...ابحث         │  ← SearchInputRow
│ [Surface][Lemma][Root]   □ Ignore clitics       │
└─────────────────────────────────────────────────┘
[ + Add search term ]                    (hidden at 3)
[            Search / Searching...             ]
```

- 1–3 inputs per tab; remove button only when >1.
- `SearchInputRow`: RTL input `h-10 text-lg font-arabic` placeholder `ابحث...`; mode buttons `h-8 text-xs` (active `bg-app-accent text-white`); "Ignore clitics" checkbox disabled unless mode is Surface (its checked value is not reset when the mode changes).
- **Clear form** resets both lists to a single empty surface input and returns to the AND tab.
- Search button `h-11 bg-app-accent hover:bg-app-accent-hover`, disabled when loading or no non-blank query; label toggles to "Searching...".
- Enter anywhere in the panel triggers search.
- Wildcard validation runs on Search and reports through the Toast (§12): "Only one wildcard (*) allowed per search term", "Wildcards only supported in Surface mode", "Wildcard cannot be at start of word". There is no inline per-row feedback. (The former "Internal wildcard requires at least 2 characters before it" rule was removed on 2026-09-11 in both `utils/wildcardValidation.ts` and the Rust validator; the Help panel's "Wildcard Rules" bullet now says any prefix length is fine and that phrase counts may be shown as a lower bound.)

### 6.3 Proximity search (`ProximitySearchPanel`, `ProximityInputRow`)

```
SEARCH                                   Clear form
Term 1  [ ...ابحث ]   [Surface][Lemma][Root]
──────── within [ 10 ] tokens ────────
Term 2  [ ...ابحث ]   [Surface][Lemma][Root]
[            Search / Searching...             ]
```
Distance is a number input, min 1, max 100, default 10, clamped on change. Search enabled only when both terms are non-blank. No clitic toggle.

### 6.4 Corpus selector (`CorpusSelector`)

```
CORPUS
┌ Selected Texts:  All │ 1,234 ┐
[      Select Texts      ] [⬇]     ← green save icon only when >0 selected
```
"Select Texts" opens TextSelectionModal in `select` mode. The save icon ("Save as Collection", `bg-green-600`) opens SaveCollectionModal. Clearing the selection is done inside TextSelectionModal.

### 6.5 Name search (`NameSearchForm`, `NameInputGroup`)

Up to **4** forms in a scrollable stack, each:

```
┌ Kunya ──────────┐ ┌ Nasab ──────────────────┐ ┌ Nisba ─────────┐
│ [ كنية/لقب     ] │ │ [ نَسَب               ] ? │ │ [ نسبة       ] ? │
│ [ + Add Laqab  ] │ │ □ Include 1-part nasab  │ │ [ + Add Nisba ] │
│ □ Include kunya  │ │ □ Include 1-part nasab  │ │ [ + Add Shuhra] │
│   + nisba      ? │ │   + nisba               │ │ [ شهرة      ] ? x│
│ □ Include kunya  │ │ □ Include 2-part nasab  │ └─────────────────┘
│   + 1st nasab  ? │ └─────────────────────────┘
└──────────────────┘
[ Reset Form ] [ Delete Name ]        ▸ Generated Patterns (12)
────────────────────────────────────────────────────────────────
[ + Add Name ]                                     (hidden at 4)
[            Search / Searching...                            ]
```

- Kunya: max 2 inputs, placeholder `كنية/لقب`; "+ Add Laqab" hides at 2.
- Nasab: one input, placeholder `نَسَب`, tooltip "Enter nasab with at least two names, e.g. معمر بن أحمد".
- Nisba: unlimited inputs, placeholder `نسبة`; "+ Add Shuhra" reveals a `شهرة` input (`text-sm`) with a remove ×.
- Checkbox tooltips give an example for each: kunya + nisba (أبو منصور الأصبهاني), kunya + 1st nasab (أبو محمد أحمد), 1-part nasab (محمد), 1-part nasab + nisba (محمد الدمشقي), 2-part nasab (محمد بن أحمد).
- **Generated Patterns (n)**: collapsed by default; expands to a `max-h-40` RTL list computed live from the form, with the three kunya cases collapsed to `اب*`.
- Search enabled when at least one form is valid (see KASHSHAF_SPECIFICATION.md §8.4). "Delete Name" only when >1 form. Enter triggers search when valid.

---

## 7. Reader Panel (`ReaderPanel.tsx`)

### 7.1 Header (`h-20 px-8 bg-app-surface border-b`)
1. **Cite** button (disabled without book metadata) → citation overlay (§9).
2. **Title button**: `Title - Author`, RTL, `text-lg font-semibold truncate`, tooltip "View book details" → opens `BookDetailView` full-screen with "Back to Search Results". Falls back to `Book {id}`.
3. Load time `{n}ms` in `text-xs text-app-text-tertiary`.
4. **Vol:page navigator** pill: `[vol]` `:` `[page]` `[Go]`. The volume input is rendered only when the book is multi-part (`parts == null || parts > 1`). Enter in either input triggers Go. Seeded from the current `part_label:page_number`.
5. **← Prev** / **Next →**: always enabled; at a part edge nothing happens (see §16).

No font-size control, no copy button; the body is `select-text`.

### 7.2 Body
- Container `flex-1 overflow-y-auto bg-white`, content `max-w-4xl mx-auto px-16 py-12`, text `dir="rtl" text-xl leading-loose font-arabic`.
- `stripHtml` flattens all tags; `<title>` contents render as ordinary text. Newlines become `<br>`.
- Every token is a `span.cursor-pointer.rounded.px-0.5` with `hover:bg-app-accent-light`; matches use the red highlight.
- Click → `TokenPopup` at the cursor; clicking anywhere in the body closes it.
- On new matches, the first highlighted span is smooth-scrolled to one-third of the container height.
- **Empty state is a blank white panel**; there is no placeholder text and no loading spinner in the reader.
- Navigation errors show a Toast: "Enter both volume and page number", "Enter a page number", "Page {v}:{p} not found in this text".

### 7.3 Non-paginated books
The reader body does not change. `CitationBlock` omits vol/page and shows a warning; `BookDetailView` shows the red line "Kashshāf pagination does not match a printed edition" when `paginated === false`.

---

## 8. Results Panel (`ResultsPanel.tsx`, `VirtualizedResultsList.tsx`, `SearchResultRow.tsx`, `VariantsList.tsx`)

### 8.1 Header (`h-10 bg-app-surface-variant px-6`)
```
Results   [Variants]  [Export (2,000) ▾]            250 / 12,345 · 45ms
```
- Title: "Results" or "Variants".
- **Variants** button: only for a single AND input in lemma or root mode with no OR inputs; disabled with tooltip "Only available on 5,000 results or fewer" above `VARIANTS_MAX_HITS`. In variants view it reads "← Results".
- **Export (n)** where n = min(total_hits, 2,000): dropdown with "Export as CSV" and "Export as Excel"; shows spinner + "Exporting..." while running.
- Stats: `{loaded} / {total} · {ms}ms` (or `{n} variants · {ms}ms`).
- **No sort controls.** Order is fixed (author death, book, volume, page).

### 8.2 List
- Sticky column header `h-8`: **Vol:Pg** `w-16` centred, **Context** `flex-1` centred, **Title** `w-48` right.
- Rows `h-12` (`ROW_HEIGHT = 48`), virtualized with `overscan 5`, `hover:bg-app-surface-variant`.
  - Vol:Pg: `part_label:page_number`, or just `page_number` for single-part books or when the label is empty/"0".
  - Context: RTL snippet of ~50 tokens with the first match at most 5 tokens from the start, prefixed with `… ` when truncated; `text-xl font-arabic truncate`.
  - Title: `w-56 text-lg text-app-accent font-arabic truncate`; hover opens `MetadataTooltip` (Title, Author, Death) following the cursor.
- Infinite scroll: fetch 250 more when within 200px of the bottom, until `total_hits` or 5,000. Footer: "Loading more...", "All {n} results loaded", or "Showing {n} of {m} (max reached)".
- States: spinner + "Searching..."; "No results found"; "Enter a search query" (no search yet); red `h-10` error banner.

### 8.3 Variants view (`VariantsList`)
Replaces the list. Each row: surface tuple (RTL, `text-xl font-arabic`) and right-aligned frequency (`tabular-nums`). Backend order (frequency desc). Click → new tab with a surface phrase search for that tuple. Banner when sampled: "Sampled {scanned} of {total} matching pages. Counts are estimates." Empty: "No variants matched. The query may not produce a phrase that exists in the corpus." Loading: "Computing variants…".

---

## 9. Citation Block (`CitationBlock.tsx`)

```
Style: [Chicago][MLA]                                   [Copy | Copied]
⚠ Pagination in this text does not match the printed edition.
  Volume and page number have been omitted from the citation.
┌────────────────────────────────────────────────────────────────┐
│ Author. <em>Title</em>. Edited by …. Place: Publisher, Date.    │
│ Vol. 2, p. 45.                                                 │
└────────────────────────────────────────────────────────────────┘
• warnings from citation_json
```
- Default style Chicago. Copy writes plain text (em tags stripped) and shows "Copied" for 1.5 s.
- Page reference only when requested **and** `book.paginated === true`; otherwise the yellow warning.
- No `citation_json` → italic "No citation data is available for this text."
- Used in the reader's Cite overlay (`w-[600px]`, with page ref) and in `BookDetailView` (without).

---

## 10. Modals

All modals are `fixed inset-0` overlays with `bg-black/50` (TextSelectionModal uses `bg-black/60 backdrop-blur-sm`) at `z-50`, except `SaveCollectionModal` (`z-[60]`, stacks over TextSelectionModal). There is no shared Modal primitive, no focus trap, and no `role="dialog"`.

### 10.1 TextSelectionModal — `w-[1000px] h-[85vh]`
Modes: `select` (from sidebar), `create-collection`, `edit-collection` (from CollectionsModal). Header: "Select Texts" / "Create Collection" / "Edit: {name}".

```
[ All Texts (7,176) ][ Selected Texts (12) ]           [Save Collection]
Death: [From][To]  Genre: [All ▾]  Collection: [All ▾]  Search: [ Title or author ]  Clear Filters
[ Select Showing (7,176) ] [ Clear All Selected ]                          12 selected
 TITLE ▲                       AUTHOR                    DEATH
 ☐  كتاب العلم                 أبو طالب المكي             386 AH
```
- Filters: death range, genre multi-select, collection multi-select (shown only when collections exist; OR between collections, AND with other filters), Arabic-normalized title-or-author search.
- Sortable Title / Author / Death, default death ascending with unknowns last; shared with the Selected tab, which has its own "Filter selected texts" box and "Clear All".
- Rows `h-12`, checkbox left, RTL columns 50/35/15, selected rows `bg-app-accent-light`; whole row toggles.
- Footer only in collection modes: Cancel + "Save Collection" (create) or "Update Collection" (edit, enabled only when the selection changed). In `select` mode changes apply live; close with × or backdrop.

### 10.2 MetadataBrowser — full-screen surface
```
Metadata Browser   7,176 texts          [Export Metadata ▾]   [×]
[ Text Browser ][ Author Browser ]
Death: [From][To]  Genre: [All Genres ▾]  Search: [ Title or author... ]  Clear Filters
 TITLE ▲            │ AUTHOR             │ DEATH  │ GENRE        ← draggable dividers
```
- Texts table: rows `h-16`, `text-2xl font-arabic`; sortable Title, Author, Death, Genre; column dividers draggable (min 5% each; defaults 40/30/12/18).
- Authors table: derived client-side from the filtered books; columns Name, Death, # of Books, Genres; click → `AuthorBooksView` (author header with genre chips, then that author's texts).
- Click a text → **BookDetailView**: title `text-4xl`, author `(ت {death})`, tags chips (first 3, Expand/Collapse), **Kashshāf Data** card (Kashshāf ID, Genre, Token Count, Author ID, Death, Page Count, Source Corpus, Source ID, with tooltips), **Book and Edition Metadata** card from `metadata_json` (Title, Author, Publisher, Place, Date, Edition, Series, Volumes (hidden when 1), Page Range, Page Count, Container Title, then Editors, Translators, Commentators, Arrangers, Reviewers, Transmitters, Preface By, Transcribers, Digital Encoders, Digital Preparers, Contributors), pagination warning when `paginated === false`, and a Citation card.
- Export exports the **currently filtered** texts or authors as CSV/Excel.
- `Escape` goes back one level or closes. List scroll position is restored after drilling down.

### 10.3 CollectionsModal — `w-[600px] max-h-[80vh]`
Rows: icon, name, "Created {date}", `{n} texts` badge, delete (native `confirm('Delete this collection?')`), expand chevron. Clicking the row opens TextSelectionModal in edit mode. Expanded panel shows the description with inline edit (textarea, 150-char cap with counter). Empty state "No collections yet" + Create Collection. Footer hint "Click a collection to edit its texts."

### 10.4 SaveCollectionModal — `w-[400px]`
Name (required, autofocus, no max length, case-insensitive duplicate check with inline "A collection with this name already exists"), Description (optional, 150-char cap with counter). Enter submits. Title/button text are props ("Save Collection" / "Save").

### 10.5 SearchHistoryModal — `w-[600px] max-h-[80vh]`
Header "Search History" with **Clear All** (confirm: "Are you sure you want to clear all search history? Saved searches will not be affected."). Rows: star toggle (optimistic save/unsave), RTL label `text-2xl font-arabic`, type badge (Boolean blue, Proximity purple, Name green, Wildcard orange), `{n} texts` or "All texts", relative time ("Just now", "5m ago", "3h ago", "2d ago", then a date). Click loads and re-runs the search. Footer: "Click to load a search. Star to save it permanently. History keeps the last 100 searches."

### 10.6 SavedSearchesModal — same shell
Header "Saved Searches". Rows as above with "Saved {time}" and a remove ×. Empty: "No saved searches yet. Star searches from the history to save them here." Footer: "Click to load a saved search. Saved searches are never auto-deleted."

### 10.7 DownloadModal — `w-[500px]` (desktop)
Title and copy depend on `CorpusStatus`:

| Condition | Title | Body |
|---|---|---|
| app too old | App Update Required | status error; primary button "Download Update" → kashshaf.com/download |
| fresh install | Corpus Download | "For offline use, you must download the corpus (**{size}**). Do you want to proceed?" |
| schema changed | Corpus Update Required | "The corpus format has changed. Please download the updated corpus data to continue." |
| new version | Corpus Update Available | "A new version of the corpus is available ({version}). Would you like to update?" (dismiss = "Later") |

Options: "Verify downloaded files (slower)" (default **unchecked**), "Do not show again" (online-option variant only). Buttons: Download, Use Online Mode, Cancel (while downloading), Retry / Use Online Mode (after failure), Continue (after completion).

Progress: current file with `{k} / {n}`, per-file bar `h-2`, "Overall Progress" `{x} / {y}` bar `h-3`, status line (Starting... / speed per second / Verifying... / Complete! / Cancelled / Failed) with overall %, and "Estimated Time Remaining: m:ss" or "m:ss elapsed". Speed is a rolling average of the last 10 one-second samples.

### 10.8 AppUpdateModal — `w-[450px]` (desktop)
Required: red header "Update Required", text explaining v{current} is no longer supported, single **Update** button, no close. Optional: blue header "Update Available", current/latest versions, "Do not show again" checkbox, **Skip** and **Update**. Both link "What's New?" to the GitHub releases page. Update opens the platform download URL.

### 10.9 DeleteDataModal — `w-[450px]` (desktop, from native menu)
Red header "Delete Local Data". Body: "This will delete the corpus database and search index files. Future offline usage will require you to re-download the database files." Note: "Your search history, saved searches, and settings will be preserved." Buttons Cancel / **Delete** ("Deleting..." with spinner).

### 10.10 AnnouncementsModal — `w-[600px] max-h-[80vh]`
Digest of eligible announcements, each a card with a type badge (Critical red, Warning yellow, Info blue), date, "Required" marker for forced items, title, body (`**bold**` and `[text](url)` only), optional action button. Footer: "Don't show on startup" checkbox + **Dismiss**. When any announcement is `forced` and not dismissible, the × and footer are hidden.

### 10.11 Unused
`AnnouncementModal` (single-item variant) and `BooksModal` (early book browser) exist in `modals/` but are never rendered.

---

## 11. UI Primitives (`ui/`)

- **Toast**: portal, `fixed top-4 right-4 z-[10000] max-w-md`; variants `error` (red, default), `warning` (amber), `info` (blue); auto-dismiss after 4 s with a 300 ms slide-out; manual ×. Used for search validation (Sidebar) and navigation errors (ReaderPanel).
- **TokenPopup**: `fixed w-64 bg-white rounded-lg shadow-app-lg z-50`; header "Token Information" + ×; rows Surface, Lemma, Root (RTL `text-xl font-arabic`), POS, Features (joined), Clitics (`display` joined); `—` for empties. Opens 10px below the click, clamps to the viewport, flips above when needed. Read-only.
- **Tooltip / InfoTooltip / MetadataTooltip** (`Tooltip.tsx`): portal at `z-[9999]`, 200px default width, prefers above the anchor and flips below; Arabic runs are auto-wrapped in `font-arabic dir="rtl"`. `InfoTooltip` is a 16px `?` chip. `MetadataTooltip` (320px) shows Title, Author, Death.
- **UpdateBanner**: `bg-app-accent-light` strip, "New corpus version available ({version})", **Update** + dismiss ×.
- **DraggableSplitter**: see §3.

---

## 12. Help Panel (`HelpPanel.tsx`)

Header "Help & Documentation" (`h-14`) with close ×; tab strip Overview · Term Search · Surface/Lemma/Root · Wildcards · Name Search · Features; content `max-w-3xl`, section headings `text-lg font-semibold text-app-accent`.

Sections: al-Kashshāf Overview, Getting Started, Search Tabs · Term Search, Boolean Search (AND/OR), Proximity Search, Ignore Clitics · Search Modes, Surface Form, Lemma, Root · Wildcard Search, Wildcard Rules, Wildcard Types, Performance Considerations · Name Search, Name Components, How It Works, Multiple Name Forms · Metadata Browser, Text Selection, Collections, Exporting Search Results, Search History, Token Information, Keyboard Navigation.

Help text that should be reconciled with the UI: it refers to "+ Add Term" and a per-term AND/OR dropdown (the UI has "+ Add search term" and AND/OR tabs, capped at 3); "+ Add Name Form" (button is "+ Add Name", capped at 4, kunyas capped at 2); says exports are CSV only (Excel is also offered); claims a dedicated author filter and "sort by any column" in the metadata browser; claims keyboard scrolling in results. It does not document Variants, the 1–100 proximity range, the 5,000-result cap, or the 2,000-row export cap.

---

## 13. Startup and Modal Sequencing

1. `OperatingModeProvider` resolves mode (§3 of the main spec). Loading screen until then.
2. Desktop: `checkCorpusStatus()`. `pending` → DownloadModal; offline and not ready or `update_required` → DownloadModal; `update_available` → UpdateBanner.
3. Toolbar runs the app update check (desktop).
4. After the download phase resolves, announcements are fetched and shown once if any are eligible.
5. Collections load on mount.

`ModalQueueContext` (priority order DOWNLOAD 10 < APP_UPDATE 15 < FORCED_ANNOUNCEMENT 20 < IMPORTANT 30 < NORMAL 40 < PROMO 50) exists to serialize these but is not mounted; the sequence above is driven by independent booleans in `App.tsx`.

---

## 14. Keyboard and Accessibility

- Enter triggers search in the Boolean, Proximity, and Name panels; Enter submits SaveCollectionModal and the reader's vol/page inputs.
- `Escape` closes MetadataBrowser (or backs out one level). No other global shortcuts, no tab switching keys, no focus traps.
- Only two `aria-label`s exist (reader page input, citation close). Modals have no `role="dialog"`.
- Contrast (computed): accent `#2C5F8D` on white 6.7:1 and the red highlight `#B91C1C` on `#FEE2E2` 5.3:1 both pass WCAG AA. `app-text-tertiary` `#999999` on white is 2.85:1 and **fails AA** for normal text; it is used for load times, hints, and disabled labels.
- Native text selection is enabled in the reader.

---

## 15. User-Facing Strings (reference)

**Arabic placeholders:** `ابحث...` · `كنية/لقب` · `نَسَب` · `نسبة` · `شهرة`.

**Labels:** Menu · Browse Texts · History · Saved · Collections · Help · Online Mode · Terms · Names · Boolean · Proximity · AND · OR · Search · Searching... · Clear form · + Add search term · Surface · Lemma · Root · Ignore clitics · Term 1 · Term 2 · within · tokens · Corpus · Selected Texts: · All · Select Texts · Save as Collection · + Add Laqab · + Add Nisba · + Add Shuhra · + Add Name · Reset Form · Delete Name · Generated Patterns (n) · Cite · Go · ← Prev · Next → · Citation · Style: · Chicago · MLA · Copy · Copied · Results · Variants · ← Results · Export (n) · Export as CSV · Export as Excel · Vol:Pg · Context · Title · Token Information · Select Showing (n) · Clear All Selected · Clear Filters · All Texts (n) · Selected Texts (n) · Save Collection · Update Collection · Create Collection · Metadata Browser · Text Browser · Author Browser · Kashshāf Data · Book and Edition Metadata · Help & Documentation.

**Messages:** Loading... · Checking corpus data... · Searching... · Computing variants… · Loading more... · Exporting... · No results found · Enter a search query · All {n} results loaded · Showing {n} of {m} (max reached) · Only available on 5,000 results or fewer · No variants matched. … · Sampled {n} of {m} matching pages. Counts are estimates. · No books match filters · No authors match your filters · No texts selected · No collections yet · No saved searches yet. … · No search history yet. … · Delete this collection? · A collection with this name already exists · Page {v}:{p} not found in this text · Pagination in this text does not match the printed edition. … · Kashshāf pagination does not match a printed edition · No citation data is available for this text. · You're running the latest version of Kashshaf (v{n}). · New corpus version available ({version}) · Your search history, saved searches, and settings will be preserved.

---

## 16. Known UI Issues (v0.4.1)

1. `bg-app-accent-dark` is used in 9 files but the token is undefined; those hover states are inert (§2).
2. Results header Title column is `w-48` while rows use `w-56`; the header is misaligned.
3. Highlight tokens and `.highlight-*` classes are dead; surface/lemma/root matches are indistinguishable.
4. Reader empty state is a blank white panel with no message or spinner.
5. Prev/Next never disable and silently no-op at part boundaries; highlights are cleared on any navigation.
6. `DeleteDataModal` success does not switch the app to online mode (`onDataDeleted` not wired).
7. Wildcard validation passes in the UI but the query loses its `*` before reaching the backend (main spec §8.3).
8. `[TokenDebug]` console logging runs on every reader render and click.
9. `AnnouncementsModal` and `CitationBlock` inject HTML with `dangerouslySetInnerHTML`; announcement bodies come from the CDN unsanitized.
10. Help copy diverges from the UI in the ways listed in §12.
11. `indexedPages` / stats are threaded into Sidebar but never displayed.
12. Sidebar resize uses raw `clientX`, assuming the sidebar starts at x = 0.
13. Two dead components (`BooksModal`, `AnnouncementModal`) and an unmounted `ModalQueueContext`.
14. No dark mode, no global RTL layout mode, no font-size control.

---

## 17. Future

- [ ] Dark mode (tokens are centralized in `@theme`, so this is mostly additive)
- [ ] Reader font-size control
- [ ] Per-mode highlight colours (tokens already exist)
- [ ] Keyboard navigation for tabs and results; dialog semantics and focus traps
- [ ] Mount `ModalQueueContext` for deterministic startup modal ordering
- [ ] Side-by-side text comparison
- [x] Search history and saved searches
- [x] Export (CSV and Excel)
- [x] Multiple tabs
- [x] Collections
- [x] Citations
- [x] Variants

**End of UI Specification**
