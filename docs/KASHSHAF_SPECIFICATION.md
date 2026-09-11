# Kashshaf Specification
## Premodern Arabic Text Research Environment

**Version:** 4.1
**Last Updated:** 2026-09-09
**App version described:** 0.5.0 (desktop, API server, web build) — see the 0.5.0 addendum in §25
**Corpus versions readable:** 2.0.0 (schema 1, shipped), 3.0.0 (schema 3, Phase A), 4.0.0 (schema 4, compound index, Phase B)

This document describes the application as it exists in the codebase at v0.4.1. It replaces the v3.1 specification (January 2026), which had drifted from the implementation in several places (see §22 for the full list of corrections). Companion documents in this folder:

| Document | Scope |
|---|---|
| [PIPELINE.md](PIPELINE.md) | How raw texts become `corpus.db`, `metadata.db`, and the Tantivy index |
| [CORPUS_DATA_MODEL.md](CORPUS_DATA_MODEL.md) | `corpus.db` schema and token compression |
| [KASHSHAF_UI_SPECIFICATION.md](KASHSHAF_UI_SPECIFICATION.md) | Interface design, components, design tokens |
| [RELEASE_REF.MD](RELEASE_REF.MD) | Release workflow for app, API, and corpus |
| [REPORT.md](REPORT.md) | Storage and search rebuild plan (Phase A / Phase B) |
| `../docs/KASHSHAF_API_SPEC.md` | Public HTTP API (partially out of date, see §17.3) |

---

## 1. System Purpose

Kashshaf is a search and reading environment for premodern Arabic texts. The corpus draws on al-Maktaba al-Shāmila, OpenITI, and nuṣūṣ, restricted to authors who died before 1930 CE (1348 AH). Every token in the corpus carries a CAMeL Tools morphological analysis, which is what makes lemma and root search possible.

**Core capabilities (implemented at v0.4.1):**
- Surface, lemma, and root search with morphological precision
- Boolean queries: up to 3 AND terms and 3 OR terms, each with its own mode
- Surface-mode clitic expansion (و ف ب ل ك proclitics)
- Wildcard search (prefix and infix `*`) in surface mode
- Proximity search: two terms within N tokens, each term in any mode
- Name search with pattern generation for kunya, nasab, nisba, and shuhra
- Lemma and root **variants**: distribution of surface forms behind a lemma or root query
- Token overlay: click any word to see surface, lemma, root, POS, features, clitics
- Reader with prev/next paging, vol:page jump, and formatted citations (Chicago, MLA)
- Text selection (mini-corpus) filtering and named, persistent **collections**
- Search tabs (one tab per executed search)
- Automatic search history (last 100) and explicit saved searches
- Metadata browser with text and author views, sortable columns, and CSV/Excel export
- Search result export to CSV/Excel (up to 2,000 rows)
- Offline mode (local corpus) and online mode (remote API), plus a browser-only web build
- Corpus download from CDN with manifest versioning, app update checks, and remote announcements

**Not in scope:**
- LLM/AI features
- Multi-user accounts or cloud sync of user data
- Text editing or annotation
- Syntactic parsing
- Mobile

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI layer — React 18 + TypeScript + Tailwind v4                      │
│  Sidebar · SearchTabs · ReaderPanel · ResultsPanel · modals          │
├──────────────────────────────────────────────────────────────────────┤
│  SearchAPI interface (src/api/index.ts)                              │
│  OfflineAPI (Tauri invoke)          OnlineAPI (fetch)                │
├──────────────────────────┬───────────────────────────────────────────┤
│  Desktop offline         │  Desktop online / Web build               │
│  Tauri 2 → Rust backend  │  HTTPS → https://api.kashshaf.com         │
│  src-tauri/src/*.rs      │  api/src/*.rs (axum, Rust)                │
├──────────────────────────┼───────────────────────────────────────────┤
│  tantivy_index/          │  /opt/kashshaf/data/tantivy_index         │
│  corpus.db               │  /opt/kashshaf/data/corpus.db             │
│  metadata.db             │  /opt/kashshaf/data/metadata.db           │
└──────────────────────────┴───────────────────────────────────────────┘
   User data: settings.db (desktop, both modes) · localStorage (web)
   Distribution: https://cdn.kashshaf.com (corpus, app manifest, announcements)
```

**Core principle:** the same three data artifacts (Tantivy index, `corpus.db`, `metadata.db`) are read either by the embedded Rust backend inside the desktop app or by the standalone Rust API server. The frontend never knows which; it talks to a `SearchAPI` implementation chosen at startup.

Since 0.5.0 both hosts depend on one crate, `engine/` (`kashshaf-engine`), which owns the Tantivy engine, the token cache and blob codec, variants, and the triple maps. The only per-host differences are in `EngineConfig` (highlight caps: desktop 5 per result row, API 20). Before 0.5.0 `api/src/search.rs` was a drifted copy of `src-tauri/src/search.rs`.

---

## 3. Deployment Targets and Operating Modes

### 3.1 Targets

| Target | Build | Data source | User data |
|---|---|---|---|
| Desktop offline | `npm run tauri build` | Local `tantivy_index/`, `corpus.db`, `metadata.db` | `settings.db` |
| Desktop online | same binary, corpus not downloaded | `https://api.kashshaf.com` | `settings.db` |
| Web | `npm run build:web` (`VITE_TARGET=web`) | `https://api.kashshaf.com` | `localStorage` |

The web build aliases every `@tauri-apps/*` import to stubs in `src/stubs/` (see `vite.config.ts`). The stubbed `invoke` throws, so any code path that reaches Tauri on web is a bug. `isWebTarget()` (`src/utils/platform.ts`) gates all desktop-only UI. The web build is always in online mode.

### 3.2 Mode model

`OperatingMode = 'online' | 'offline' | 'pending'` (`src/api/index.ts`). `pending` means the desktop app has no corpus and the user has not yet chosen; the download dialog is shown.

```
App launch (desktop)
  │
  ├─ corpus_exists()?  ── yes ─► mode = offline
  │                              check_corpus_status()
  │                                ├─ !ready or update_required ─► DownloadModal (blocking)
  │                                ├─ update_available ─► UpdateBanner (dismissible)
  │                                └─ ready ─► main UI
  │
  └─ no ─► user_settings.skip_download_prompt == "true"
              and user_settings.mode == "online"?
              ├─ yes ─► mode = online (toolbar shows amber "Online Mode" button)
              └─ no  ─► mode = pending ─► DownloadModal
                          ├─ Download ─► reload_app_state() ─► mode = offline
                          └─ Use Online Mode ─► saveOnlineModePreference(skip) ─► online
```

Mode is resolved in `OperatingModeContext`. There is no factory; `getOfflineAPI()` and `getOnlineAPI()` return module singletons and the context picks one whenever `mode` changes.

### 3.3 Corpus presence and readiness

- `corpus_exists()` (Rust) checks for `tantivy_index/` and `corpus.db`.
- `AppState::new` additionally **requires `metadata.db`** and fails without it. It also compares `db_info.corpus_version` in `corpus.db` and `metadata.db` and refuses to start on mismatch (skipped if either lacks `db_info`).
- If `AppState::new` fails, the app still launches with `AppState = None`. Every corpus-dependent command returns `CorpusNotReady`; history, saved searches, settings, collections, download, update, and announcement commands keep working.
- `reload_app_state()` rebuilds `AppState` after a download without restarting the app.

### 3.4 Mode persistence

Both keys live in the `user_settings` table of `settings.db` (desktop) or `kashshaf_user_settings` in localStorage (web).

| Key | Values | Meaning |
|---|---|---|
| `skip_download_prompt` | `"true"` / `"false"` | Suppress the download dialog at startup |
| `mode` | `"online"` / `""` | Preferred mode when no corpus is present |

Once a corpus exists, these keys are ignored and the app is offline. Deleting local data (§14.4) returns the app to the no-corpus path on next launch.

### 3.5 Online mode indicator

In desktop online mode the toolbar shows an amber **Online Mode** button. Clicking it fetches corpus status and opens the download dialog. There is no offline indicator.

---

## 4. Technology Stack

### Frontend
- React 18.3, TypeScript 5.6, Vite 6
- Tailwind CSS **4.1** via `@tailwindcss/postcss`; design tokens in an `@theme` block in `src/styles/index.css` (there is no `tailwind.config.js`)
- `@tanstack/react-virtual` 3 for results, book lists, and metadata tables
- `xlsx` (SheetJS) 0.18 for Excel export
- Tauri JS API 2.x plus `plugin-dialog`, `plugin-fs`, `plugin-shell`
- Fonts: Scheherazade New (bundled, `public/fonts/`), Amiri and Inter from Google Fonts via `index.html`

### Desktop backend (`src-tauri`)
- Tauri 2, Rust 2021
- Tantivy **0.25**, rusqlite 0.32 (bundled SQLite), `lru` 0.12
- `reqwest` 0.11 (rustls), `sha2`, `hex` for corpus download and verification
- `regex-lite`, `chrono`, `dirs`
- Release profile: LTO, `opt-level = 3`, `codegen-units = 1`

### API server (`api`)
- axum 0.7 on tokio, tower-http (CORS)
- Tantivy **0.22**, rusqlite 0.32, `lru` 0.12
- `governor` / `tower_governor` are declared but **not used** (no in-process rate limiting)
- Binds `127.0.0.1:3000`; TLS and the `api.kashshaf.com` vhost are handled by an unversioned reverse proxy

### Data preparation (not shipped)
Described in [PIPELINE.md](PIPELINE.md): `kashshaf-pipeline.py` (canonical JSON), `process_batch.py` (CAMeL Tools BERT disambiguation), `build_sqlite_tokens.py` (`corpus.db`, `metadata.db`), and a Rust `indexer/` binary for the Tantivy index. The v3.1 spec's `ingest_to_index.py` no longer exists.

### Platforms
Windows (MSI, NSIS), macOS universal DMG (signed and notarized), Linux (AppImage, deb). Built by `.github/workflows/release.yml` on `v*` tags.

---

## 5. Project Structure

```
kashshaf-app/
├── src/                                  # React frontend
│   ├── App.tsx                           # Layout, startup sequence, modal state, variants context
│   ├── main.tsx                          # OperatingModeProvider → SearchTabsProvider → App
│   ├── api/
│   │   ├── index.ts                      # SearchAPI interface, OperatingMode, Variant types
│   │   ├── tauri.ts                      # All invoke() bindings (54 commands), clitic expansion
│   │   ├── offline.ts                    # OfflineAPI (delegates to tauri.ts)
│   │   └── online.ts                     # OnlineAPI (fetch to api.kashshaf.com)
│   ├── components/
│   │   ├── Sidebar.tsx  Toolbar.tsx  SearchTabs.tsx
│   │   ├── sidebar/      BooleanSearchPanel, ProximitySearchPanel, ProximityInputRow,
│   │   │                 SearchInputRow, CorpusSelector
│   │   ├── name-search/  NameSearchForm, NameInputGroup
│   │   ├── panels/       ReaderPanel, ResultsPanel, VariantsList, HelpPanel
│   │   ├── shared/       SearchResultRow, VirtualizedResultsList, CitationBlock
│   │   ├── modals/       TextSelectionModal, MetadataBrowser (+BookDetailView),
│   │   │                 CollectionsModal, SaveCollectionModal, SearchHistoryModal,
│   │   │                 SavedSearchesModal, DownloadModal, DeleteDataModal,
│   │   │                 AppUpdateModal, AnnouncementsModal,
│   │   │                 AnnouncementModal (unused), BooksModal (unused)
│   │   └── ui/           Toast, Tooltip (+InfoTooltip, MetadataTooltip), TokenPopup,
│   │                     UpdateBanner, DraggableSplitter
│   ├── contexts/         BooksContext, OperatingModeContext, SearchTabsContext,
│   │                     ModalQueueContext (implemented, not mounted)
│   ├── hooks/            useSearch, useSearchTabs, useReaderNavigation
│   ├── types/            index.ts, search.ts, collections.ts, announcements.ts
│   ├── constants/search.ts
│   ├── utils/            arabicTokenizer, namePatterns, wildcardValidation, citation,
│   │                     collections, storage, announcements, exportData, platform, sanitize
│   ├── stubs/            tauri-core, tauri-event, tauri-dialog, tauri-fs, tauri-shell
│   └── styles/index.css  # Tailwind v4 @theme tokens, @font-face, scrollbars
│
├── src-tauri/src/
│   ├── main.rs           # Tauri builder, 55 registered commands, native menu events
│   ├── commands.rs       # All #[tauri::command] functions, settings.db DDL, metadata queries
│   ├── search.rs         # Tantivy SearchEngine (2,530 lines)
│   ├── variants.rs       # Lemma/root variant scanner
│   ├── cache.rs          # TokenCache (LRU) + lookup tables + wildcard phrase verify
│   ├── downloader.rs     # Data dir resolution, manifests, CDN download, app update check
│   ├── state.rs          # AppState construction, version check, settings.db init
│   ├── tokens.rs         # Token, TokenClitic, TokenField, PageKey
│   └── error.rs          # KashshafError
│
├── api/src/              # axum server: main.rs (17 routes), search.rs, cache.rs, variants.rs
├── scripts/
│   ├── release.py        # Version bump (4 files) + app_manifest.json + tag + push
│   ├── generate_announcement.py
│   ├── announcements/announcements.json
│   └── manifests/        app_manifest.json, corpus_manifest.json, KASHSHAF_API_SPEC.md
├── .github/workflows/    release.yml (3 OS builds → draft release), deploy-api.yml (ssh deploy)
└── docs/                 # This folder (tracked since 2026-09-12; releases/ keeps only scratch files)
```

`releases/` and `scripts/` are listed in `.gitignore` as internal documents (exceptions: `scripts/release.py`, `scripts/check_release.py`, `scripts/generate_announcement.py`, `scripts/announcements/`); the specifications, reports, changelog and API spec moved to the tracked `docs/` directory on 2026-09-12. `data/` and `src-tauri/data/` are ignored too; users download the corpus separately.

---

## 6. Data Files

### 6.1 Inventory

| File | Producer | Size (corpus 2.0.0) | Read by |
|---|---|---|---|
| `tantivy_index/` | `indexer/` (Rust) | 13.0 GB (18 segments, 107 files) | `SearchEngine` (desktop and API) |
| `corpus.db` | `build_sqlite_tokens.py` | 5.24 GB | `TokenCache`, variants, `db_info` check |
| `metadata.db` | `build_sqlite_tokens.py` | small | All book/author/genre metadata commands |
| `settings.db` | App at first run | small | History, saved searches, settings, collections |
| `manifest.local.json` | Downloader | tiny | Corpus version and per-file completion |

Sizes are decimal GB from `scripts/manifests/corpus_manifest.json` (total 18.26 GB, or 17.0 GiB). [REPORT.md](REPORT.md) measured 7,176 books, 5,711,697 pages, and 987,907,098 tokens for this corpus.

**Stale copy:** the `corpus_manifest.json` in this repo's `scripts/manifests/` omits `metadata.db`, but the pipeline's `generate_manifest.py` (in `kashshaf-data-clean`) does hash and list it, and the app requires it to start. The copy here predates the 0.3.0 metadata.db distribution and should be refreshed from the R2 manifest or deleted.

### 6.2 Data directory resolution (`downloader::get_data_dir`)

| Build | Location |
|---|---|
| Debug | `data`, `../../data`, `../../../data` relative to CWD, then up to 5 levels above the exe, else `<exe>/data` |
| Release macOS | `~/Library/Application Support/Kashshaf` (`dirs::data_dir()/Kashshaf`) |
| Release Windows, Linux | `<exe_dir>/data` (portable) |

All five files above live in the same directory, including `settings.db`. The comment in `state.rs` claiming settings live in a separate app-data directory is incorrect. `delete_local_data` spares `settings.db` and `metadata.db`; `archive_old_corpus` renames the whole directory and takes `settings.db` with it.

### 6.3 Tantivy index schema (as read by `search.rs`)

The schema is created by the external indexer; the app opens the index read-only and resolves fields by name. Every lookup is `get_field(name).unwrap()`, so a missing field panics.

| Field | Type | Flags inferred from use |
|---|---|---|
| `surface_text` | text | indexed, positions, `whitespace` tokenizer |
| `lemma_text` | text | indexed, positions, `whitespace` tokenizer |
| `root_text` | text | indexed, positions, `whitespace` tokenizer |
| `text_id` | u64 | indexed, stored, fast |
| `part_index` | u64 | indexed, stored, fast |
| `page_id` | u64 | indexed, stored, fast |
| `death_ah` | u64 | stored, fast (used for `order_by_u64_field`) |
| `author_id`, `genre_id`, `century_ah` | u64 | stored |
| `part_label`, `page_number` | string | stored, indexed as a single raw term (used by `get_page_by_label`) |
| `body` | text | stored only; original cleaned text with tashkil and `<title>` tags |

Notes:
- `SearchEngine::open` registers `WhitespaceTokenizer` under the name `whitespace`. Positions in the three text fields align with each other and with the `page_tokens` blob index because all three are whitespace splits of the same token stream (see PIPELINE.md Stage 4).
- There is **no `noclitic_surface_text` field** and no noclitic search mode. The v3.1 spec was wrong.
- PIPELINE.md describes a composite `sort_key` field. The app never reads it; ordering uses `death_ah` plus a post-sort (§10.1).
- Book metadata (`author`, `title`, `genre`, `corpus`) is **not stored in the index**. Results carry ids only; the frontend resolves names from `BooksContext`.

### 6.4 `corpus.db`

Full schema in [CORPUS_DATA_MODEL.md](CORPUS_DATA_MODEL.md). Tables touched at runtime:

```
roots(id, root)                         lemmas(id, lemma)
pos_types(id, pos)                      feature_sets(id, features JSON)
clitic_sets(id, clitics JSON)           token_definitions(id, surface, lemma_id, root_id,
                                                          pos_id, feature_set_id, clitic_set_id)
page_tokens(book_id, part_index, page_id, token_ids BLOB)
db_info(corpus_version, ...)
```

- `token_ids` is a flat little-endian `u32` array, decoded with `chunks_exact(4)`. Not varint (REPORT.md Phase A proposes varint+zstd; not implemented).
- `clitic_sets.clitics` is a JSON array of `{type, display}` objects, not strings.
- On startup the app runs `CREATE INDEX IF NOT EXISTS idx_token_def_lemma ON token_definitions(lemma_id)` for the variants feature. No equivalent root index exists, so root-mode variants are slower.
- The five lookup tables are loaded fully into memory at startup; failure panics.
- CORPUS_DATA_MODEL.md also describes `books`, `authors`, `genres`, `pages`, and `corpus_builds` inside `corpus.db`. The app reads book metadata from `metadata.db` instead, and reads `db_info` rather than `corpus_builds`. The `pages` table is not read at runtime.

### 6.5 `metadata.db`

```sql
books(id, corpus, title, author_id, death_ah, century_ah, genre_id, page_count, token_count,
      original_id, paginated, tags, book_meta, author_meta, in_corpus, parts,
      metadata_json, citation_json)
authors(id, author)
genres(id, genre)
db_info(corpus_version, ...)
```

- `tags`, `book_meta`, `author_meta` are JSON-encoded strings (`book_meta`/`author_meta` are legacy `"key: value"` lists from the pipeline).
- `metadata_json` is a structured record (`titles.main`, `responsible_persons.{authors, editors, translators, ...}`, `publication.{publisher, place, date, edition, series, volumes, ...}`) rendered by `BookDetailView`.
- `citation_json` is a flat record consumed by `utils/citation.ts` (§13).
- `parts` is the number of volumes; the reader hides the volume input when `parts == 1`.
- `paginated` is `false` for texts whose page boundaries do not match a printed edition (PIPELINE.md Stage 1). Citations omit vol/page for such texts.
- `BooksContext` filters out any book where `in_corpus` is not `true`.

### 6.6 `settings.db` (desktop user data)

Created by `AppState::init_settings_db` and, redundantly, by `get_settings_connection` in `commands.rs`. The two DDL copies differ slightly: only `state.rs` creates `user_settings` and runs the `history_id` migration.

```sql
CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_type TEXT NOT NULL,          -- 'boolean' | 'proximity' | 'name'
    query_data TEXT NOT NULL,           -- JSON
    display_label TEXT NOT NULL,
    book_filter_count INTEGER DEFAULT 0,
    book_ids TEXT,                      -- JSON array or NULL
    created_at TEXT NOT NULL            -- RFC 3339 UTC
);
CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    history_id INTEGER,
    search_type TEXT NOT NULL,
    query_data TEXT NOT NULL,
    display_label TEXT NOT NULL,
    book_filter_count INTEGER DEFAULT 0,
    book_ids TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(query_data)
);
CREATE TABLE IF NOT EXISTS app_settings  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,                   -- truncated to 150 chars
    book_ids TEXT NOT NULL,             -- JSON array
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_searches_created ON saved_searches(created_at DESC);
```

History is rotated to the newest 100 rows on insert. Saved searches are deduplicated by `query_data` and never auto-deleted. Wildcard searches are stored with `search_type = 'boolean'` even though the TypeScript union includes `'wildcard'`.

Settings keys in use:

| Key | Table | Purpose |
|---|---|---|
| `skip_download_prompt` | user | §3.4 |
| `mode` | user | §3.4 |
| `skip_announcement_popups` | user | Global "don't show on startup" for normal announcements |
| `dismissed_announcements` | user | JSON list of `{id, dismissed_at}` |
| `announcements_cache_data`, `announcements_cache_fetched_at` | user | 1-hour announcement cache |
| `skip_app_update_prompt` | app | "Do not show again" for optional app updates |

### 6.7 Web build storage (localStorage)

| Key | Contents |
|---|---|
| `kashshaf_search_history` | history entries (capped at 100) |
| `kashshaf_saved_searches` | saved searches |
| `kashshaf_app_settings`, `kashshaf_user_settings` | key/value maps |
| `kashshaf_dismissed_announcements`, `kashshaf_announcements_cache_data`, `kashshaf_announcements_cache_fetched_at` | announcements |
| `kashshaf_collections` | collections (book_ids as JSON string) |
| `splitterRatio`, `sidebarWidth` | layout (used on desktop too) |

---

## 7. Search Modes

`SearchMode = 'surface' | 'lemma' | 'root'` (default `lemma`). Each mode maps to one Tantivy field and one query-time normalization.

| Mode | Field | Query normalization | Matches |
|---|---|---|---|
| Surface | `surface_text` | `normalize_arabic`: strip U+064B–U+065F, U+0670, U+0671; fold أ إ آ → ا, ؤ → و, ئ ى → ي, plus Persian/Urdu letter folds (ک گ → ك, ی ے → ي, ۀ ە → ه, ۃ → ة, ٹ → ت, پ → ب, چ → ج, ژ → ز, ڤ → ف, ڨ → ق) | Exact normalized word form: `كتاب` matches `كتاب` only |
| Lemma | `lemma_text` | none (query passed verbatim) | All inflections: `كتاب` matches `الكتاب`, `كتابين`, `والكتاب` |
| Root | `root_text` | `normalize_root_query`: `normalize_arabic`, then join letters with `.` and replace weak letters و ي ا ء with `#` (`قول` → `ق.#.ل`) | All derivations of the root |

Because lemma queries are not normalized, a lemma must be typed as CAMeL Tools emits it. Root queries accept plain letters (`علم`) and are converted to the pipeline's dotted form (`ع.ل.م`).

**Clitic toggle ("Ignore clitics")** applies to surface inputs in boolean search only. It is implemented in the frontend (`api/tauri.ts` and duplicated in `api/online.ts`): the term is expanded to 6 variants, the original plus each of `و ف ب ل ك` prefixed to the **first word**, and all 6 are pushed as OR terms. A surface AND term with clitics enabled therefore becomes an OR block, which changes boolean semantics when other AND terms are present (see §22).

**Query sanitization:** every search query passes through `stripPunctuation` (`utils/sanitize.ts`) before being sent. Its character class **includes `*`**, so wildcard markers are removed. See §8.3 and §22.

---

## 8. Query Types

### 8.1 Boolean (combined) search

- UI: Terms → Boolean. Two independent input lists (AND tab, OR tab), 1 to 3 inputs each. Each input has its own mode and clitic toggle.
- Semantics: `AND1 AND AND2 ... AND (OR1 OR OR2 ...)`. With a single AND term and no OR terms the term query is used alone (and vice versa).
- Multi-word inputs become exact-adjacency `PhraseQuery`s on the term's field; single words become `TermQuery`s. Mixed modes across terms are allowed.
- Limit 250 per page (`PAGE_SIZE`), infinite scroll up to 5,000 (`MAX_RESULTS`).
- Search creates a new tab labelled with the first AND term (or first OR term), and loads the first result into the reader.

### 8.2 Proximity search

- UI: Terms → Proximity. Term 1, Term 2, each with a field selector, and a distance 1–100 (default 10).
- **Compound index (0.5.0, 2026-09-11):** a *capped, cached walk* (§10.2). Single-word sides: positional intersection on the `tokens` postings (`positional::intersect_n_stream`, union cursor per side, leapfrog from the rarer side, `proximity_matcher`). A phrase side: the candidate `DocSet` (`Must(term1) AND Must(term2)` plus filters) is streamed in reading order and every page is verified on the forward index (`forward::phrase_starts` / `has_pair_within`). Both produce hits in reading order with their pair positions (up to 100 per page). The walk stops at `MAX_VERIFIED_HITS = 20,000` verified hits or the 3 s safety budget; `total_hits` is the verified count and `was_capped` is set (header `250 / 20,000+`). With the desktop **Exact counts** setting the walk runs to the end (`الله ~10 قال` on the full corpus: 2,447,865 pages in 2.2 s).
- Distance is measured between the *start* of each side's occurrence; cross-mode sides (surface × root, lemma × surface) share the triple id space of the page.
- **Three-field index:** unchanged postings path — `TopDocs` ordered by `death_ah` with an overfetch of `max((limit + offset) * 50, 5000)`, positions from postings (cap 100 per side), `total_hits` a lower bound within the overfetch window.

### 8.3 Wildcard search

Surface mode only. A boolean search containing `*` in a surface-mode input is routed to `wildcardSearch` instead of `combinedSearch` (`search_type` in history stays `'boolean'`).

**Two grammars.** The engine reports which one the open index supports (`EngineCapabilities.wildcard_grammar`, Tauri `get_capabilities` / API `/health`) and the frontend validates with the same rules (`utils/wildcardValidation.ts` ⇄ `validate_wildcard_query` in `engine/src/search.rs`; strings identical):

| Grammar | Index | Rules | Error strings |
|---|---|---|---|
| `glob` | compound (corpus 4.x) | `*`-only glob, any number of `*` per word, any position: prefix `أب*`, suffix `*رف`, infix `أح*مد`, contains `*قول*`, multi-segment `مع*رف*`. Every word containing `*` needs at least 2 literal Arabic letters. Any word of a phrase may carry wildcards; each slot expands on its own. No `?`, no character classes. | "Wildcards only supported in Surface mode", "A wildcard word needs at least 2 letters besides *" |
| `legacy` | three-field (corpus ≤ 3.x) | one `*` per input; `*` not at the start of a word | + "Only one wildcard (*) allowed per search term", "Wildcard cannot be at start of word" |

`parse_wildcard_query` returns one `GlobPattern { segments, anchored_start, anchored_end }` per word (`engine/src/glob.rs`, iterative matcher) and, for the first wildcard word, `segments` / `anchored_start` / `anchored_end` plus the legacy `prefix` / `suffix` / `wildcard_type`.

**Compound backend** (`wildcard_search_with_cache` → `wildcard_compound`):

1. *Expansion.* `TripleMaps::triples_for_glob`: a pattern with a literal first segment binary-searches the surface-sorted array to that prefix range and glob-matches each surface; a pattern starting with `*` scans every surface (3M surfaces, ≈100 ms; a reversed-surface permutation was not needed). Expansions are memoized per engine (64 patterns). There is **no** distinct-word refusal.
2. *Path* by the slot sizes, threshold `WILDCARD_EXPANSION_THRESHOLD = 5,000` (`EngineConfig::wildcard_expansion_threshold`):

| Query | Path | Count |
|---|---|---|
| one word, any size (`ال*` = 355,404 words) | `TermSetQuery` (Tantivy builds an FST + bitset per segment) through `ReadingOrderCollector` | exact |
| phrase, alternations fit the regex budget (`trie_nodes ≤ 900`) | `RegexPhraseQuery` | exact |
| phrase, every slot ≤ threshold | positional walk (`intersect_n_stream` + `phrase_matcher`) | verified count, capped (§10.2) |
| phrase, a slot > threshold (`ابن ال*`) | hybrid walk: narrow slots keep positional cursors, the wide slot is the `TermSetQuery` scorer's bitset `DocSet`; co-occurring pages whose narrow slots admit a common start are verified for adjacency on the forward index (`forward::phrase_starts` with an `IdBitmap` for the wide slot) | verified count, capped (§10.2) |

3. *Highlights:* membership of each page's triple ids in the slot sets (`wildcard_highlights`, forward index), the same test the verification uses; `wildcard_match_positions` for the reader.

**Three-field backend:** unchanged — `RegexQuery` (`prefix.*` / `prefix.*suffix`) for one word, `RegexPhraseQuery` for phrases with Tantivy's 200,000-expansion cap; highlights from the token cache by surface matching (`TokenCache::wildcard_phrase_positions_batch`).

A walk-backed response carries `walk_key` and `complete`; when `complete` is false the frontend polls `get_walk_status` / `GET /search/status` (§10.2) and updates the header count in place.

**Measurements** (full compound index, warm page cache, `docs/CAPPED_WALKS_REPORT.md`): `ال*` 5,659,240 pages exact in 0.5–0.6 s (3.4 s cold); `الم*` 4,489,199 in 0.12 s; `*ية` 3,340,812 in 0.13 s; `*قول*` 2,887,779 in 0.10 s; `مع*رف*` 117,006 in 21 ms; `م*رف` 60,795 in 22 ms; `ابن ال*` first page 0.53 s then `20,000+`, page 20 from the cache 8 ms (0.4 ms once memoized); `ابو *الله` 1,447 exact in 91 ms.

**History.** 0.4.1: `stripPunctuation` removed `*` before the query reached the backend; multi-word wildcards over-fetched ×10 and verified with a 5-position cap (`ابن ال*` on the sample: 33 s, 971 instead of 2,418). 0.5.0 (2026-09-09): `RegexPhraseQuery` / triple-set phrases, patterns above 200,000 words refused. 2026-09-11 (a.m.): refusal replaced by a per-slot bitset path, 2-letter rule dropped. 2026-09-11 (p.m.): the glob grammar, threshold 5,000, and the capped/cached walk described here.

### 8.4 Name search

UI: Names tab. Up to **4 name forms**, OR-ed across forms at the UI level but sent as separate forms that the backend **ANDs** (a page must match at least one pattern of every form). Each form:

```ts
interface NameFormData {
  id: string;
  kunyas: string[];              // max 2
  nasab: string;                 // "معمر بن أحمد بن زياد"; first 3 parts used
  nisbas: string[];              // unlimited
  shuhra: string;
  allowRareKunyaNisba: boolean;  // "Include kunya + nisba"
  allowKunyaNasab: boolean;      // "Include kunya + 1st nasab"
  allowOneNasab: boolean;        // "Include 1-part nasab"
  allowOneNasabNisba: boolean;   // "Include 1-part nasab + nisba"
  allowTwoNasab: boolean;        // "Include 2-part nasab"
}
```

**Pattern generation** (`utils/namePatterns.ts`):
- Normalization: أ إ آ → ا, strip tashkil. (Narrower than the backend's `normalize_arabic`; the backend normalizes again.)
- Kunya variants: `ابو X` → `ابو X`, `ابا X`, `ابي X`.
- Nasab split on ` بن ` / ` بنت ` (female if `بنت` present), capped at 3 parts.
- Always generated: kunya + 2-part nasab (+ each nisba); kunya + 3-part nasab (+ nisba); kunya + first nasab name + nisba; kunya + "بن ..." chains; 3-part nasab alone (+ nisba); 2-part nasab + nisba.
- Checkbox-gated: kunya + nisba; kunya + first name (+ nisba); first name alone; first name + nisba; 2-part nasab alone.
- Shuhra: `المعروف ب...` and `المشهور ب...` (with `بابي` when the shuhra is a kunya).
- Every pattern is expanded with the 5 proclitics on its first word (6 forms per pattern). No cap on pattern count.
- Display patterns collapse the three kunya cases to `اب*` for the preview.
- A form is valid if shuhra is filled, or 2 of {kunya, nasab, nisba} are filled, or 1 field plus its enabling checkbox.

**Backend** (`name_search`): per form, each pattern is a `Should` clause (`PhraseQuery` or `TermQuery` on `surface_text`); each form's OR block is a `Must` clause. Always reported as `mode: surface`. Highlighting uses the union of pattern positions (cap 5 in results, 50 for the reader).

### 8.5 Variants

New in 0.4.1. Available when a completed search is a single AND input in lemma or root mode with no OR inputs, and `total_hits ≤ 5,000` (`VARIANTS_MAX_HITS`).

`get_variants(query, mode, filters)` → `VariantsResponse`:
1. `collect_all_hits` enumerates every matching `(text_id, part_index, page_id)` unscored.
2. If more than `MAX_SCANNED_HITS = 50,000` pages match, hits are uniformly strided and `was_sampled = true`.
3. For each query word, the lemma (or root) id is looked up and all `token_definitions` ids with that `lemma_id`/`root_id` become the candidate set for that position.
4. Each page's `token_ids` blob is decoded and a sliding window of the query length is matched against the candidate sets; each matching surface tuple is tallied.
5. Variants are sorted by frequency desc, then tuple asc.

The results panel switches to a Variants view. Clicking a variant re-runs it as a single surface-mode phrase search in a new tab.

### 8.6 Filters

```ts
interface SearchFilters {
  author_id?: number; genre_id?: number;
  death_ah_min?: number; death_ah_max?: number; century_ah?: number;
  book_ids?: number[];
}
```

Since 0.5.0 **every field is applied**: `book_ids` as a `Should` block of `TermQuery(text_id)` clauses, `author_id`/`genre_id`/`century_ah` as equality range queries and `death_ah_min/max` as a range query on the FAST-only numeric columns (Tantivy routes `RangeQuery` to fast fields automatically; no schema change). The frontend still only sends `book_ids` (from the Text Selection modal or a collection); date, genre and author filtering happen client-side when choosing texts (§12). Before 0.5.0 the other five fields were accepted and silently ignored.

---

## 9. Search Execution Flows

### 9.1 Term / boolean search
```
UI inputs → stripPunctuation → (surface+clitics? expand ×6 into OR) →
combined_search(and_terms, or_terms, {book_ids}, 250, offset)
  → per term: normalize by mode → PhraseQuery | TermQuery on field
  → BooleanQuery + book filter
  → TopDocs(limit+offset).order_by_u64_field("death_ah")
  → skip(offset).take(limit) → per doc: read stored fields, read postings positions (cap 5/term)
  → sort_results_by_reading_order (death_ah, id, part_index, page_id)
→ SearchResults
```

### 9.2 Proximity
See §8.2. Pure Tantivy; overfetch window `max((limit+offset)*50, 5000)`.

### 9.3 Wildcard
```
validate (UI) → stripPunctuation (currently removes *) → wildcard_search
  → validate again (Rust) → parse prefix/suffix → RegexQuery + TermQuerys
  → TopDocs((limit+offset)*10 if multi-word)
  → multi-word: verify_adjacency on ≤5 positions → manual offset/limit
  → highlight recomputed from corpus.db tokens for multi-word phrases
```

### 9.4 Name
```
NameFormData[] → generateSearchPatterns (normalize, variants, proclitics) →
name_search(forms=[{patterns}], filters) → per form OR(patterns) → AND(forms) →
TopDocs by death_ah → skip/take → reading-order sort
```

### 9.5 Result loading into the reader
```
click result → loadResultIntoTab
  → get_page_tokens(id, page_id)                     (token cache, §15)
  → if result.matched_token_indices is empty:
        name tab → get_name_match_positions(patterns)  (cap 50)
        other    → get_match_positions_combined(terms) (cap 50 per term)
  → reader renders body with highlights; first match scrolled to 1/3 height
```
Search results already carry up to 5 matched indices per term, so the re-fetch mainly serves reloaded searches and name tabs.

---

## 10. Ordering, Pagination, and Caps

### 10.1 Ordering
All search types order by `death_ah` ascending at the collector (`TopDocs::order_by_u64_field`), then apply `sort_results_by_reading_order` over the fetched page: `(death_ah else u64::MAX, id, part_index, page_id)`. Relevance scores are not used; `score` is `0.0` in search results and only nonzero for `get_page`. `search()` sorts before skipping; `combined_search`, `name_search` skip then sort within the page.

### 10.2 Pagination

| Constant | Value | Where |
|---|---|---|
| `PAGE_SIZE` | 250 | first fetch and each load-more |
| `MAX_RESULTS` | 5,000 | infinite scroll stops here |
| `EXPORT_MAX_RESULTS` | 2,000 | export re-runs the search with this limit at offset 0 |
| `VARIANTS_MAX_HITS` | 5,000 | variants button disabled above this |
| API `limit` cap | 250 | server clamps to 1–250 |
| `MAX_VERIFIED_HITS` | 20,000 | verified hits after which a walk stops (`EngineConfig::max_verified_hits`) |
| `WALK_BUDGET_MS` | 3,000 | safety budget of a walk whose candidates yield few hits |

**Plain term / boolean / regex-phrase searches** paginate through `ReadingOrderCollector` on the single reading-order segment: exact count and the requested window in one pass, O(limit) document fetches at any offset. (Multi-segment indexes fall back to `TopDocs` by `death_ah`, sized `limit + offset`.)

**Walks (`engine/src/walk.rs`)** — proximity, wide-slot phrases, wildcard phrases beyond the regex budget, and the bag-of-words boolean / name verification — produce verified hits one by one in reading order. Rules:

- A capped walk stops at `max_verified_hits` verified hits, or at `walk_budget_ms`; either sets `was_capped`. The cap is on *hits*, not time, so the same query yields the same prefix on every machine; the budget is a safety net only.
- The verified prefix (ordered hits with their positions, count, `was_capped`) is cached in an LRU keyed on `(kind, query terms and modes, filters with sorted book ids, exact flag)` — 16 entries, at most 4M cached hits in total. Every page is a slice of the prefix; "load more" never re-runs the walk. Served windows are memoized (128 pages) so a repeated page costs no doc-store read.
- The walk runs on its own thread (`kashshaf-walk`). A capped request returns once `offset + limit` hits are verified **and** an inline allowance of `WALK_INLINE_MS = 150` has passed (or the walk has finished), so a walk that reaches the cap quickly answers with the settled count (`الله ~10 root:عرف`: `20,000+` in 27 ms). A walk that takes longer (`ابن ال*`, ~1.5 s to the cap) answers early with `complete: false` and the hits verified so far; the response carries `walk_key`, and the frontend polls `get_walk_status(key)` (Tauri) / `GET /search/status?key=` (API) once after 500 ms and once more after a further 2 s, updating `total_hits` / `was_capped` / `complete` in place without touching the rows. Later pages are served from the prefix (page 20 of `ابن ال*`: 8–10 ms first time, doc-store bound; under 1 ms memoized).
- **Detached walks are bounded.** While a request is waiting on a walk it runs freely; once every requester has been answered the walk needs one of `max_concurrent_walks` permits (`EngineConfig`, default `available_parallelism() − 2`, at least 1; API: `KASHSHAF_MAX_WALKS`). A walk that gets no permit within `WALK_QUEUE_MS = 2,000` stops and marks its entry *incomplete*: pages inside the verified prefix are still served from it, a page beyond it starts a fresh walk for that query. `walks_active` / `walks_queued` are reported by `get_stats` and `/health`.
- **Prefix cache bounds.** The LRU holds at most `PREFIX_CACHE_ENTRIES = 200` walks and about `PREFIX_CACHE_BYTES = 256 MiB` of hits (32 bytes per hit plus 4 per position), whichever is hit first; eviction is LRU at insertion, so one oversized exact prefix may exceed the byte bound until the next walk is inserted. `prefix_cache_entries` / `prefix_cache_bytes` are reported by `get_stats` and `/health`. The API server's cache is shared across all clients, by design. Served windows (rows) are memoized separately (32 pages).
- **Exact counts** (`EngineConfig::exact_counts`, runtime `SearchEngine::set_exact_counts`): no cap, no budget, the request waits for completion, the count is exact, same cache (the exact flag is part of the key). Desktop: `user_settings.exact_counts` ("true"/"false", default false), read at `AppState::new`, toggled live by the `set_exact_counts` command from Menu → Settings → "Exact counts (slower, local data only)" (offline mode only). API server: always false.
- Frontend: header `{loaded} / {total}{+}` with the `+` carrying a tooltip; `handleLoadMore` keeps paging while `was_capped` even when `loaded == total`, takes the newest `total_hits`/`was_capped` from each page, and stops when a page comes back empty (`loadedAll`).

### 10.3 Highlight position caps

| Path | Cap |
|---|---|
| `search`, `combined_search` (per term, exact path), `name_search` (exact path), single-word / regex wildcard | `result_highlight_cap` (5 desktop, 20 API) per row |
| walks: proximity (positional or forward) | 100 pair positions per hit, stored in the cached prefix |
| walks: phrases (`phrase_positional_core`), bag-of-words boolean, name verification | `max(result_highlight_cap, 50)` (combined: `combined_result_cap` = 50 on the API) per hit, stored in the cached prefix |
| `get_match_positions` (single term) / phrase | 5 / 100 |
| `get_match_positions_combined` | 50 per term |
| `get_name_match_positions`, `wildcard_match_positions` | uncapped |
| API server equivalents | 20 in results, 100 for `/page/matches`, 50 for combined |

Compound-index positions come from the page's token ids (forward index); walk hits carry their positions in the cache, so a page served from the cache is byte-identical to one served by a fresh walk. Three-field positions come from Tantivy postings, except the multi-word wildcard recomputation from the token cache.

---

## 11. Token Overlay and Highlighting

**Display-to-token mapping** (`utils/arabicTokenizer.ts`) must reproduce the pipeline's tokenization exactly so that Tantivy positions and `page_tokens` indices line up with visible words.

- `stripHtml`: `<br>` → `\n`, then remove every `<...>` tag. `<title>` tag *contents* survive as plain text and count as tokens, matching the pipeline, which also keeps heading text in `surface_text`.
- Skipped for counting (mapped to `null`, do not end a word): the `PUNCT_SYMBOLS` set, Latin letters (A–Z, a–z, U+00C0–U+024F, U+1E00–U+1EFF), ASCII and Arabic-Indic digits.
- Arabic letters and tashkil (U+064B–U+065F, U+0670) map to the current token index.
- Any other character (whitespace, newline, other scripts) is a word boundary.
- `getSnippetRange` builds result snippets of about 50 tokens with the first match at most 5 tokens from the start.

**Token popup**: clicking a word looks up `tokens.find(t => t.idx === charToToken[pos])` and shows Surface, Lemma, Root, POS, Features (joined), Clitics (`display` joined). Read-only; no "search this lemma" action. Missing token definitions are rendered by the backend as placeholder tokens (surface `�`, lemma `unknown`, pos `UNK`) so indices stay aligned.

**Highlight style**: matched tokens in both reader and result rows use red (`bg-red-100 text-red-700`). The `--color-app-highlight-{surface,lemma,root}` tokens and `.highlight-*` classes in `index.css` are defined but unused; there is no per-mode highlight colour.

---

## 12. Text Selection and Collections

### 12.1 Text selection
The **Select Texts** modal filters the in-memory book list (from `BooksContext`) by death range, genre (multi-select), collection (multi-select, OR between collections, AND with other filters), and an Arabic-normalized title-or-author search. "Select Showing" adds the filtered set; the selection is applied live as `book_ids` on every search. The sidebar shows the selected count or "All".

### 12.2 Collections
Named, persistent sets of book ids. Desktop: `collections` table in `settings.db`; web: `kashshaf_collections` in localStorage. Names are unique (case-insensitive check in the UI, `UNIQUE` in SQLite); descriptions are truncated to 150 characters.

Commands: `create_collection(name, book_ids, description)`, `get_collections()`, `update_collection_books(id, book_ids)`, `update_collection_description(id, description)`, `rename_collection(id, name)`, `delete_collection(id)`.

Flows: sidebar save icon → SaveCollectionModal (name + description); Collections modal → click row → TextSelectionModal in `edit-collection` mode (Update enabled only when the selection changed); Collections modal → Create → `create-collection` mode.

---

## 13. Reader and Citations

### 13.1 Navigation (`hooks/useReaderNavigation.ts`)
- **Prev/Next**: `page_id ± 1` within the current `part_index` via `get_page` + `get_page_tokens`. If the page does not exist the reader stays put silently. Navigation **does not cross part boundaries** and always clears highlights (`matchedTokenIndices = []`).
- **Vol:page jump**: `get_page_by_label(id, part_label, page_number)` does a term lookup on the stored `part_label`/`page_number` fields; this can jump across parts. Errors surface as toasts ("Page 2:45 not found in this text").
- The volume input is hidden when `books.parts == 1`.
- Page ids are unique within a book (the token cache key is `(id, page_id)` and the variants query omits `part_index`), a consequence of the "global page indices" change in 0.2.3.

### 13.2 Citations (`utils/citation.ts`, `CitationBlock`)
- Source: `books.citation_json` → `CitationData { title, authors[], editors[], translators[], arrangers[], place, publisher, date, edition, volumes, warnings[] }`.
- **Chicago**: `Authors. <em>Title</em>. Edited by …. Translated by …. Arranged by …. Edition. Place: Publisher, Date. Vol. X, p. Y.`
- **MLA**: `Authors. <em>Title</em>, edited by …, translated by …, arranged by …, edition, publisher, date. Vol. X, p. Y.` (MLA omits place.)
- Page reference only when `withPageRef` **and** `book.paginated === true`. Otherwise a warning explains that volume and page were omitted because Kashshaf pagination does not match a printed edition.
- Copy strips `<em>` and writes plain text to the clipboard.
- Also shown, without page reference, in the metadata browser's book detail view.

---

## 14. Corpus Distribution, Updates, Announcements

### 14.1 CDN endpoints (`downloader.rs`, `utils/announcements.ts`)
| URL | Content |
|---|---|
| `https://cdn.kashshaf.com/corpus_manifest.json` | `{corpus_version, schema_version, min_app_version, built_at, files[{name, hash, size}]}` |
| `https://cdn.kashshaf.com/<file.name>` | Corpus files (`corpus.db`, `tantivy_index/...`) |
| `https://cdn.kashshaf.com/app_manifest.json` | `{latest_version, min_supported_version, releases[{version, released_at, required, notes, downloads{windows, macos, linux}}]}` |
| `https://cdn.kashshaf.com/announcements.json` | `{schema_version: 1, announcements[]}` |

### 14.2 Corpus status and download
- `check_corpus_status()` fetches the remote manifest. If unreachable, it reports ready when the local manifest is complete or the essential files exist, with an `error` string. `update_required` = schema version changed or app below `min_app_version`; `update_available` = corpus version changed.
- `start_corpus_download(skip_verify)` streams each missing file with a 300 s client timeout, writes `data_dir/<name>`, verifies size and (unless skipped) SHA-256, and persists per-file `complete` flags to `manifest.local.json`. Files not in the new manifest are deleted afterwards. **No resume**: a partial file is re-downloaded from scratch.
- Progress is emitted per chunk on the window event `download-progress` with `DownloadProgress { current_file, file_bytes_downloaded, file_total_bytes, overall_bytes_downloaded, overall_total_bytes, files_completed, files_total, state }`, `state ∈ starting | downloading | verifying | completed | failed | cancelled`.
- `cancel_corpus_download()` uses a process-global watch channel and deletes the partial file.
- The Download modal defaults verification **off** ("Verify downloaded files (slower)" unchecked).

### 14.3 App updates
`check_app_update()` compares `CARGO_PKG_VERSION` with the app manifest. `update_required` when current < `min_supported_version` or any newer release has `required: true`; `update_available` when current < `latest_version`. Fetch failures return an all-current status. The toolbar runs this on startup (desktop only), shows a blocking modal for required updates, and honours `skip_app_update_prompt` for optional ones. The native menu's "Check for Updates" resets that flag. The Update button opens the platform download URL via the shell plugin.

### 14.4 Delete local data
Native menu → DeleteDataModal → `delete_local_data()`: sets `AppState = None`, deletes `corpus.db`, `tantivy_index/`, `manifest.local.json`. Keeps `settings.db` and `metadata.db`. The `onDataDeleted` callback is not wired in `App.tsx`, so the UI does not switch to online mode until restart.

### 14.5 Announcements
Fetched via Rust `fetch_announcements()` (desktop, 5 s timeout) or browser `fetch` (web), cached for 1 hour. Eligibility (`getEligibleAnnouncements`): target platform, `starts_at ≤ now ≤ expires_at`, semver range (skipped on web), and dismissal rules: `forced` always shows; `important` respects per-id dismissal when `show_once`; `normal` also respects the global `skip_announcement_popups`. Shown in one digest modal after the download phase resolves. Announcement bodies support `**bold**` and `[text](url)` and are injected without sanitization. Authored with `scripts/generate_announcement.py`.

---

## 15. Caching

### Token cache (Rust, `cache.rs`)
- `LruCache<PageKey{id, page_id}, Arc<Vec<Token>>>`, capacity **1,000 pages** (`DEFAULT_CACHE_CAPACITY`).
- Miss: open `corpus.db`, read `token_ids`, batch-resolve definitions in chunks of 500 ids (SQLite 999-variable limit), map through in-memory lookup tables.
- Same design in the API server. Connections are opened per call; there is no pool.

### Books cache (frontend)
`BooksContext` loads `getAllBooks`, `getAuthors`, `getGenres` once per API instance and exposes `booksMap`, `authorsMap`, `genresMap`. Search results carry only ids; every title/author shown in the UI is resolved here.

### Announcements cache
1 hour, in `user_settings` (desktop) or localStorage (web); stale cache is used on fetch failure.

---

## 16. Frontend Architecture

### 16.1 Providers and state
`main.tsx`: `OperatingModeProvider` → `SearchTabsProvider` → `App`; `App` mounts `BooksProvider api={api}`. `ModalQueueContext` (priority-ordered startup modals) is fully implemented but not mounted; `App.tsx` uses individual booleans.

**SearchTab** (per executed search):
```ts
interface SearchTab {
  id: string; label: string; fullQuery: string; tabType: 'terms' | 'names';
  searchResults: SearchResults | null; loading: boolean; loadingMore: boolean; errorMessage: string;
  currentPage: PageData | null; pageTokens: Token[]; matchedTokenIndices: number[];
  currentBookId: number | null; currentPartIndex: number; currentPageId: number;
  searchContext: SearchContext;   // { type: 'combined'|'proximity'|'name'|'wildcard', ... }
}
```
No maximum tab count. Closing the active tab activates the one to its left.

**App-level state:** `appSearchMode: 'terms' | 'names'`, `selectedBookIds: Set<number>`, `splitterRatio` (localStorage, default 0.6), `helpOpen`, modal booleans, `collections`, `corpusStatus`, `announcements`.

### 16.2 SearchAPI interface (`src/api/index.ts`)
```ts
interface SearchAPI {
  search(query, mode, filters, limit, offset): Promise<SearchResults>;
  combinedSearch(combined: CombinedSearchQuery, filters, limit, offset): Promise<SearchResults>;
  getVariants(query, mode, filters): Promise<VariantsResponse>;
  proximitySearch(term1, field1, term2, field2, distance, filters, limit, offset): Promise<SearchResults>;
  nameSearch(forms: NameSearchForm[], filters, limit, offset): Promise<SearchResults>;
  wildcardSearch(query, filters, limit, offset): Promise<SearchResults>;
  getPage(id, partIndex, pageId): Promise<SearchResult | null>;
  getPageByLabel(id, partLabel, pageNumber): Promise<SearchResult | null>;
  getPageTokens(id, partIndex, pageId): Promise<Token[]>;
  getMatchPositions(id, partIndex, pageId, query, mode): Promise<number[]>;
  getMatchPositionsCombined(id, partIndex, pageId, terms: SearchTerm[]): Promise<number[]>;
  getNameMatchPositions(id, partIndex, pageId, patterns: string[]): Promise<number[]>;
  getAllBooks(): Promise<BookMetadata[]>;
  getAuthors(): Promise<[number, string][]>;
  getGenres(): Promise<[number, string][]>;
}
```

**OfflineAPI vs OnlineAPI:**
| Aspect | OfflineAPI | OnlineAPI |
|---|---|---|
| Transport | `invoke()` via `api/tauri.ts` | `fetch` to hardcoded `https://api.kashshaf.com` (`VITE_API_URL` is not read) |
| `getMatchPositionsCombined` | one command | one `/page/matches` call per term, unioned |
| `getNameMatchPositions` | one command | one `/page/matches` call **per pattern** (can be hundreds) |
| Timeouts | n/a | none |
| Errors | Tauri rejection string | `Error(errorData.error ?? 'HTTP <status>')`; `getPage*` return `null` |

History, saved searches, settings, collections, download, update, and announcements are not part of `SearchAPI`; they are loose functions in `api/tauri.ts` routed through `utils/storage.ts` and `utils/collections.ts`, which fall back to localStorage on web.

### 16.3 Hooks
- `useSearch`: `handleSearch` (boolean, routes to wildcard when applicable), `handleProximitySearch`, `handleNameSearch`, `handleLoadMore` (appends at `offset = current length`, stops at `MAX_RESULTS` or `total_hits`), `handleExportResults` (re-fetch with limit 2,000), `handleResultClick`. Writes history after successful searches.
- `useSearchTabs`: tab CRUD; context value.
- `useReaderNavigation`: §13.1.

---

## 17. Backend Surfaces

### 17.1 Tauri commands (55, all registered in `main.rs`)

Every command returns `Result<T, KashshafError>`; errors serialize as plain strings. Corpus-dependent commands return `CorpusNotReady` when `AppState` is `None`. Frontend passes camelCase argument names; Tauri maps to snake_case.

**Search**
```rust
search(query, mode?, filters?, limit?=50, offset?=0) -> SearchResults
combined_search(and_terms, or_terms, filters?, limit?, offset?) -> SearchResults
proximity_search(term1, field1: TokenField, term2, field2, distance, filters?, limit?, offset?) -> SearchResults
name_search(forms: Vec<NameSearchForm{patterns}>, filters?, limit?, offset?) -> SearchResults
wildcard_search(query, filters?, limit?, offset?) -> SearchResults
get_variants(query, mode?, filters?) -> VariantsResponse
count_all_hits(query, mode?, filters?) -> CountAllHitsResponse   // debug parity check, unused by UI
```
**Pages**
```rust
get_page(id, part_index, page_id) -> Option<SearchResult>
get_page_by_label(id, part_label, page_number) -> Option<SearchResult>
get_page_with_matches(id, part_index, page_id, query, mode) -> Option<PageWithMatches>
get_match_positions(id, part_index, page_id, query, mode) -> Vec<u32>
get_match_positions_combined(id, part_index, page_id, terms) -> Vec<u32>
get_name_match_positions(id, part_index, page_id, patterns) -> Vec<u32>
get_page_tokens(id, page_id) -> Vec<Token>
get_token_at(id, page_id, idx) -> Option<Token>
```
**Metadata (`metadata.db`)**
```rust
get_all_books() -> Vec<BookMetadata>                 // ORDER BY death_ah NULLS LAST, id
list_books(genre_id?, corpus?, century_ah?, limit?=100, offset?=0) -> Vec<BookMetadata>
list_books_filtered(death_ah_min?, death_ah_max?, genre_ids?, limit?=10000, offset?) -> Vec<BookMetadata>
get_book(id) -> Option<BookMetadata>
search_authors(query) -> Vec<(author_id, author, earliest_death_ah, book_count)>  // ≥3 bytes, max 50
get_genres() -> Vec<(id, genre)>      get_authors() -> Vec<(id, author)>
get_centuries() -> Vec<(century_ah, count)>
get_stats() -> { indexed_pages, total_books, token_cache_size, token_cache_capacity }
```
**History and saved searches (`settings.db`)**
```rust
add_to_history(search_type, query_data, display_label, book_filter_count, book_ids?) -> i64
get_search_history(limit?=100) -> Vec<SearchHistoryEntry>      clear_history()
save_search(history_id?, search_type, query_data, display_label, book_filter_count, book_ids?) -> i64
unsave_search(id)    unsave_search_by_query(query_data)    is_search_saved(query_data) -> bool
get_saved_searches(limit?=100) -> Vec<SavedSearchEntry>
```
**Collections**: `create_collection`, `get_collections`, `update_collection_books`, `update_collection_description`, `rename_collection`, `delete_collection` (§12.2).

**Settings**: `get_app_setting(key)`, `set_app_setting(key, value)`, `get_user_setting(key)`, `set_user_setting(key, value)`.

**Corpus and data**: `check_corpus_status`, `start_corpus_download(window, skip_verify?)`, `cancel_corpus_download`, `get_data_directory`, `archive_old_corpus(version)`, `reload_app_state -> bool`, `corpus_exists -> bool`, `delete_local_data -> u32`.

**Other**: `check_app_update -> AppUpdateStatus`, `fetch_announcements -> AnnouncementsManifest`, `show_app_menu(x, y)`, `get_cache_stats -> (len, cap)`, `clear_token_cache`.

**Native menu events** emitted app-wide: `check-for-updates`, `delete-local-data`; `quit` exits.

### 17.2 Online API server (`api/`)

18 routes on axum over the shared `kashshaf-engine` crate. Errors: `{"error": "..."}` with 400 (wildcard validation, surface-mode variants), 404 (`/search/status` for an unknown key), 429 (rate limit) or 500.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `status, version, index_docs, segments, reading_order, corpus_version, db_schema_version, max_supported_db_schema, max_limit, wildcard_grammar, exact_counts (always false), max_verified_hits, walks_active, walks_queued, max_concurrent_walks, prefix_cache_entries, prefix_cache_bytes, rss_mb, peak_rss_mb, private_mb` |
| GET | `/search/status` | `key` (a `SearchResults.walk_key`) → `{verified_hits, was_capped, complete, incomplete}`; 404 once the walk has left the prefix cache |
| GET | `/search` | `q`, `mode?=lemma`, `limit?=50` (1–250), `offset?`, `book_ids?` CSV |
| POST | `/search/combined` | `{and_terms, or_terms, filters?, limit?, offset?}` |
| POST | `/search/proximity` | `{term1, term2, distance, filters?, limit?, offset?}` — a capped walk on the compound index (§10.2) |
| POST | `/search/name` | `{forms[{patterns}], filters?, limit?, offset?}` |
| POST | `/search/variants` | `{query, mode?, filters?}` → `VariantsResponse` (surface mode → 400) |
| GET | `/search/wildcard` | `q`, `limit?`, `offset?`, `book_ids?`; grammar per `/health.wildcard_grammar` (§8.3) |
| GET | `/page` | `id`, `part_index` (default 0 for pre-0.5.0 clients), `page_id` → `SearchResult \| null` |
| GET | `/page/by-label` | `id`, `part_label`, `page_number` |
| GET | `/page/tokens` | `id`, `part_index` (default 0), `page_id` → `Token[]` |
| GET | `/page/matches` | `+ q`, `mode?` → `u32[]` (cap 100) |
| GET | `/page/with-matches` | → `PageWithMatches` |
| POST | `/page/matches/combined` | `{id, part_index, page_id, terms}` |
| POST | `/page/matches/name` | `{id, part_index, page_id, patterns}` |
| GET | `/books` | full `books` table, no pagination |
| GET | `/authors` | `[[id, author], ...]` |
| GET | `/genres` | `[[id, genre], ...]` |

Walk-backed search responses (`/search/proximity`, wildcard phrases beyond the regex budget, verified boolean and name searches) carry `walk_key` and `complete`; `total_hits` is a lower bound whenever `was_capped` is true (§10.2).

Configuration (environment): `KASHSHAF_DATA_DIR` (default `/opt/kashshaf/data`), `KASHSHAF_BIND` (`127.0.0.1:3000`), `KASHSHAF_MAX_WALKS` (detached walks running at once; default `available_parallelism() − 2`), `KASHSHAF_RATE_LIMIT` (unset/`0`/`off`: no in-process limit; `1`: 10 requests/s with a burst of 30 per client IP; `<per_second>[,<burst>]` otherwise; `tower_governor` with `SmartIpKeyExtractor`, so `X-Forwarded-For` / `X-Real-IP` from the proxy are honoured; violations get 429 `{"error": "rate limit exceeded; retry in N s"}`), `KASHSHAF_WARM_CACHE=1` (a background thread reads `tantivy_index/*` and `corpus.db` once at startup and logs the volume and time — 8.3 GiB in 9.7 s on the full corpus — without blocking readiness).

Differences from the desktop engine: `EngineConfig::api_server()` — result highlight caps 20 (not 5), combined results truncated to 50 indices, `exact_counts` always false. CORS is fully open. Handlers do blocking work on tokio worker threads; walks run on their own threads.

Deployment: `.github/workflows/deploy-api.yml` SSHes to the server on any push touching `api/**` (it should also watch `engine/**`, see RELEASE_STREAMLINING.md), runs `git pull`, `cargo build --release`, and `systemctl restart kashshaf-api`. The systemd unit and reverse proxy config are not in the repo; the proxy provides TLS and its own rate limiting.

### 17.3 API spec drift
`docs/KASHSHAF_API_SPEC.md` needs these corrections:
- Missing routes: `/search/variants`, `/page/by-label`, `/page/with-matches`, `/page/matches/combined`, `/page/matches/name`, `/authors`, `/genres`.
- `SearchResult` no longer has `corpus`, `author`, `title`, `genre`; it has `genre_id`. `score` is always `0.0` in search results. `body` is omitted when empty.
- `/page/tokens` clitics are `{type, display}` objects, not strings.
- `/books` returns 18 fields with no `author`/`genre` names.
- Rate limit "10 req/s, burst 30" is not enforced by the server process.
- Errors are always 500, never 400/429.

---

## 18. Key Data Structures (wire format)

All Rust structs serialize with snake_case field names. Enums `SearchMode`/`TokenField` serialize as lowercase strings.

```ts
interface Token { idx: number; surface: string; noclitic_surface?: string;  // always null in practice
                  lemma: string; root?: string; pos: string; features: string[];
                  clitics: { type: string; display: string }[]; }

interface SearchResult { id: number; part_index: number; page_id: number;
                         author_id?: number; genre_id?: number; death_ah?: number; century_ah?: number;
                         part_label: string; page_number: string; body?: string;
                         score: number; matched_token_indices: number[]; }

interface SearchResults { query: string; mode: SearchMode; total_hits: number;
                          results: SearchResult[]; elapsed_ms: number; }

interface PageWithMatches { id: number; part_label: string; page_number: string;
                            body: string; matched_token_indices: number[]; }

interface Variant { surface_tuple: string[]; freq: number; }
interface VariantsResponse { variants: Variant[]; total_hits: number; scanned_hits: number;
                             was_sampled: boolean; elapsed_ms: number; }

interface BookMetadata { id: number; corpus?: string; title: string; author_id?: number;
                         death_ah?: number; century_ah?: number; genre_id?: number;
                         page_count?: number; token_count?: number; original_id?: string;
                         paginated?: boolean; tags?: string; book_meta?: string; author_meta?: string;
                         in_corpus?: boolean; parts?: number; metadata_json?: string; citation_json?: string; }

interface SearchHistoryEntry { id: number; search_type: 'boolean'|'proximity'|'name'|'wildcard';
                               query_data: string; display_label: string; book_filter_count: number;
                               book_ids?: string; created_at: string; is_saved: boolean; }
interface SavedSearchEntry   { id: number; history_id?: number; search_type: ...; query_data: string;
                               display_label: string; book_filter_count: number; book_ids?: string;
                               created_at: string; }

interface Collection { id: number; name: string; description: string | null;
                       book_ids: number[]; created_at: string; updated_at: string; }

interface CorpusStatus { ready: boolean; local_version: string|null; remote_version: string|null;
                         update_available: boolean; update_required: boolean;
                         missing_files: string[]; total_download_size: number; error: string|null; }
interface AppUpdateStatus { current_version: string; latest_version: string; min_supported_version: string;
                            update_required: boolean; update_available: boolean;
                            release_notes?: string; download_url?: string; }

interface Announcement { id: string; title: string; body: string; body_format: 'text'|'markdown';
                         type: 'info'|'warning'|'critical'; priority: 'normal'|'important'|'forced';
                         target: 'all'|'desktop'|'web'; min_app_version: string|null; max_app_version: string|null;
                         starts_at: string; expires_at: string|null; dismissible: boolean; show_once: boolean;
                         action: { label: string; url: string } | null; }
```

Rust `PageKey { id: u64, page_id: u64 }` (no `part_index`). `KashshafError` variants: `Search`, `Index`, `Database`, `NotFound` (unused), `InvalidQuery` (unused), `Download`, `Network`, `CorpusNotReady`, `Other`.

---

## 19. Export

- **Search results**: Book ID, Title, Author, Death Year (AH), Volume, Page, Context (body stripped of HTML, first 500 chars). Up to 2,000 rows, re-fetched from offset 0.
- **Texts**: ID, Title, Author, Author ID, Death Year (AH), Century (AH), Genre, Genre ID, Page Count, Token Count, Corpus, Original ID, Paginated, Citation JSON. Exports the currently filtered list.
- **Authors**: Author, Author ID, Death Year (AH), Book Count, Total Pages, Genres.
- CSV with UTF-8 BOM; XLSX via SheetJS. Desktop saves through the Tauri dialog and fs plugins; web triggers a browser download. Filenames `search_results_YYYY-MM-DD`, `texts_metadata_...`, `authors_metadata_...`.

---

## 20. Release Process

Summarized from [RELEASE_REF.MD](RELEASE_REF.MD) and `scripts/release.py`:
1. `python scripts/release.py X.Y.Z [--min-supported-version A.B.C]` on a clean `main`: bumps `src-tauri/Cargo.toml`, `api/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json`; prepends a release to `scripts/manifests/app_manifest.json`; commits `vX.Y.Z release`; tags and pushes.
2. `release.yml` builds Windows MSI, Linux AppImage+deb, and a signed, notarized macOS universal DMG (`Kashshaf_X.Y.Z_macos.dmg`) and creates a **draft** GitHub release.
3. Publish the release, then upload `app_manifest.json` to R2.
4. API changes deploy automatically on push to `main` under `api/`.
5. Corpus updates: upload files and a new `corpus_manifest.json` to R2; bump `schema_version` to force re-download, `min_app_version` to gate old apps.

Version history: 0.1.0 (2026-01-05) → 0.2.0 full corpus (01-10) → 0.2.2 collections → 0.2.3 global page ids → 0.3.0 vol:page navigation, metadata.db, reading-order sort (required update, 2026-05-06) → 0.4.0 citations, metadata cleanup, sortable browsers → 0.4.1 lemma variants (2026-05-08).

---

## 21. Performance Targets

Measured on the full compound index (5,711,710 pages), release build, warm page cache, 2026-09-11 (`engine/bench/reports/capped-full-compound-v2.json`, `api-concurrency-*.json`; details in CAPPED_WALKS_REPORT.md). "First" is a cold walk in a fresh process, "cached" a later request for the same query.

| Operation | Target | Measured |
|---|---|---|
| Term / boolean search | <100 ms | 4–17 ms on the sample; exact counts through `ReadingOrderCollector` |
| Proximity, single words (walk) | <300 ms first page | `الله ~10 root:عرف` 34 ms first (234 ms cold cache), `20,000+` settled in the response; page 20 9 ms first, <1 ms cached; exact mode `الله ~10 lemma:قال` 2,447,865 hits in 2.5 s |
| Proximity, phrase side (forward walk) | <1 s first page | 16 distinct `قال ~d "رسول الله"` walks at once: first window p50 331 ms, p95 471 ms |
| Wildcard, single word | <1 s | `ال*` 672 ms (3.4 s cold), `الم*` 139 ms, `*ية` 141 ms, `*قول*` 103 ms, `مع*رف*` 25 ms, `م*رف` 27 ms — all exact |
| Wildcard phrase (walk) | <1 s first page | `ابن ال*` 583 ms first (`complete: false`, settles to `20,000+` within ~1.5 s), page 20 10 ms first, <1 ms cached; `ابو *الله` 1,447 exact in 180 ms |
| 16 concurrent proximity requests (API, 6 permits) | first window <500 ms, `/health` and `/page` <20 ms | same query: p50 43 ms, p95 51 ms, one walk, `/health` ≤ 7 ms, `/page` ≤ 14 ms; 16 distinct distances: p50 95 ms, p95 107 ms, `/health` ≤ 39 ms, `/page` ≤ 33 ms; 16 distinct phrase walks (queue peak 10): `/health` ≤ 127 ms, `/page` ≤ 181 ms while the CPU is saturated |
| Name search | <300 ms | 2–4 ms on the sample (walk when verification is needed) |
| Variants | seconds | Bounded by 50,000 scanned pages |
| Token overlay | <1 ms cached, 5–15 ms miss | LRU 1,000 pages |
| Page load | <200 ms | 250 rows from the doc store ≈ 8–10 ms |
| Startup | <8 s | 3–7 s: triple maps ≈ 2.3 s, index open/verify ≈ 0.2 s, the rest page-cache misses; `KASHSHAF_WARM_CACHE=1` reads 8.3 GiB in ~10 s in the background |
| Memory (API, full corpus) | <1 GiB private | 389 MiB private after open (188 MB triple maps); +23 MiB for `ابن ال*`; exact `الله ~10 قال` +280 MiB while cached; working set up to 1.1 GiB because mmapped postings pages are counted |

Online mode adds network latency; requests are limited to 250 rows and, when `KASHSHAF_RATE_LIMIT` is set, to 10 requests/s (burst 30) per client IP.

---

## 22. Known Issues and Spec Corrections

Items found while reconciling this specification with the v0.4.1 code. None are fixed by this document.

**Functional**
1. `stripPunctuation` strips `*`, so wildcard queries reach the backend as plain surface terms (§8.3).
2. Only `book_ids` is applied from `SearchFilters`; the other five fields are ignored in both backends (§8.6).
3. Online load-more requests 250 but the API clamps to 100, so online result lists skip rows (§10.2).
4. Surface AND terms with the clitic toggle are converted to OR terms, weakening the AND semantics (§7).
5. `proximity_search.total_hits` is a lower bound within the overfetch window (§8.2). *Compound index, 2026-09-11: exact below `MAX_VERIFIED_HITS` (20,000 verified hits) or with the Exact counts setting; the three-field path is unchanged.*
6. Reader prev/next cannot cross part boundaries and silently no-ops at the edge (§13.1).
7. `DeleteDataModal` → `onDataDeleted` is never passed by `App.tsx`; the app stays offline after deleting data until restart (§14.4).
8. Loading a name search from history fires with the previous form state because of a `setTimeout(0)` closure (`App.tsx handleLoadSearch`).
9. `OnlineAPI.getNameMatchPositions` issues one request per pattern.
10. `Token.noclitic_surface` is always `null`.

23. **Capped walks (2026-09-11).** With the cap at 20,000 verified hits, a phrase such as `ابن ال*` (true count 665,983) shows `20,000+`; Exact counts is the way to the real total (2.2–2.5 s for `الله ~10 قال`, 2.4M hits, +280 MB of heap while cached). *Follow-up the same day:* a first page now waits up to 150 ms for the walk to settle, so only walks slower than that (`ابن ال*`) return an intermediate count, flagged `complete: false` and corrected by the status poll within 0.5–2.5 s.
25. **`/health` latency under saturating walks.** With 16 distinct phrase walks started at once on a 12-thread machine (6 permits, queue peak 10), `/health` and `/page` rose to 127 ms and 181 ms while the CPU was saturated; under the intended load (many clients sharing a few queries) they stay under 20 ms. Lowering the walk threads' priority would keep the cheap endpoints responsive; not done.
24. Wildcard grammars differ by index kind (§8.3); the frontend defaults to `glob` until `get_capabilities` / `/health` answers, so on a three-field index a glob-only pattern typed before that moment is rejected by the engine with the legacy message instead of inline.

**Data / distribution**
11. The `corpus_manifest.json` copy in `scripts/manifests/` is stale and omits `metadata.db` (§6.1).
12. `settings.db` lives in the corpus data directory, contrary to the comment in `state.rs`; `archive_old_corpus` moves it (§6.2).
13. `db_info` is the version table the app reads; CORPUS_DATA_MODEL.md documents `corpus_builds`.

**API**
14. `KASHSHAF_API_SPEC.md` drift (§17.3); no rate limiting in process; all errors are 500.
15. `/health` does not report the server version.

**Code hygiene**
16. `ModalQueueContext`, `BooksModal`, `AnnouncementModal` are unused; `BooksModal` imports `api/tauri` directly and would break the web build if rendered.
17. `CombinedSearchQuery`/`SearchInput` are declared three times; `isWebTarget` exists as both a function and a const.
18. `normalize_arabic` is duplicated three times in Rust.
19. `vite.config.ts` `outDir` ternary is dead; no script uses `--mode web`, so `.env.web` is never loaded (the URL is hardcoded anyway).
20. `[TokenDebug]` console logging ships in `ReaderPanel`.

**Corrections to the v3.1 specification**
- API server is Rust/axum, not Python/FastAPI.
- No `noclitic_surface_text` field; no noclitic mode.
- Proximity is Tantivy-only; there is no SQLite verification phase.
- Result ordering is by author death year, not relevance.
- Search results do not carry `author`, `title`, `genre`, `corpus` strings.
- Metadata comes from `metadata.db`, not `corpus.db`; user data lives in `settings.db`.
- Storage is ~18 GB, not 8.2 or 12.3 GB.
- Tailwind is v4 with `@theme`, not v3 with `tailwind.config.js`.
- There is a web build; "desktop-only" is no longer accurate.
- The Tantivy index is built by a Rust indexer, not `ingest_to_index.py`.
- Corpus scope is authors who died before 1930 CE, not ≤1500 CE.

---

## 23. Design Principles

1. **Body is the source of truth for display**: the stored `body` keeps tashkil and `<title>` tags; search fields are normalized copies.
2. **One position space**: whitespace tokenization everywhere keeps Tantivy positions, `page_tokens` indices, and visible words aligned.
3. **Ids on the wire, names in the client**: results and pages carry `author_id`/`genre_id`; `BooksContext` resolves them.
4. **Same data, two hosts**: desktop backend and API server read identical artifacts with near-identical code.
5. **Offline first, online fallback, web as a thin client**.
6. **Reading order over relevance**: results are chronological by author death, then by book, volume, page.
7. **Reproducible research**: automatic history, explicit saved searches, collections, citations, and CSV/Excel export.
8. **Linguistic precision over fuzziness**: no stemming, no fuzzy matching; lemma and root come from CAMeL Tools.

---

## 24. Roadmap Pointers

- [REPORT.md](REPORT.md) and [REPORT_IMPLEMENTATION_PLAN.md](REPORT_IMPLEMENTATION_PLAN.md): Phase A and Phase B code is complete in 0.5.0 (§25); the full-corpus 3.0.0 / 4.0.0 builds and their benchmarks are the remaining steps ([BUILD_CORPUS.md](BUILD_CORPUS.md)).
- Deferred: `triples.bin` sidecar (only if full-corpus startup exceeds ~1.5 s); frontend UI for the now-working date/genre/author filters.

---

## 25. Addendum — app 0.5.0 (2026-09-09)

This version is described in full in [changelog.md](changelog.md). Where it changes statements above:

**Architecture (§2, §4, §5).** New crate `engine/` (`kashshaf-engine`) shared by `src-tauri` and `api`; `src-tauri/src/{search,cache,variants,tokens}.rs` and `api/src/{search,cache,tokens,variants,error}.rs` are gone. Modules: `search` (engine, `EngineConfig`, `IndexKind`), `collectors` (`AllDocsCollector`, `ReadingOrderCollector`), `blob` (blob codec), `cache` (`TokenCache` with id and token LRUs, batched fetch), `corpus_db` (schema gating), `triples` (`TripleMaps`), `forward` (forward-index scans), `variants`, `normalize`, `tokens`. `engine/src/bin/bench.rs` + `engine/bench/` hold the benchmark and parity harness. Both hosts are on Tantivy 0.25 with the `zstd-compression` feature.

**Data files (§6).** The engine reads `corpus.db` schema 1–4 (`db_info.schema_version`; refuses newer) and two index kinds: *three-field* (`surface_text`/`lemma_text`/`root_text`, corpus ≤ 3.x) and *compound* (`tokens` field of zero-padded triple ids, corpus 4.x; optional `root_text` without positions as the root hedge). `page_tokens.encoding` 1 (raw u32) and 2 (ranked LEB128 + dictionary zstd, via `token_codec`) are both decoded. Schema 4 adds `triples` and `token_definitions.triple_id` (see CORPUS_DATA_MODEL.md "Schema v3" and "Schema v4"). `TokenCache::new` now returns a `Result` instead of panicking.

**Search execution (§8–§10).** One `IndexReader` per process. On a single-segment index verified at startup to be in reading order, pagination uses `ReadingOrderCollector` (exact count and window in one pass, O(limit) document fetches; deep offset 4,750 went from 27 ms to 4 ms on the sample); otherwise the `TopDocs`-by-`death_ah` path remains. Compound indexes translate each query word to a set of triple ids (`TermSetQuery`; phrases use `RegexPhraseQuery` while the alternation's prefix trie fits the FST's 1000-state budget, else bag-of-words plus forward-index verification with a 20,000-candidate cap (`PROXIMITY_MAX_VERIFY`) and `was_capped`). Proximity on compound indexes measures distance on the page's token ids (exact, all pairs) and highlights every match; on three-field indexes the postings path with its 100/50 caps remains. Name search and wildcard follow the same rules. Filters: §8.6. The `search()` phrase-vs-term decision is by word count (the `HashSet` bug is gone).

**Highlighting (§10.3, §11).** Compound mode: exact positions from the forward index for result rows (capped per `EngineConfig`, 50 in combined) and uncapped for the reader. Three-field mode: unchanged postings path, but `get_match_positions` uses the 100 cap for single terms too. Wildcard highlights in both modes come from the token cache (`wildcard_phrase_positions_batch`). Note the `root_text` position drift (§22 item 21): three-field root highlights remain approximate on pages with null-root tokens.

**API (§17.2, §17.3).** `limit` clamped 1–250; `/health` reports `version`, `segments`, `reading_order`, `corpus_version`, `db_schema_version`, `max_supported_db_schema`, `max_limit`; wildcard validation and surface-mode variants return 400; data dir and bind address via `KASHSHAF_DATA_DIR` / `KASHSHAF_BIND`; `SearchResults.was_capped`. `docs/KASHSHAF_API_SPEC.md` was rewritten to match.

**Frontend.** `sanitize.ts` keeps `*`; `SearchResults.was_capped?: boolean`; `ResultsPanel` shows a lower-bound banner when set. No other UI change.

**§22 status.** Fixed: 1 (wildcard `*`), 2 (filters), 3 (API page size), 5 (proximity count is exact on compound indexes below the cap), 9 is unchanged (online name-match fan-out), 14 (spec rewritten; rate limit still proxy-side), 15 (`/health` version), 18 (`normalize_arabic` single copy). New: 21. `root_text` in the three-field index omits tokens with null roots (PIPELINE.md "roots (nulls dropped)"), so its positions are shifted on ~9% of pages and root-mode highlights/proximity from postings were misplaced there in every release up to 0.4.1; compound-mode forward highlighting is unaffected. 22. **Corrected 2026-09-11:** `page_id` is *not* unique within a book — 45 books restart numbering per part (28,846 colliding pairs). `PageKey` is now `{id, part_index, page_id}`, `get_page_tokens`/`get_token_at` take `part_index`, and `/page/tokens` requires it; until this fix the overlay, variants and forward highlighting could show the wrong part's tokens in those books.

**Proximity (2026-09-11, PROXIMITY_REGRESSION_REPORT.md).** Compound indexes default to a positional intersection on the `tokens` postings (`ProximityImpl::Positional`): exact counts and positions, cost proportional to the rarer side, 1.5 s budget then `was_capped`. Wide-alternation compound phrases use the same machinery for exact counts. The streaming forward path (`ProximityImpl::Forward`, cap `PROXIMITY_MAX_VERIFY = 20,000`) remains for phrase-sided proximity. Three-field indexes keep the postings path, which on a single merged segment costs 110–220 µs per candidate (1.4–2.9 s for common pairs) — the regression measured on the desktop; a cursor-reuse fix is recommended there.

**End of Specification**
