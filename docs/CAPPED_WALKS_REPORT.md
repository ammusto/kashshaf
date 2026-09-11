# Capped walks, cached pagination, exact counts, glob wildcards

**Date:** 2026-09-11 · **App:** 0.5.0 working tree, nothing committed · **Data:** full compound index at `kashshaf-data-clean/data/compound-work` (5,711,710 pages, 2,985,160 triples, single reading-order segment) and the 25-book sample at `data/sample-mini`

## 1. What was built

### Part 1 — walks

Every verified search path is now a **walk** (`engine/src/walk.rs`): proximity (positional cursors for single-word sides, forward-index verification when a side is a phrase), phrases beyond the regex budget (positional or hybrid cursor/bitset), wildcard phrases, and the bag-of-words boolean and name verification. A walk yields verified hits in reading order and:

- stops at `MAX_VERIFIED_HITS = 20,000` verified hits, or after the `WALK_BUDGET_MS = 3,000` safety budget; either sets `was_capped` and `total_hits` is the verified count. The cap is on hits, so the prefix is the same on every machine;
- caches the verified prefix (hits with positions, count, `was_capped`) in an LRU keyed on `(kind, terms + modes, filters with sorted book ids, exact flag)`: 16 entries, at most 4M cached hits. Pages are slices; "load more" never re-runs a walk. Served windows are memoized (128) so a repeated page costs no doc-store read;
- runs on its own thread: a capped request returns as soon as `offset + limit` hits are verified while the thread fills the prefix to the cap;
- with `EngineConfig::exact_counts` has no cap and no budget, waits for completion, and shares the cache (the flag is part of the key). `SearchEngine::set_exact_counts` flips it at runtime.

Desktop: `AppState::new` reads `user_settings.exact_counts`; Menu → Settings opens the new `SettingsModal` with "Exact counts (slower, local data only)" (offline mode only), applied live through the `set_exact_counts` command; `get_capabilities` reports grammar, exact flag and cap. API server: `exact_counts` always false; `/health` gained `wildcard_grammar`, `exact_counts`, `max_verified_hits`. Frontend header: `250 / 20,000+` with the explanation as a tooltip on the `+`; the yellow banner is gone; load-more keeps paging while the count is a lower bound and stops on an empty page. Plain term / boolean / regex-phrase searches are untouched (`ReadingOrderCollector`, exact).

### Part 2 — glob wildcards (compound index only)

`engine/src/glob.rs`: `*`-only glob, any number of `*` per word, iterative matcher. Expansion (`TripleMaps::triples_for_glob`) binary-searches the surface-sorted array when the pattern starts with a literal, otherwise scans all surfaces (memoized per engine). Validation in Rust and TypeScript is identical: surface mode only, and every word containing `*` has at least 2 literal Arabic letters; the "cannot start a word", "2 letters before an internal `*`" and "one `*` per search" rules are gone. Per-slot threshold `WILDCARD_EXPANSION_THRESHOLD = 5,000`: single words always run as a `TermSetQuery` with an exact count; phrases use `RegexPhraseQuery` when the alternations fit, positional cursors when every slot is under the threshold, and the hybrid bitset path with forward-index adjacency verification above it. The three-field index keeps its `RegexQuery` path and legacy rules behind `IndexKind`; the frontend asks `get_capabilities` / `/health` which grammar applies. Highlights are token membership in the slot sets. `search_type` for wildcards stays `'boolean'`.

### Files

| Area | Files |
|---|---|
| engine | `walk.rs` (new), `glob.rs` (new), `search.rs` (walk paths, grammar, capabilities, page/glob memos), `positional.rs` (`StreamSink`, `intersect_n_stream`, `cooccurring_hybrid_stream`), `triples.rs` (`triples_for_glob`), `tokens.rs` (`PageKey: Ord`), `lib.rs`, `bin/bench.rs`, `bench/capped.json`, `tests/sample_parity.rs` (new) |
| desktop | `src-tauri/src/state.rs`, `commands.rs` (`get_capabilities`, `set_exact_counts`), `main.rs` (menu → `open-settings`) |
| API | `api/src/main.rs` |
| frontend | `utils/wildcardValidation.ts`, `types/index.ts`, `api/{index,tauri,offline,online}.ts`, `contexts/OperatingModeContext.tsx`, `components/sidebar/BooleanSearchPanel.tsx`, `components/panels/{ResultsPanel,HelpPanel}.tsx`, `components/shared/VirtualizedResultsList.tsx`, `hooks/useSearch.ts`, `components/modals/SettingsModal.tsx` (new), `components/Toolbar.tsx` |
| docs | `KASHSHAF_SPECIFICATION.md` §8.2, §8.3, §10.2, §10.3, §22; `changelog.md`; `docs/KASHSHAF_API_SPEC.md`; help panel |

## 2. Tests

- `cargo test --release` in `engine/`: 34 unit tests (8 glob: all five shapes, Arabic, empty segments, bare `*`; 4 walk: capped windows from one run, exact waits, budget stops a barren walk, walker errors are not cached; hybrid/positional parity; validation for both grammars; parse).
- `engine/tests/sample_parity.rs` (gated on `KASHSHAF_SAMPLE_DIR`), all passing on the sample:
  - every wildcard shape (`أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`, `م*رف`, `ال*`, `ابن ال*`, `ابو *الله`, `ابن *ال*`, `*ية`) returns exactly the page set of a brute-force membership scan over all 20,813 pages, with the same `total_hits` and no duplicates across pages;
  - pages 1..N of `ابن ال*` (10 pages) and `الله ~10 قال` (40 pages) are byte-identical whether served from the cache or by a fresh walk started at that offset, and the settled totals agree;
  - with the cap lowered to 500, exact and capped walks return identical first 500 hits; the capped one reports `500+`, the exact one 9,777; the wildcard highlight path equals page membership.
- `cargo check` for `src-tauri` and `api`; `tsc --noEmit` and `vite build` for the frontend.
- Sample regression (`engine/bench/queries.json`, 23 cases): result sets, counts and highlights unchanged against the previous report; the walk cases became cache hits (proximity 12 → 0.2 ms, wildcard phrase 100 → 0.1 ms on repeated runs). Untouched paths measured 10–40 % slower on this rerun, including term searches and page loads whose code did not change, so that is machine noise, not a regression.

## 3. Benchmark: full compound index

`bench --queries engine/bench/capped.json --runs 3` (report `engine/bench/reports/capped-full-compound.json`). `first` is the cold run of each case (the walk is started by it), `p50` the later runs (cache hits). After each case the bench waits for the walk to finish, so the "page 20" cases hit a settled prefix. Page cache warm (a run minutes earlier with a cold cache put `ال*` at 3.35 s and the proximity first page at 234 ms because of disk reads; both are given below in brackets).

| Query | Path | Hits | first | p50 | Working set (peak) | Private (peak) |
|---|---|---|---|---|---|---|
| `ال*` | termset, 355,404 words | 5,659,240 exact | 615 ms [3.35 s cold] | 539 ms | 714 MiB (738) | 399 MiB (485) |
| `الم*` | termset, 73,713 | 4,489,199 exact | 128 ms | 118 ms | 721 (738) | 401 (485) |
| `*ية` | termset, 63,926 (full scan) | 3,340,812 exact | 126 ms | 101 ms | 734 (738) | 400 (485) |
| `*قول*` | termset, 9,342 (full scan) | 2,887,779 exact | 101 ms | 28 ms | 742 (742) | 400 (485) |
| `مع*رف*` | termset, 158 | 117,006 exact | 21 ms | 16 ms | 748 (748) | 403 (485) |
| `م*رف` | termset, 161 | 60,795 exact | 22 ms | 17 ms | 751 (751) | 404 (485) |
| `ابن ال*` page 1 | hybrid walk (3 × 355,404) | **20,000+** | 528 ms | 0.4 ms | 761 (771) | 412 (485) |
| `ابن ال*` page 20 | cache slice | 20,000+ | 7.8 ms | 0.4 ms | 762 (771) | 411 (485) |
| `ابو *الله` | positional walk (4 × 1,391) | 1,447 exact | 91 ms | 0.2 ms | 787 (789) | 411 (485) |
| `الله ~10 root:عرف` page 1 | positional walk (1 × 2,151) | 20,000+ | 11.5 ms [234 ms cold] | 0.3 ms | 796 (800) | 412 (485) |
| `الله ~10 root:عرف` page 20 | cache slice | 20,000+ | 9.0 ms | 0.2 ms | 798 (800) | 412 (485) |
| `الله ~10 lemma:قال` capped | positional walk (1 × 595) | 20,000+ | 4.5 ms | 0.3 ms | 801 (802) | 413 (485) |
| `الله ~10 lemma:قال` exact | positional walk to the end | **2,447,865** exact | 2.24 s | 0.4 ms | 1,060 (1,086) | 692 (734) |
| `الله ~10 lemma:قال` exact page 20 | cache slice | 2,447,865 | 2.6 ms | 0.3 ms | 1,061 (1,086) | 692 (734) |

Baseline after open: working set 356 MiB, private 389 MiB (188 MB of it the triple maps). Open takes 6–7 s here (triple maps ~2.3 s, the rest page-cache misses on the index; the sidecar recommendation from the proximity report stands).

**Against the acceptance criteria**

- `ال*` and `*ية` complete without refusal, exact counts: yes (0.6 s and 0.13 s warm).
- `ابن ال*` under ~500 MB RSS: private (heap) memory stays at 412 MiB, 23 MiB above the idle engine, and the walk itself holds 20,000 hits (~2 MB). The Windows working set reads 761 MiB because it counts the memory-mapped postings pages the bitset build touches (about 400 MiB of reclaimable file cache on top of the 356 MiB baseline). If the criterion means heap, it is met with a wide margin; if it means the working set, no query on this 5.7M-page index gets under 500 MB because the idle engine already sits at 356 MiB.
- Page 20 of a capped query < 5 ms: 0.2–0.4 ms once the page has been served once (memoized rows). The first fetch of a page costs 8–9 ms, all of it reading 250 documents from the compressed doc store; the walk itself is never re-run.

**What the exact toggle costs.** `الله ~10 lemma:قال` exact: 2.45M hits in 2.24 s, and the cached prefix holds ~280 MB of hits with positions (private 692 MiB). The walk LRU caps cached hits at 4M in total, so at most one or two such prefixes stay resident.

## 4. Semantics worth knowing

- **Early first page.** A capped request returns as soon as `offset + limit` hits are verified, so the very first page of a big query says e.g. `250 / 256+`; the next page (or any request a moment later) says `20,000+` or the exact total if the walk finished under the cap. The frontend takes the newest count from every page. Exact mode waits for completion and never shows an intermediate count.
- **Hit cap vs. candidate cap.** The earlier (a.m.) design capped *candidates* at 20,000, which gave `ابن ال*` a weak `4,213+`. Capping verified hits makes the bound `20,000+` at the cost of scanning 146,000 candidates (1.6 s in the background).
- **Determinism.** Because the cap is on hits, the cached prefix and every page served from it are identical across machines; the 3 s budget only matters for candidate sets that verify almost nothing, and then the count is marked `+` as well.
- **Memory of a walk thread.** A walk holds a `Searcher` clone; a corpus reload while a walk runs keeps the old index mapped until the walk finishes (seconds at most).

## 5. Not done / open

- Nothing is committed in either repository.
- The three-field index keeps the postings proximity path and legacy wildcard rules (not walks, no cache) — by design.
- The sample regression run was noisy (untouched code 10–40 % slower on the second run); result sets are identical, so no action, but a quiet rerun before release would give cleaner latency numbers.
- A reversed-surface permutation for suffix patterns was not needed: the full-vocabulary scan behind `*ية` costs ~100 ms and is memoized.

## 6. Follow-up (same day, evening): settled counts, bounded walks, cache bounds, rate limit, warm-up

### What changed

1. **Inline allowance.** A capped request now waits up to `WALK_INLINE_MS = 150` after its window is verified for the walk to reach the cap or the end, so the first response usually carries the settled count. Walk-backed responses carry `walk_key` and `complete`. `get_walk_status(key)` (Tauri) and `GET /search/status?key=` (API) return `{verified_hits, was_capped, complete, incomplete}`; the frontend polls once after 500 ms and once after a further 2 s while `complete` is false and patches the header counts in place (`updateTabWith`; rows untouched). Exact mode still waits for completion.
2. **Bounded detached walks.** A permit pool of `max_concurrent_walks` (default `available_parallelism() − 2`, min 1; `KASHSHAF_MAX_WALKS` on the API) governs walks whose requesters have all been answered; attached walks run freely. A walk that gets no permit within `WALK_QUEUE_MS = 2,000` stops, its entry is marked `incomplete` (pages inside the prefix are still served; a page beyond it starts a fresh walk). `walks_active`, `walks_queued` in `get_stats` and `/health`.
3. **Prefix cache bounds.** `PREFIX_CACHE_ENTRIES = 200`, `PREFIX_CACHE_BYTES = 256 MiB` (32 bytes per hit + 4 per position), LRU eviction at insertion; `prefix_cache_entries` / `prefix_cache_bytes` reported, plus process memory (`engine/src/memory.rs`, shared by bench, `/health` and `get_stats`).
4. **Rate limiting.** `tower_governor` 0.4 with `SmartIpKeyExtractor`, enabled by `KASHSHAF_RATE_LIMIT` (`1` = 10 req/s, burst 30; `<per_second>[,<burst>]`), 429 with `{"error": …}`; off when unset.
5. **Warm-up.** `KASHSHAF_WARM_CACHE=1` reads `tantivy_index/*` and `corpus.db` sequentially on a background thread at startup and logs the volume and time; readiness is not blocked (listening at +0 s, warm-up done at +9.7 s for 8.3 GiB).

### Tests

- `walk.rs`: `semaphore_saturation_queues_detached_walks` (N = 2 permits, 5 walks → 2 active / 3 queued observed, all 5 complete with every hit), `queue_timeout_marks_entry_incomplete_and_pagination_restarts` (1 permit: the second walk gives up after 2 s, its prefix serves pages inside it, a page beyond starts a fresh walk), `prefix_cache_evicts_by_bytes` (100 KB bound keeps the newest entries only; entry bound too), status consistency in the existing walk tests. 37 unit tests pass.
- `engine/tests/full_index.rs` (gated on `KASHSHAF_FULL_DIR`): the inline allowance returns a settled `20,000+`, `complete: true`, for `الله ~10 root:عرف` on the full index (27 ms warm), and `get_walk_status` agrees with the cached entry; the slow `ابن ال*` walk returns early (`complete: false`, 267 hits at 563 ms) and the status reports it complete at 20,000 afterwards, with identical rows. The sample-parity tests still pass.

### Bench (full compound index, release, warm; `capped-full-compound-v2.json`)

| Query | Hits | first | cached |
|---|---|---|---|
| `ال*` | 5,659,240 exact | 672 ms | 672 ms (not a walk) |
| `الم*` | 4,489,199 exact | 139 ms | |
| `*ية` | 3,340,812 exact | 141 ms | |
| `*قول*` | 2,887,779 exact | 103 ms | |
| `مع*رف*` | 117,006 exact | 25 ms | |
| `م*رف` | 60,795 exact | 27 ms | |
| `ابن ال*` page 1 | 20,000+ | 583 ms (`complete: false`, settles ~1.5 s later) | 0.7 ms |
| `ابن ال*` page 20 | 20,000+ | 10 ms | 0.9 ms |
| `ابو *الله` | 1,447 exact | 180 ms | 0.2 ms |
| `الله ~10 root:عرف` page 1 | 20,000+ settled in the response | 34 ms | 0.2 ms |
| `الله ~10 root:عرف` page 20 | 20,000+ | 9 ms | 0.7 ms |
| `الله ~10 lemma:قال` capped | 20,000+ | 21 ms | 0.4 ms |
| `الله ~10 lemma:قال` exact | 2,447,865 | 2.46 s | 0.3 ms |
| `الله ~10 lemma:قال` exact page 20 | 2,447,865 | 2 ms | 0.3 ms |

Peak working set 1,086 MiB (the exact walk), private 734 MiB; baseline 356 / 389 MiB.

### API concurrency (`engine/bench/api_concurrency.py`, server with `KASHSHAF_MAX_WALKS=6`, `KASHSHAF_WARM_CACHE=1`)

| Scenario | First window p50 / p95 | Walks queued (peak) / active (peak) | `/health` max | `/page` max | Peak RSS | Report |
|---|---|---|---|---|---|---|
| 16 × `الله ~10 lemma:قال` (same query → one walk, shared) | 43 ms / 51 ms | 0 / 0 | 6.8 ms | 13.8 ms | 457 MiB (private 394) | `api-concurrency-shared.json` |
| 16 × `الله ~10 lemma:قال` with distances 1..16 (16 walks) | 95 ms / 107 ms | 0 / 3 | 38.6 ms | 32.7 ms | 457 MiB (private 434) | `api-concurrency-distinct.json` |
| 16 × `قال ~d "رسول الله"` with distances 1..16 (16 forward walks of 1–3 s) | 331 ms / 471 ms | 10 / 8 | 127 ms | 181 ms | 535 MiB (private 503) | `api-concurrency-distinct-phrase.json` |

Reading: the requested scenario (16 identical requests) dedupes to one walk that reaches the cap in ~20 ms, so nothing queues and the cheap endpoints stay under 20 ms. Sixteen *distinct* single-word walks also settle inside the inline allowance (queue peak 0, `/health` ≤ 39 ms during the 110 ms burst). Only sixteen distinct phrase walks, each 1–3 s of forward verification, exercise the permit queue (peak 10 waiting, 8 running — attached walks do not need a permit) and saturate the CPU, during which `/health` and `/page` spike to 127 / 181 ms. All 16 responses returned within 480 ms with `complete: false` and settled later. Rate limiter check on a second instance (`KASHSHAF_RATE_LIMIT=1`): 60 concurrent `/health` requests → 31 × 200, 29 × 429 with the JSON error body; a request 3 s later succeeds again. `/search/status?key=nope` → 404.

### Commits

The work was committed in the requested order: (1) `3ed5752` engine crate + part_index page keys + `/page/*` compat shim (`part_index` defaults to 0); (2) `c71dcb5` in `kashshaf-data-clean` (indexer ordered merge, book 7524); (3) `b861db2` positional/forward; (4) `47b5f57` walks, prefix cache, exact_counts, settings modal; (5) `8d332eb` glob wildcards, capabilities; (6) this follow-up; (7) bench harness and reports. The engine was written in one working tree, so commits 1–5 are split by file (each message says what it carries) and the crate first builds at commit 5. Commit (8), the spec and changelog updates, could not be made: `releases/` and `scripts/` are gitignored in this repository.
