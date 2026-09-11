# Wildcard rework: per-slot expansion threshold

**Date:** 2026-09-11 · **App:** 0.5.0 working tree (`engine/`, `src/`, docs) · **Data:** full compound index at `kashshaf-data-clean/data/compound-work` (corpus 3.0.0 pages, `corpus.db` schema 4, 5,711,710 pages, 2,985,160 triples, single segment in reading order)

## 1. What changed

The 0.5.0 (2026-09-09) compound wildcard path refused any pattern whose surface expansion exceeded 200,000 distinct words ("matches too many distinct words. Add more letters before the * and try again"). That refusal is gone. The wildcard slot always expands fully, and the engine chooses how to match it:

| Query shape | Path | Count |
|---|---|---|
| single word (`ال*`, `الم*`, `م*رف`) | `TermSetQuery` over the full expansion, paged by `ReadingOrderCollector` | exact |
| phrase whose slot alternations fit the regex budget (`trie_nodes ≤ 900`) | `RegexPhraseQuery` | exact |
| phrase, every slot ≤ `wildcard_slot_threshold` | `positional::intersect_phrase` (union cursors per slot) | exact within the 1.5 s budget |
| phrase with a slot > `wildcard_slot_threshold` (`ابن ال*`) | `positional::cooccurring_hybrid`: narrow slots stay positional cursors, the wide slot is the `TermSetQuery` scorer's bitset `DocSet`; co-occurring docs whose narrow slots admit a common phrase start are collected in reading order up to `PROXIMITY_MAX_VERIFY` and verified for adjacency on the forward index | verified count, `was_capped` when candidates were left over |

`EngineConfig::wildcard_slot_threshold` defaults to `WILDCARD_SLOT_THRESHOLD = 20,000` triple ids. Below it a slot is a set of `SegmentPostings` cursors (positions available, roughly 2 KB of heap each); above it, one bitset built by Tantivy in a single pass over the slot's postings (0.7 MB for 5.7M docs).

Validation lost its "internal wildcard requires at least 2 characters before it" rule in both places it lived: `engine/src/search.rs::validate_wildcard_query` (and therefore the API's 400 and the Tauri command) and `src/utils/wildcardValidation.ts`. `م*رف` and `ا*` are now valid. The remaining rules: one `*` per query, not at the start of a word, surface mode only.

### Files

| File | Change |
|---|---|
| `engine/src/search.rs` | `WILDCARD_SLOT_THRESHOLD`, `EngineConfig::wildcard_slot_threshold`; `wildcard_search_with_cache` split into a three-field branch (`wildcard_query_three_field`, unchanged behaviour) and `wildcard_compound` (path table above); `phrase_positional` now wraps `phrase_positional_core`, which routes to `phrase_hybrid_verified` when a slot exceeds the threshold (this also covers non-wildcard phrases from `combined_search`); 2-letter rule removed; `[wildcard]`/`[phrase] hybrid` lines under `KASHSHAF_PROX_DEBUG` |
| `engine/src/positional.rs` | `Slot` (cursor or bitset scorer), `cooccurring_hybrid`, `narrow_slots_consistent`, `HybridCandidates`; parity test `hybrid_candidates_superset_and_verified_parity` |
| `engine/src/forward.rs` | `TripleSet` trait, `IdBitmap`, `Members`; `phrase_starts`/`phrase_positions`/`member_positions` generic over the membership type |
| `engine/src/triples.rs` | `triples_for_wildcard(prefix, suffix)` unbounded, returns `Vec<u32>` |
| `engine/src/bin/bench.rs`, `engine/Cargo.toml` | `--wildcard-threshold`; per-case working set and private bytes (current and peak) via `windows-sys` `GetProcessMemoryInfo` (Windows) or `/proc/self/status` (elsewhere); `was_capped` in the report |
| `engine/bench/wildcard.json` | the four benchmark queries |
| `src/utils/wildcardValidation.ts`, `src/components/panels/HelpPanel.tsx` | rule removed; help text |
| `docs/KASHSHAF_SPECIFICATION.md` §8.3, `KASHSHAF_UI_SPECIFICATION.md`, `changelog.md`, `REPORT_IMPLEMENTATION_PLAN.md`, `docs/KASHSHAF_API_SPEC.md` | updated |

Unit tests: 21 pass (`cargo test --release` in `engine/`), including the new bitmap test and the hybrid parity test (candidates are exactly the docs where the narrow slots align and the wide slot occurs; forward verification reproduces the exact phrase hits; cap and `more` behave). `cargo check` passes for `src-tauri` and `api`; `tsc --noEmit` passes.

## 2. Benchmark: full compound index

`bench --queries engine/bench/wildcard.json --runs 5` (report: `engine/bench/reports/wildcard-full-compound.json`). Open: 3.0 s (2.3 s of it the triple maps). Memory after open: working set 356 MiB, private 388 MiB.

| Query | Path | Expansion (words) | total_hits | p50 | p95 | Working set after (peak) | Private after (peak) |
|---|---|---|---|---|---|---|---|
| `ال*` | termset | 355,404 | 5,659,240 (exact) | 457 ms | 556 ms | 721 MiB (735) | 401 MiB (485) |
| `ابن ال*` | hybrid, cap 20,000 | 3 × 355,404 | **4,213+** (lower bound) | 662 ms | 714 ms | 740 MiB (753) | 416 MiB (485) |
| `م*رف` | termset | 161 | 60,795 (exact) | 34 ms | 36 ms | 743 MiB (753) | 416 MiB (485) |
| `الم*` | termset | 73,713 | 4,489,199 (exact) | 118 ms | 121 ms | 743 MiB (753) | 416 MiB (485) |

Peak over the run: working set 753 MiB, private 485 MiB. The first cold run of `ال*` took 3.26 s (postings pages not yet in the page cache); the table shows warm runs.

**Reading the memory columns.** The working set includes every page of the memory-mapped index that a query touched. `ال*` reads the `Basic` postings of 355k terms, which is most of the 1.4 GB `.idx` file, so the working set climbs by about 365 MiB of reclaimable file cache. The private (heap) peak rises by 97 MiB: the `TermSetQuery`'s `BTreeSet<Term>` and FST for 355k terms plus the 4 MB id vector, all transient. Nothing is retained between queries beyond the token cache.

**Where `ابن ال*` spends its 662 ms.** Building the wide slot's bitset (Tantivy streams the term dictionary through the FST and ORs 355k posting lists): 430–470 ms. Leapfrog of the 3 `ابن` cursors against the bitset: 1 ms. Fetching and verifying 20,000 candidate pages on the forward index: 123–148 ms (about 7 µs per page including the SQLite fetch and zstd decode).

## 3. Two experiments on `ابن ال*`

Both give the same exact count, which is the parity evidence for the hybrid path on real data.

| Variant | Command | total_hits | Time | Peak private | Peak working set |
|---|---|---|---|---|---|
| hybrid, cap raised to 3,000,000 | `--prox-cap 3000000 --prox-budget-ms 600000` | **665,983** (exact; 2,331,487 candidates verified) | 26.2 s (scan 0.9 s, verify 25.2 s = 10.8 µs/page) | 485 MiB | 757 MiB |
| positional cursors for all 355,404 words | `--wildcard-threshold 400000 --prox-budget-ms 300000` | **665,983** (exact) | 29.0 s (open 3.1 s, intersect 15.7 s, positions 10.0 s) | **1,112 MiB** (+723 MiB for the cursors) | 1,696 MiB |

Reports: `engine/bench/reports/wildcard-full-compound-abn-al-uncapped.json`, `…-abn-al-positional.json`.

So the threshold does what it is for: a 355k-cursor slot costs 720 MB of heap and is no faster than verifying on the forward index; the bitset costs 0.7 MB. With the default cap the query returns in 0.66 s.

## 4. What the user sees, and the open question

*Superseded later on 2026-09-11: the cap is now on verified hits (20,000) rather than candidates, so `ابن ال*` reports `20,000+`, and the Exact counts setting gives the true total. See `CAPPED_WALKS_REPORT.md`.*

For `ابن ال*` the default configuration reports "4,213+" in reading order, while the true count is 665,983. The lower bound is honest but weak (0.6% of the truth), because the cap counts *candidates* (pages with `ابن` and any `ال…` word: 2.33M) and only 29% of them verify. Options if a better bound is wanted, none implemented:

1. **Raise the cap for wildcard phrases.** Verification runs at about 10.8 µs per page, so 200,000 candidates would add roughly 2 s and typically report a bound around 57,000.
2. **Count without fetching.** For a two-slot phrase whose narrow slot has positions, adjacency could be checked from the wide slot's *positions* rather than the forward index, but that is exactly the per-term cursor cost the threshold avoids. A per-segment "position bitset" (doc, position) is not something Tantivy offers.
3. **Statistical estimate.** Verify a uniform sample of the candidates and report an estimate with `was_sampled`, as `compute_variants` does above 50,000 pages. Changes the UI contract from "lower bound" to "estimate".

The exact count is available today by raising `proximity_candidate_cap` at the cost of a 26 s query.

## 5. Sample parity

`engine/bench/queries.json` on `data/sample-mini/tantivy_index_compound_root` (23 cases) against `sample-mini-compound-root-v2.json`: result sets identical, highlights superset, latency within tolerance; `ابن ال*` still 2,418 (there its `ال*` slot has fewer than 20,000 ids, so the positional path is taken and the count stays exact). Report: `sample-mini-compound-root-v3.json`.

## 6. Not done

- Nothing is committed in either repository.
- The three-field wildcard path is unchanged (still `RegexQuery`/`RegexPhraseQuery` with Tantivy's 200,000-expansion cap and its "too many terms" error).
- `TermSetQuery::new` materialises one `Term` per id (the 97 MiB transient above). A custom query that feeds the FST builder directly from the sorted id vector would remove most of that; not needed at this size.
