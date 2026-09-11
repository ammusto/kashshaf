# Proximity Regression — Diagnosis and Fix

**Date:** 2026-09-11
**Reported:** `surface:الله ~10 root:عرف` ≈ 15,000 ms on the desktop, vs ~400 ms from the old three-field engine on the server.
**Outcome:** exact answer in 349 ms on the compound index (224,250 pages, where the old engine reported "≥ 4,898"); four correctness defects found and fixed along the way; the three-field path left untouched as instructed, with a recommended fix.

---

## 0. What the desktop was actually running

There is no full-corpus compound index on this machine; the compound indexes are the 25-book sample ones. The desktop dev build's data directory (`src-tauri/target/debug/data`) holds the **2.0.0 three-field index (17 segments)**, and the freshly built 3.0.0 index is also three-field. So the 15 s went through the **three-field postings path**, not the compound forward path. Both were instrumented; a full-corpus compound index (`data/compound-work/`, 6.03 GB, reading order verified) was built to measure Phase B at scale.

## 1. Step 1 — instrumentation

`ProximityStats` is returned by `SearchEngine::proximity_search_with_stats`, printed per case by `bench.rs`, and logged to stderr with `KASHSHAF_PROX_DEBUG=1`. Query set: `engine/bench/proximity.json`. Reports: `engine/bench/reports/prox-*.json`.

### 1.1 Compound, sample (20,813 pages), forward path as shipped in 0.5.0

| Query | cand | hits | p50 ms | tantivy | fetch | decode | scan | µs/cand |
|---|---|---|---|---|---|---|---|---|
| `الله` × root `عرف` (sets 1 / 464) | 3,378 | 993 | 79 | 2.8 | 22.0 | 18.3 | 16.1 | 16.8 |
| `الله` × lemma `قال` (sets 1 / 158) | 12,931 | 9,777 | 251 | 5.0 | 62.2 | 41.5 | 63.6 | 13.1 |
| rare × rare | 0 | 0 | 4.3 | 4.2 | — | — | — | — |
| common × rare | 5 | 0 | 5.6 | 4.4 | — | — | — | 5.0 |

### 1.2 Three-field, full corpus (5.71M pages), postings path

| Index | Query | cand scanned / total | hits reported | p50 ms | tantivy | scan | µs/cand |
|---|---|---|---|---|---|---|---|
| 3.0.0, 1 segment | `الله` × root `عرف` | 12,500 / 737,332 | 4,898 (capped) | **1,411** | 24 | 1,379 | 110 |
| 3.0.0, 1 segment | `الله` × lemma `قال` | 12,500 / 3,116,118 | 10,483 (capped) | **2,864** | 70 | 2,780 | 222 |
| 3.0.0, 1 segment | rare × rare | 735 | 627 | 20 | 1.7 | 1.3 | 1.7 |
| 3.0.0, 1 segment | common × rare | 774 | 82 | 29 | 1.1 | 24 | 32 |
| 2.0.0, 17 segments | `الله` × root `عرف` | 12,500 / 761,926 | 4,976 (capped) | 1,651 | 1,398 | 203 | 16 |
| 2.0.0, 17 segments | `الله` × lemma `قال` | 12,500 / 3,177,822 | 10,483 (capped) | 1,233 | 947 | 265 | 21 |

(2.0.0 rows were measured while the compound build saturated the SSD, so their Tantivy times are inflated; 3.0.0 rows are quiet-machine numbers.)

### 1.3 Compound, full corpus, 0.5.0 forward path with the 50k cap (before this work)

At 13–17 µs/candidate the 737k–3.1M candidate intersections would cost 10–50 s uncapped; the 50k cap bounded it to ~0.7 s plus the candidate pass. **Hypothesis 1 (candidate volume) is correct for the compound path; hypothesis 2 (3 ms/page) is ruled out by §2.** The reported 15 s, however, belongs to §1.2: the three-field postings path on one merged segment.

## 2. Step 2 — per-candidate path audit

`bench.exe --micro 10000` on the full 3.0.0 `corpus.db`:

| Operation | µs/page |
|---|---|
| fetch, row-value `IN (VALUES …)` ×250 (current) | **1.6** |
| fetch, PK point lookup, one connection, `prepare_cached` | 4.0 |
| fetch, PK point lookup, `Connection::open` per call | 273 |
| decode, prepared dictionary (current) | **1.7** (0.02 µs/token) |
| decode, dictionary digested per blob | 6.8 |

- zstd dictionary prepared once, `Decompressor::with_prepared_dictionary` per blob — correct.
- One `Connection::open` per 2,000-page chunk; row-value `IN` batches of 250 on the full primary key — correct and the fastest option measured.
- Verification runs on the raw-id LRU mapped through `def_to_triple`; no `Token` structs — correct.
- Candidates arrive in doc order = `(book, part, page)` order on a reading-order index — no re-sort needed.
- **Fixed:** counting computed all pairs per page; now `forward::has_pair_within` (two-pointer, first pair) counts and full positions are computed only for the returned window.
- **Fixed (shared pagination code, both index kinds):** `order_key`/`keys_of` reopened four fast-field columns per document; now opened once per segment (`SegmentColumns`).

## 3. Step 3 — tier 1: streaming with a cap (`ProximityImpl::Forward`)

`proximity_forward` walks the candidate `DocSet` per segment and verifies chunks of 2,000 on the forward index, stopping when `offset + limit` hits are found or `PROXIMITY_MAX_VERIFY = 20,000` candidates are scanned (`proximity_stop_at_window = false` scans to the cap for a better lower bound). Early stop sets `was_capped`; exhaustion gives an exact count.

Full corpus: first page in **26–39 ms** for the common pairs (603 and 320 candidates scanned); scanning to the 20k cap costs 272–444 ms and reports ≥ 7,992 / ≥ 16,886. The rare pairs' p95 outliers (0.8–3 s once) are first-run cold reads of scattered pages (917 µs/page cold vs 5 µs warm), not code.

## 4. Step 4 — tier 2: positional intersection (`ProximityImpl::Positional`, now the default)

`engine/src/positional.rs`: per segment, one `SegmentPostings` with positions per triple term per slot; each slot is a **heap-based union cursor** (O(m log k) per step for m moved cursors — the first version scanned all k cursors per step and was 5× slower with 2,151 root triples); N-way leapfrog driven from the rarest slot; positions read only when all slots co-occur; a `Matcher` decides (pair within N for proximity, consecutive positions for phrases); optional filter `DocSet` (book ids, fast-field ranges); wall-clock budget (1,500 ms) after which it returns the verified prefix with `was_capped`. No SQLite.

Parity: unit tests against brute-force forward scans (proximity and 3-slot phrase, both drive directions); `compare.py` against the exact forward path on the sample (identical results, counts, positions); rare-pair counts identical to the three-field index at full scale (627, 82).

Full corpus, default configuration:

| Query | co-occurring | hits | p50 ms | exact? | three-field 3.0.0 (§1.2) |
|---|---|---|---|---|---|
| `الله` × root `عرف` (2,151 triples) | 737,325 | **224,250** | **349** | yes | 1,411 ms, "≥ 4,898" |
| `الله` × lemma `قال` (595 triples) | 1.93M of 3.12M | ≥ 1,562,632 | 1,599 | budget (exact = 2,447,865 in 2.4 s) | 2,864 ms, "≥ 10,483" |
| rare × rare | 735 | 627 | 16 | yes | 20 ms |
| common × rare | 774 | 82 | 1.7 | yes | 29 ms |

The same machinery now serves **compound phrases** whose slot alternations exceed the FST regex budget (previously bag-of-words + capped verification): `قال رسول` 420,072 exact in 1.1 s and `قال رسول الله` 411,129 exact in 1.3 s (three-field `PhraseQuery`: 316 / 343 ms, same counts; 0.5.0 compound: "≥ 5,001").

## 5. Defects found and fixed on the way

1. **`page_id` is not unique within a book.** 28,846 `(book_id, page_id)` pairs collide across parts in 45 books (e.g. book 60 numbers parts 0 and 1 both from page 1). The token cache keyed on `(book, page)` and every `page_tokens` lookup dropped `part_index`, so the overlay, variants, forward highlighting and proximity could read the wrong part's tokens in those books (this produced 624 instead of 627 hits for the rare pair). `PageKey` now carries `part_index`; the cache, batch fetch, `get_page_tokens` / `get_token_at` (Tauri), `/page/tokens` (API, `part_index` now required) and the frontend binding pass it. Variants counts on the affected books change accordingly.
2. **Indexer merge order.** Tantivy's default `LogMergePolicy` merged flushed segments in the background in registry order, and the final merge passed `searchable_segment_ids()` unsorted; both scramble the ingestion order. Corpus 3.0.0's index has 33 violations at the 100k-commit boundaries and runs the fallback ordering. Fix: `NoMergePolicy` on the writer plus an explicit final merge sorted by each segment's first-doc reading key (Tantivy preserves the order given). Regression test: 39 forced segments → 0 violations. **The 3.0.0 index needs a rebuild** to regain reading order (results are correct meanwhile).
3. **Book 7524** has a JSONL but no `metadata.db` row and no `corpus.db` pages; it was indexed with empty tokens on the compound index and with text on the three-field one, which is where the −5…−10 count gaps between the two indexes come from. Added to `.indexer_exclude.txt` (307 books).
4. Per-document fast-field column reopening in the shared pagination fallback (§2).

## 6. Full-scale checkpoint, general query set (`queries.json`, 3 runs, p50 ms)

| Case | three-field 3.0.0 | compound + root hedge | notes |
|---|---|---|---|
| surface term common | 80 | 14 | |
| lemma term common (`قال`) | 78 | 34 | |
| lemma term (`كتاب`) | 30 | 10 | |
| root term productive (`قول`) | 96 | 9 | root hedge |
| root term rare | 12 | 3 | |
| lemma phrase 2 / 3 words | 316 / 343 | 1,100 / 1,282 | positional phrase, exact; three-field count identical |
| surface phrase | 78 | 29 | |
| deep offset 4,750 | 88 | 34 | three-field is on fallback ordering |
| combined AND/OR | 100 | 43 | |
| proximity lemma×lemma d=5 | 720 ("≥ 2,460") | 277 (52,082 exact) | |
| proximity root×surface d=10 | 205 ("≥ 1,723") | 54 (1,727 exact) | |
| wildcard prefix / infix | 318 / 128 | 78 / 29 | |
| name search (10 patterns) | 360 | 96 | |
| variants lemma / root | 11,000 / 3,900 | 1,280 / 1,340 | |
| page + tokens ×10 | 74 | 30 | |
| startup (index + codec + triples) | 0.4 s | **4.2 s** | triple maps from SQLite |

Result sets: identical on the sample for all 23 cases. At full scale the first pages differ from the three-field index only because that index is not in reading order (its `death_ah`-tie order is arbitrary); counts differ by book 7524's pages and by the proximity/phrase cases where the three-field number was a lower bound.

## 7. Recommendations

1. **Compound index: `Positional` is the default** for single-word proximity and for wide-alternation phrases; tier-1 streaming remains for phrase-sided proximity. Budget 1,500 ms; the one query that exceeds it (`الله × قال`, 3.1M co-occurring pages) returns 1.56M verified hits as a lower bound. Accepted.
2. **Three-field 3.0.0 (shipping now): the reported regression is here and is left as is per instructions.** Per-candidate postings seeks cost 110–222 µs on one merged segment vs 16–21 µs on 17 segments, so common proximity pairs take 1.4–2.9 s (12,500-candidate lower bound). The fix is the same cursor-reuse idea (one cursor per term walked in doc order, ~40 lines) and does not change result sets. Recommended before 3.0.0 ships with app 0.5.0.
3. **Rebuild the 3.0.0 index** with the fixed indexer (BUILD_CORPUS.md Option A step 3; ~1–2 h) to restore reading order.
4. **Ship the `part_index` key fix** regardless of index kind — it corrects token overlay and variants in 45 books today.
5. **Startup:** triple maps take ~4 s to load at full scale; the deferred `triples.bin` sidecar (plan I.B.2) is now required for 4.0.0.
6. Optional: `proximity_stop_at_window = false` if a better lower bound than "≥ 250" is wanted from the tier-1 path (+0.3–0.4 s).
