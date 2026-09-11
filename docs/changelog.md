# Changelog

All notable changes to the Kashshaf desktop app, API server, and data pipeline. Format loosely follows Keep a Changelog. Dates are build dates; nothing below has been tagged or published yet.

---

## [0.5.0] — 2026-09-09 (unreleased, in working tree)

Implements REPORT.md Phase 0, Phase A and Phase B on the application side, plus the Phase A and Phase B data tooling. Verified on a 25-book sample corpus; the full-corpus rebuilds (3.0.0, 4.0.0) and their benchmarks are still to be run. The plan's separate 0.4.2 (fixes) and 0.6.0 (Phase B) releases were folded into this one because the engine detects the index kind and blob encoding at startup and can read every corpus from 2.0.0 to 4.0.0.

### Added

**`engine/` — new shared crate `kashshaf-engine` (kashshaf-app)**
- One search engine for the Tauri desktop backend and the axum API server; the two drifted copies (`src-tauri/src/{search,cache,variants,tokens}.rs`, `api/src/{search,cache,tokens,variants,error}.rs`) are deleted. Per-host differences live in `EngineConfig` (highlight caps, root hedge, candidate cap).
- `ReadingOrderCollector`: on a single-segment index whose doc ids are monotonic in reading order (verified by a fast-field scan at startup, ~0 ms on the sample), returns the exact hit count and the requested window in one pass. Deep pagination costs O(limit) document fetches instead of O(offset + limit). Falls back to the previous `TopDocs`-by-`death_ah` ordering on other indexes.
- `blob.rs`: decoder for `page_tokens` encoding 2 (unsigned LEB128 ranks under a dictionary-trained zstd frame, rank → definition id through `token_codec.rank_to_def`) alongside encoding 1; 16 unit tests incl. a zstd round trip.
- `corpus_db.rs`: `db_info.schema_version` gating (supports 1–4, refuses newer with an "update Kashshaf" message), `verify_corpus_versions_match`, `ensure_corpus_indexes` (lemma and root indexes, created at startup only for schema < 3).
- `TokenCache`: reads the `encoding` column when present, keeps an LRU of decoded id arrays next to the resolved-token LRU, batched `get_ids_batch` (250 keys per `IN` statement), `surfaces_for`, `wildcard_phrase_positions_batch` (exact wildcard highlights from token ids). `new()` returns `Result` instead of panicking.
- `triples.rs` (`TripleMaps`): compound-index maps loaded from `corpus.db` schema 4 — definition → triple, triple → lemma/root, CSR reverse maps lemma/root → triples, triples sorted by normalized surface for exact and prefix lookup. ~11 MB for the sample.
- `forward.rs`: phrase starts, member positions, and proximity positions over a page's token ids.
- Compound-index query translation: each query word becomes a set of triple ids; single words use `TermSetQuery`; phrases use `RegexPhraseQuery` with one alternation per position while the alternation's prefix trie stays under the FST regex's 1000-state budget, otherwise a bag-of-words `BooleanQuery` verified on the forward index (candidate cap `PROXIMITY_MAX_VERIFY` = 20,000, `was_capped` when exceeded). Single-word root queries prefer the `root_text` hedge field when the index carries it.
- `SearchFilters.author_id`, `genre_id`, `century_ah`, `death_ah_min/max` are now applied as `RangeQuery`s on the FAST-only numeric fields (Tantivy uses the fast-field path automatically). Previously only `book_ids` was honoured.
- `SearchResults.was_capped: Option<bool>` (serialized only when true).
- Benchmark and parity harness: `engine/src/bin/bench.rs` (latency percentiles, counts, ordered result keys, highlight positions, variants), `engine/bench/queries.json` (23 cases: surface/lemma/root terms, phrases, deep offset, combined, proximity, wildcards, name search, variants, page load), `engine/bench/compare.py` (fails on result-set, count or variants differences, non-superset highlights, or p95 regression > 10%). Reports for the sample are checked in under `engine/bench/reports/`.

**API server**
- `/health` reports `version`, `segments`, `reading_order`, `corpus_version`, `db_schema_version`, `max_supported_db_schema`, `max_limit`.
- `KASHSHAF_DATA_DIR` and `KASHSHAF_BIND` environment variables (defaults unchanged).
- Wildcard validation errors and surface-mode variants return HTTP 400 instead of 500.
- `docs/KASHSHAF_API_SPEC.md` rewritten to match the server (7 previously undocumented routes, real response shapes, clitic objects, limits, error codes).

**Frontend**
- `ResultsPanel` shows a lower-bound notice when `results.was_capped` is set. `SearchResults` type gains `was_capped?: boolean`.

**Data pipeline (`kashshaf-data-clean`)** — see BUILD_CORPUS.md
- `indexer/` on Tantivy 0.25 with `zstd-compression`: zstd doc store (`--zstd-level`, `--blocksize`, `--lz4`), reading-order ingestion on one writer thread with a final merge + GC (`--no-merge`, `--no-reading-order`, `--threads`, `--heap-gb`), `--input`/`--index` paths, byte-based progress (no more full pre-read of the corpus), per-extension size report. New binaries `merge` (merge + GC an existing index) and `check_order` (asserts reading order; exit 1 on violation). `prune --merge` now really merges. `query` fixed to the real schema.
- `indexer --compound --corpus-db PATH [--keep-root-text]` (Phase B): one `tokens` field of zero-padded triple ids read from `corpus.db` (both blob encodings) with a per-page alignment check against `surface_text`.
- `build_sqlite_tokens.py`: `--data-dir`; schema v3 (`page_tokens.encoding`, `WITHOUT ROWID`, `token_codec`, `idx_token_def_root`, `idx_token_def_surface` dropped); `--recompress` (frequency-ranked LEB128 + trained zstd dictionary, verifies 2,000 pages before swapping tables, reuses the codec and extends the rank map on incremental re-runs, `--fixtures DIR` writes decoder test vectors); `--build-triples` (schema v4). `--status` and `--check` understand encodings and codec; `update_token_counts` reads counts from the varint prefix.
- `make_sample.py`: stratified sample of the processed corpus by century × source, hard-linked.
- `ingest_to_index.py`: `--data-dir`, `--recompress`, `--compound`, `--keep-root-text`, `--zstd-level`, `--blocksize`, `--threads`, `--no-merge`; runs `check_order` after indexing.

**Documentation (`docs/`, formerly the gitignored `releases/`)**
- `KASHSHAF_SPECIFICATION.md` v4.0/4.1 and `KASHSHAF_UI_SPECIFICATION.md` v3.0 rewritten from the 0.4.1 code; `REPORT_IMPLEMENTATION_PLAN.md` (Parts I–IV with status); `BUILD_CORPUS.md` (operator guide); schema v3/v4 sections in `CORPUS_DATA_MODEL.md`; Phase A/B sections and the `root_text` caveat in `PIPELINE.md`; 0.5.0 notes in `RELEASE_REF.MD`.

**Proximity rebuild (2026-09-11, see PROXIMITY_REGRESSION_REPORT.md)**
- `engine/src/positional.rs`: N-way positional intersection on Tantivy postings with heap-based union cursors per slot, leapfrog from the rarest slot, pluggable matchers (proximity, phrase), filter `DocSet`, 1.5 s wall-clock budget. Default for compound single-word proximity (`ProximityImpl::Positional`) and for compound phrases whose alternations exceed the regex budget. `الله ~10 عرف` on the full corpus: exact 224,250 pages in 349 ms (old engine: "≥ 4,898" in 400 ms; 0.5.0 three-field: 1.4 s).
- Tier-1 streaming forward path: walks the candidate `DocSet` directly, stops at the window or `PROXIMITY_MAX_VERIFY = 20,000`, first-pair counting (`forward::has_pair_within`), `proximity_stop_at_window` option.
- `ProximityStats` / `proximity_search_with_stats`, `KASHSHAF_PROX_DEBUG`, `bench --micro`, `--proximity`, `--prox-cap`, `--prox-scan-to-cap`, `--prox-budget-ms`, `engine/bench/proximity.json`.
- Indexer: `NoMergePolicy` during ingestion and a final merge ordered by first-doc reading key (fixes out-of-order merged segments; corpus 3.0.0's index needs a rebuild).

**Release pipeline, deployment, corpus 4.0.0 cutover (2026-09-12; see RELEASE_STREAMLINING.md, api/deploy/README.md, DEPLOY_BENCH.md)**
- `deploy-api.yml` deleted: the API deploys only from `release.yml` on a tag (or `only_api = true` for a hotfix redeploy of an existing tag). Every workflow defaults to a dry run; side effects need `workflow_dispatch` with `dry_run = false`.
- Cargo workspace (`engine`, `src-tauri`, `api`) with one `[workspace.package].version`; `tauri.conf.json` reads `../package.json`. `scripts/release.py`: bumps the workspace version, notes from `docs/changelog.md`, `--dry-run`, `.release/min_supported_version` marker. `scripts/check_release.py` (`--local` in CI; `--post-deploy` after a deploy: `/health.version == tag`, every manifest URL answers HEAD 200, `corpus_manifest.min_app_version <= app_manifest.latest_version`). `.github/workflows/ci.yml`.
- `release.yml`: installers + a static musl API binary in parallel; `deploy-api` switches `/opt/kashshaf/api/bin/current`, waits for `/health.version` and `warm_cache == complete`, runs the smoke test (search, proximity + status, wildcard, `/page/tokens` without `part_index`, JSON 429 burst), rolls back on failure, keeps three binaries; `publish` needs the installers and the API deploy and a `production` approval; `manifest` builds `app_manifest.json` from the actual release assets, HEAD-checks them, archives and uploads to R2, verifies the round trip; `web` deploys app.kashshaf.com with wrangler. `api/deploy/`: systemd unit (`KASHSHAF_MAX_CONCURRENT_WALKS=4`), nginx site (TLS, 10 req/s burst 30), `install.sh`, `switch_release.sh`, `smoke.sh`.
- API: `/health.warm_cache` (`pending` | `complete` | `disabled`); `KASHSHAF_MAX_CONCURRENT_WALKS` env name; page-addressed requests accept a missing `part_index` (0.4.x clients).
- Corpus 3.0.0 cancelled; 4.0.0 (compound, schema 4, `min_app_version` 0.5.0) is next. `corpus_manifest.json` gains `base_url` (versioned prefix `corpus/<version>/`; `downloader.rs` joins it, flat layout without it) and lists `triples.bin` when present; `kashshaf-data-clean/publish_corpus.py` checks, stamps, hashes, uploads files then the manifest last, archives the previous manifest, verifies the round trip and writes `stats.json`; rollback is one manifest upload. Rehearsed against a local directory only.
- Website: About page reads `cdn.kashshaf.com/stats.json`; build-on-push, deploy-on-dispatch workflow. Announcements: `scripts/announcements/validate.py` + workflow (validate on change, upload on dispatch).
- Bench: `bench --remote <url>` (feature `remote`): the query sets over HTTP with client p50/p95 and server `elapsed_ms`, page-20 cache hits, `--concurrency 16`, `--check-compat`, `--rps` pacing; `docs/DEPLOY_BENCH.md`. Run against `127.0.0.1:3000` only.
- Docs moved from the gitignored `releases/` to the tracked `docs/`; spec §3.1, §4, §6.1, §14.1, §17.2, §20, §21, §22, §24 updated.

**Walk follow-up (2026-09-11, evening; see CAPPED_WALKS_REPORT.md §6)**
- Settled counts: a capped request waits up to `WALK_INLINE_MS = 150` for its walk to reach the cap or the end before answering, so fast walks report the final `20,000+` at once (`الله ~10 root:عرف`: 27 ms). Responses carry `walk_key` and `complete`; `get_walk_status` (Tauri) and `GET /search/status?key=` (API) return `{verified_hits, was_capped, complete, incomplete}`; the frontend polls once after 500 ms and once after a further 2 s while `complete` is false and updates the header in place (rows are never re-rendered).
- Detached walks are bounded by a permit pool: `EngineConfig::max_concurrent_walks` (default `available_parallelism() − 2`, at least 1; API env `KASHSHAF_MAX_WALKS`). A walk whose requesters have all been answered needs a permit to continue; after `WALK_QUEUE_MS = 2,000` without one it stops and marks its entry incomplete, and pagination beyond the prefix starts a fresh walk. `walks_active` / `walks_queued` in `get_stats` and `/health`.
- Prefix cache bounded by `PREFIX_CACHE_ENTRIES = 200` and `PREFIX_CACHE_BYTES = 256 MiB` (LRU); `prefix_cache_entries` / `prefix_cache_bytes` in `get_stats` and `/health`, plus process memory (`rss_mb`, `peak_rss_mb`, `private_mb`; `engine/src/memory.rs`).
- API rate limiting with `tower_governor`, enabled by `KASHSHAF_RATE_LIMIT` (`1` = 10 req/s, burst 30, per client IP; 429 with `{"error": …}`); off when unset. Page-cache warm-up with `KASHSHAF_WARM_CACHE=1` (background thread; 8.3 GiB in 9.7 s on the full corpus; readiness not blocked).
- Tests: walk permit saturation (N+3 walks → N active, 3 queued, all complete), queue-timeout → incomplete entry → fresh walk, prefix-cache eviction by bytes and by entries, status consistency; `engine/tests/full_index.rs` (gated on `KASHSHAF_FULL_DIR`): inline allowance settles `الله ~10 root:عرف` at `20,000+`, long walks report progress through the status. Bench: `engine/bench/api_concurrency.py` (16 concurrent requests against the API with a `/health` + `/page` side poller).

**Capped walks, cached pagination, exact-counts toggle, glob wildcards (2026-09-11 p.m., see CAPPED_WALKS_REPORT.md)**
- `engine/src/walk.rs`: every verified search path (proximity, wide-slot and beyond-regex-budget phrases, wildcard phrases, bag-of-words boolean and name verification) is a *walk* that stops at `MAX_VERIFIED_HITS = 20,000` verified hits or a 3 s safety budget, reports the verified count with `was_capped`, and caches the verified prefix (hits + positions) in an LRU keyed on query/modes/filters. Pagination is a slice of the prefix; "load more" never re-runs a walk. The walk runs on its own thread: the first window returns once `offset + limit` hits are verified and the prefix keeps filling to the cap (page 20 of a capped query: 8 ms doc-store bound, 0.4 ms memoized). Served windows are memoized; glob expansions are memoized.
- `EngineConfig::exact_counts` (+ `SearchEngine::set_exact_counts`, `capabilities()`): no cap, no budget, exact count, same cache. Desktop reads `user_settings.exact_counts` at startup; Menu → Settings opens the new `SettingsModal` with "Exact counts (slower, local data only)" (offline mode only), applied live through the `set_exact_counts` command. API server: always false. `/health` reports `wildcard_grammar`, `exact_counts`, `max_verified_hits`.
- Generalized wildcards on the compound index (`engine/src/glob.rs`): `*`-only glob, any number of `*` per word — `أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`; validation reduced to "≥ 2 literal Arabic letters per wildcard word, surface mode only" in both `validate_wildcard_query` and `utils/wildcardValidation.ts`; `WildcardQueryInfo` gains per-word `patterns` plus `segments` / `anchored_start` / `anchored_end`; `TripleMaps::triples_for_glob` (prefix-range or full scan). Threshold `WILDCARD_EXPANSION_THRESHOLD = 5,000` per slot (was 20,000). The three-field index keeps the `RegexQuery` path and its legacy rules behind `IndexKind`; the frontend asks `get_capabilities` / `/health` which grammar applies. Help panel rewritten for the glob grammar.
- Results header `250 / 20,000+` with a tooltip on the `+` replaces the lower-bound banner; load-more keeps paging while the count is a lower bound and stops on an empty page.
- Bench: `engine/bench/capped.json`, `--exact-counts`, per-case `exact_counts` / `offset`, `first_ms` (cold run) next to p50, `engine.wait_walks()` between runs. Tests: 8 glob tests, 4 walk tests, and `engine/tests/sample_parity.rs` (gated on `KASHSHAF_SAMPLE_DIR`): every wildcard shape equals a brute-force scan of the sample corpus, pages are byte-identical from cache and fresh walks, exact and capped share the same first hits.
- Removed: `EngineConfig::proximity_candidate_cap`, `proximity_stop_at_window`, `wildcard_slot_threshold`; bench `--prox-scan-to-cap`. `PROXIMITY_MAX_VERIFY` is now an alias of `MAX_VERIFIED_HITS`.

**Wildcard rework (2026-09-11 a.m., superseded the same day by the glob grammar above; see WILDCARD_REWORK_REPORT.md)**
- Compound wildcards no longer refuse wide patterns. The wildcard slot always expands fully (`TripleMaps::triples_for_wildcard` is unbounded); single words run as a `TermSetQuery` with an exact count (`ال*`: 355,404 words, 5,659,240 pages, 457 ms on the full corpus).
- `EngineConfig::wildcard_slot_threshold` (`WILDCARD_SLOT_THRESHOLD = 20,000`): in phrases, a slot wider than this is matched as a bitset `DocSet` (the `TermSetQuery` scorer) instead of one positional cursor per triple; `positional::cooccurring_hybrid` leapfrogs the narrow slots' cursors against it, pre-checks the narrow slots for a common phrase start, and hands co-occurring docs (reading order, at most `PROXIMITY_MAX_VERIFY`) to forward-index adjacency verification. `total_hits` is the verified count and `was_capped` marks a lower bound. `ابن ال*` on the full corpus: 662 ms, 4,213+ (exact 665,983 when uncapped, 26 s).
- `forward::TripleSet` / `IdBitmap` / `Members`: slot membership as a hash set or a dense bitmap (370 KB for 3M triples) so verification of a 355k-word slot does not build a 355k-entry hash set.
- Wildcard validation: the "internal wildcard requires at least 2 characters before it" rule is gone in Rust (`validate_wildcard_query`), the frontend (`utils/wildcardValidation.ts`) and the Help panel; `م*رف` is now a valid query (161 words, 60,795 pages, 34 ms).
- Bench: `--wildcard-threshold`, `engine/bench/wildcard.json`, and per-case memory (working set and private bytes, current and peak; `windows-sys` on Windows, `/proc/self/status` elsewhere).

### Changed
- `PageKey` and every `page_tokens` lookup now include `part_index`; `get_page_tokens` / `get_token_at` (Tauri) take `partIndex`; `/page/tokens` requires `part_index`.
- Fast-field columns are opened once per segment in the pagination fallback (`SegmentColumns`) instead of per document.
- API `limit` is clamped to 1–250 (was 100). The desktop client pages by 250, so online load-more no longer skips rows.
- Multi-word wildcard search uses `RegexPhraseQuery` (three-field index) or triple-set phrase matching (compound index). Exact adjacency and exact counts; no more `(limit+offset)×10` over-fetch, no per-candidate term-dictionary scans, no 5-position verification cap. (The 200,000-distinct-word refusal introduced on 2026-09-09 was replaced on 2026-09-11 by the per-slot threshold above.) Highlights come from the token cache in one batched pass; the Tauri command no longer recomputes them itself.
- Desktop `get_match_positions` / `get_page_with_matches` return up to 100 positions for single terms too (was 5), matching the API.
- `search()` decides phrase vs. term by word count (previously by the size of a `HashSet`, so `الله الله` was treated as one term).
- Versions bumped to 0.5.0 in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `api/Cargo.toml`, `engine/Cargo.toml`.
- `src-tauri` no longer depends on `tantivy` or `lru` directly; `api` no longer depends on `tantivy`, `lru`, `chrono`, `governor`, `tower_governor` (the last two were never used).

### Fixed
- **Wildcard searches never reached the backend as wildcards.** `src/utils/sanitize.ts` stripped `*` from every query despite its docstring; the character class no longer contains `*`.
- **Multi-word wildcard count and speed.** On the 25-book sample `ابن ال*` took 33 s and reported 971 pages; it now takes ~0.1 s and reports 2,418, which an independent scan of the token blobs confirms as the true count.
- **Root-mode highlight and proximity positions** are exact on compound indexes. The three-field `root_text` field omits tokens with null roots, so its postings positions are shifted on ~9% of pages (1,861 of 20,813 on the sample); every release up to 0.4.1 highlighted root matches at the wrong position there. The three-field path is unchanged (documented in PIPELINE.md with a fix for future three-field builds).
- API `AppState` panicked at startup on a malformed `corpus.db`; it now returns an error.
- **Wrong-part tokens in 45 books.** `page_id` restarts per part in 45 books (28,846 colliding `(book_id, page_id)` pairs), and every release up to 0.5.0 keyed the token cache on `(book, page)` only, so the overlay, variants and forward highlighting could show another part's tokens there. Keys now include `part_index`.
- Book 7524 (JSONL without a metadata row) is excluded from the index.

### Known limitations (proximity)
- Three-field indexes keep the postings-based proximity path: on a single merged segment it costs 110–220 µs per candidate, so common pairs take 1.4–2.9 s and report a 12,500-candidate lower bound. A cursor-reuse fix is described in PROXIMITY_REGRESSION_REPORT.md §7.
- Compound positional counts are exact up to the 1.5 s budget; beyond it (`الله × قال`, 3.1M co-occurring pages) the count is a lower bound with `was_capped`.
- Triple maps take ~4 s to load from SQLite at full scale; the `triples.bin` sidecar is required before 4.0.0 ships.

### Performance (25-book sample, p50, ms; `engine/bench/reports/`)

| Case | 0.4.1 engine (reproduced) | 0.5.0 three-field index | 0.5.0 compound + root hedge |
|---|---|---|---|
| surface term (common) | 1.0 | 1.0 | 3.7 |
| lemma term (common) | 0.9 | 1.0 | 4.2 |
| root term (productive) | 0.9 | 0.9 | 1.6 |
| lemma phrase, 2 words | 7.6 | 7.7 | 15.5 |
| deep offset 4,750 | 27 | 2.1 | 6.1 |
| combined AND/OR | 1.3 | 1.3 | 12.1 |
| proximity lemma×lemma d=5 | 11.5 | 11.5 | 37 |
| wildcard prefix `أب*` | 103 | 9.6 | 12.7 |
| wildcard phrase `ابن ال*` | 33,000 | 108 | 144 |
| name search (10 patterns) | 1.3 | 1.2 | 2.3 |
| variants (lemma) | 62 | 58 | 63 |
| page + tokens load ×10 | 23 | 20 | 20 |

Index size on the sample: 42 MB three-field → 27 MB compound (`.pos` 14 → 5 MB, `.idx` 11 → 5 MB, `.term` 3 → 1 MB). `corpus.db` 62 → 34 MB after recompression. Startup: +100 ms for triple maps on the sample (~1.5 s projected for the full corpus; sidecar deferred until measured).

Parity (`compare.py`): result sets and hit counts identical for all 23 cases between the reading-order collector and the `TopDocs` fallback, and between the three-field and compound indexes. Highlights on compound indexes are a superset except where the three-field root positions were wrong.

### Known limitations
- Full-corpus builds and benchmarks not yet run; checkpoint decisions (root hedge on, `RegexPhraseQuery` for small alternations) are from the sample.
- Compound-index term queries are 3–4× slower than three-field ones on the sample (`TermSetQuery` over hundreds of triples vs one posting list); REPORT.md anticipated this. Whether it holds at full scale decides the 4.0.0 release.
- Proximity and phrase counts on compound indexes are exact only up to 50,000 candidate pages (`was_capped` otherwise).
- `release.py` does not bump `engine/Cargo.toml` yet.
- No UI exposes the now-working date/genre/author filters.
- Online name-match highlighting still issues one request per pattern (§22 item 9 of the specification).

---

## [0.4.1] — 2026-05-08
- Lemma variant display and search.

## [0.4.0] — 2026-05-07
- Citation feature (Chicago, MLA) from `citation_json`; cleaned book metadata; sortable columns in the text browser and text selection.

## [0.3.1] — 2026-05-06
- Fix build error from package version mismatch.

## [0.3.0] — 2026-05-06 (required update)
- Vol:page navigation; `metadata.db` distributed with the corpus; reading-order sort of results.

## [0.2.3] — 2026-01-12
- Global page ids per book; updated data indices.

## [0.2.2] — 2026-01-11
- Collections.

## [0.2.1] — 2026-01-11
- Desktop build announcement fix.

## [0.2.0] — 2026-01-10
- Full corpus release; concordance feature removed; corpus schema and index update; matched token positions capped at 5 in results.

## [0.1.5] — 2026-01-06
- Web platform build.

## [0.1.0] – [0.1.4] — 2026-01-05
- Initial release, updater, startup modals, bug fixes.
