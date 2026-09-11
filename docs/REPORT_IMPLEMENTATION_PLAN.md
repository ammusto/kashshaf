# Implementing REPORT.md — Storage & Search Rebuild Plan

**Date:** 2026-09-08 (rev. 2)
**Companion to:** [REPORT.md](REPORT.md) (diagnosis and target numbers), [KASHSHAF_SPECIFICATION.md](KASHSHAF_SPECIFICATION.md) v4.0
**Target:** 17.2 GB → ~12.8 GB (Phase A) → ~9.1 GB (Phase B), equal or better latency, identical result sets.

The work splits cleanly along the repo boundary, so this plan is written in two parts that can be executed by different people in parallel:

- **Part I — Data backend** (`kashshaf-data-clean`): everything that produces `corpus.db`, `metadata.db`, and `tantivy_index/`. SQL schema, blob encoding, indexer, manifests.
- **Part II — Application** (`kashshaf-app`): everything that reads those artifacts. The Rust engine shared by the Tauri desktop backend and the axum API server, and the React frontend.

Part III defines the **interface contract** between them (schema versions, blob encoding, triple maps, index schema) so each side can be built and tested against fixtures before the other side is finished. Part IV covers sequencing, releases, and risks.

**Standing decision:** the four numeric fields `author_id`, `genre_id`, `death_ah`, `century_ah` stay in the index exactly as they are today — FAST fast fields, one per document. The space they take is marginal and they are what makes fast-field filtering and `death_ah` ordering possible. No step in this plan changes their type, and Phase B filters are implemented as fast-field range queries rather than by re-indexing them.

---

## 0. Baseline and facts the plan relies on

Baseline (REPORT.md, corpus 2.0.0): 7,176 books · 5,711,697 pages · 987,907,098 tokens · `corpus.db` 5.1 GiB · index 12.1 GiB, 18 segments with tombstones. Current build lives in `kashshaf-data-clean/data/final-data/` (`corpus.db` 5.28 GB, `metadata.db` 41 MB, `tantivy_index/` 71 files after pruning).

Established from the code:

| Fact | Where | Why it matters |
|---|---|---|
| Indexer runs `writer_with_num_threads(8, 2 GB)`, commits every 100k docs, never merges | `indexer/src/main.rs:224, 373` | Source of the 18 segments; doc ids interleave across threads |
| Indexer writes a `sort_key` FAST field (`death_ah*10_000_000 + page_id`) the app never reads | `main.rs:84, 340` | Reading-order pagination needs something better anyway (page_id is per book) |
| `author_id`, `genre_id`, `death_ah`, `century_ah` are FAST only | `main.rs:77-80` | Filters must use fast-field range queries, not term queries |
| `page_tokens` is a rowid table, PK `(book_id, part_index, page_id)`, blobs are `array("I").tobytes()` | `build_sqlite_tokens.py:134-140, 696-726` | A.4 encoding change and `WITHOUT ROWID` |
| App reads blobs with `WHERE book_id = ? AND page_id = ?` (no `part_index`) | `cache.rs:114`, `variants.rs:171` | page_id is unique per book; keep that invariant in any new table |
| `SearchEngine { index, schema }` builds a new `IndexReader` in 14 methods | `src-tauri/src/search.rs:355, 434, …` | 0.6 quick win |
| Tantivy 0.25 has `RegexPhraseQuery`, `TermSetQuery`, `Compressor::Zstd` (feature `zstd-compression`), `IndexSettings.docstore_blocksize` | `~/.cargo/registry/.../tantivy-0.25.0` | Phase A/B feasibility confirmed |
| API server and indexer are on Tantivy 0.22; desktop on 0.25 | `api/Cargo.lock`, `indexer/Cargo.toml` | Must align before a zstd-store index is shipped |
| `generate_manifest.py` already hashes `metadata.db` | `kashshaf-data-clean/generate_manifest.py` | No manifest work needed beyond version bumps |

---

# Part I — Data Backend (`kashshaf-data-clean`)

Owner scope: `build_sqlite_tokens.py`, `indexer/`, `generate_manifest.py`, `data/`. Deliverables are files: `corpus.db`, `metadata.db`, `tantivy_index/`, `corpus_manifest.json`, optionally `triples.bin`.

**Status 2026-09-08 — Phase 0 and Phase A code complete and tested on a 25-book sample; full 3.0.0 rebuild not yet run.**

| Item | State | Evidence |
|---|---|---|
| I.0.1 indexer → Tantivy 0.25 + `zstd-compression` | done | `indexer/Cargo.toml`; release build clean, no warnings |
| I.0.2 path flags | done | `build_sqlite_tokens.py --data-dir`, indexer `--input/--index`, `ingest_to_index.py --data-dir` |
| I.0.3 sample corpus | done | `make_sample.py` (stratified by century × corpus, hard links); `data/sample-mini/` built end to end |
| I.0.4 dbstat breakdown | blocked | Python's SQLite lacks `dbstat`; run with the `sqlite3` CLI or `sqlite3_analyzer` |
| I.0.5 freeze date | open | `data/processed/` still being patched |
| I.A.1 merge + GC | done | `indexer/src/bin/merge.rs`; also the default final step of the indexer and of `prune --merge` |
| I.A.2 zstd docstore | done | `--zstd-level N` (default 3), `--blocksize` (default 65536), `--lz4`; level sweep still to run against Part II's page-load bench |
| I.A.3 reading order + check | done | single writer thread, files sorted by `(death_ah, text_id)`, `check_order` binary (passes on sample; correctly fails on a 4-thread build) |
| I.A.4 recompress | done | `--recompress`; 2.39× on sample blobs (level 9), 2,000-page round-trip verification, fixtures in `fixtures/sample-mini/` |
| I.A.5 trims | done | `idx_token_def_surface` dropped, `idx_token_def_root` added, both in schema and in `--recompress` migration |
| I.A.6 full rebuild + manifest | **built 2026-09-10, needs rebuild** | 3.0.0 built and manifested (11.8 GB) but its index is out of reading order: background `LogMergePolicy` merges + unsorted final merge (fixed 2026-09-11: `NoMergePolicy` + ordered merge). Rebuild the index before publishing. |
| I.B.1 triples (schema 4) | done | `build_sqlite_tokens.py --build-triples`; 288,324 definitions → 214,978 triples on the sample |
| I.B.2 sidecar | deferred | engine loads triples from SQLite in ~90 ms per 200k; decide after the full build |
| I.B.3 compound indexer | done | `kashshaf-indexer --compound --corpus-db … [--keep-root-text]`; both sample variants built, 0 alignment mismatches, `check_order` passes; 38% smaller than three-field |
| I.B.4 full 4.0.0 build | **built to `data/compound-work/`** | 6.03 GB, 58 segments merged in order, `check_order` OK; built before 7524 was excluded, so rebuild for release |
| I.B.2 sidecar | **now required** | triple maps load in ~4 s at full scale (see PROXIMITY_REGRESSION_REPORT.md §7) |

Two contract details changed while implementing (reflected in Part III): encoding 2 puts `varint(n_tokens)` **outside** the zstd frame so token counts are readable without decompressing, and uses a **standard** zstd frame (magic present) rather than magicless, because the Rust `zstd` crate needs an experimental feature to read magicless frames. The rank map and dictionary live in one `token_codec` table as blobs instead of `token_rank` rows and `blob_dict`, so the app loads them in two reads.

## I.0 Foundations

**I.0.1 Tantivy 0.25 in the indexer.** `indexer/Cargo.toml`: `tantivy = { version = "0.25", features = ["zstd-compression"] }`. Fix `prune.rs` and `query.rs` compile breaks. Rebuild nothing yet; confirm `query.rs` opens `final-data/tantivy_index` and returns the same doc count.

**I.0.2 Path flags.** `build_sqlite_tokens.py` hardcodes `PROJECT_ROOT/data` (`:74`). Add `--data-dir` (default unchanged) so a sample can be built into `data/sample/`. Confirm the indexer's `input_dir`/`index_path` are arguments, not constants.

**I.0.3 Sample corpus.** `make_sample.py`: stratified 5% of `data/processed/*.jsonl` by death century × source corpus → `data/sample/processed/`. Build `data/sample/{corpus.db, metadata.db, tantivy_index}` with the current scripts. This is the iteration loop for every later item; full rebuilds happen only at milestone ends.

**I.0.4 Size breakdown.** Run `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC` on `final-data/corpus.db` and record it in REPORT.md §1. Decides I.A.5.

**I.0.5 Freeze.** `data/processed/` and `patch_jsonl_bodies.py` were modified today. Set a content-freeze date before the Phase A rebuild so corpus 3.0.0 does not need an immediate 3.0.1.

## I.A Phase A — same semantics, smaller files

### I.A.1 Merge to one segment, garbage-collect
- New `indexer/src/bin/merge.rs` (or `--merge` on `prune.rs`, which already has the writer pattern):
  ```rust
  let ids = index.searchable_segment_ids()?;
  writer.merge(&ids).wait()?;
  writer.garbage_collect_files().wait()?;
  writer.commit()?;
  ```
- Run on a **copy** of the index; needs ~1× index size of temporary headroom. Record per-extension sizes before/after (`.store .pos .idx .term .fast .fieldnorm`). Expect 0–1.5 GB back from tombstones.

### I.A.2 Zstd doc store
- `indexer/src/main.rs`: replace `Index::create_in_dir` with
  ```rust
  Index::builder()
      .schema(schema.clone())
      .settings(IndexSettings {
          docstore_compression: Compressor::Zstd(ZstdCompressor { compression_level: Some(LEVEL) }),
          docstore_blocksize: 65_536,
          ..Default::default()
      })
      .create_in_dir(path)?
  ```
- Sweep on the sample: levels 3/6/9 × blocks 16 KiB/64 KiB. Hand the six sample indexes to Part II's page-load benchmark; pick the smallest `.store` whose page-load p95 is within +1 ms. Expected `.store` 6.2 → ~4.5 GB.

### I.A.3 Reading-order build
- Sort the JSONL file list by `(death_ah, text_id)`; `death_ah` from `metadata.db` (`NULL` sorts last). Pages inside a file are already `(part_index, page_id)` ascending.
- Ingest with **one** writer thread (`writer_with_num_threads(1, 2_000_000_000)`) so doc ids follow input order; keep the 100k-doc commit cadence; finish with I.A.1's merge so the final single segment has doc ids monotonic in reading order.
- New `indexer/src/bin/check_order.rs`: iterate the segment's fast columns and assert `(death_ah ?? MAX, text_id, part_index, page_id)` is non-decreasing in doc id. The rebuild is rejected if this fails.
- Schema stays as is. `sort_key` may be kept for now (a few MB) and dropped in Phase B once Part II no longer needs a fallback.

### I.A.4 `page_tokens` recompression — implemented
`python build_sqlite_tokens.py --recompress [--zstd-level 9] [--dict-size 112640] [--dict-samples 20000] [--retrain] [--verify-sample 2000] [--fixtures DIR] [--no-vacuum]`, run after `--rebuild`/`--add`. Works on a legacy (pre-v3) `corpus.db` too: it migrates the table shape in place.

1. **Pass 1** streams every encoding-1 blob once: `numpy.bincount` frequencies per `token_definitions.id` and a reservoir sample of raw blobs for dictionary training.
2. **Rank map**: rank 0 = most frequent definition; all ids 1..MAX get a rank. On re-runs without `--retrain`, the stored map is **extended** (new definitions appended by frequency) and the dictionary reused, so incremental `--add` builds stay decodable with the same codec.
3. **Dictionary**: `zstandard.train_dictionary(110 KiB, rank-varint payloads of the sample)`.
4. **Encode** (vectorised): gather `def_to_rank`, LEB128-encode the whole batch in numpy, split by cumulative byte offsets, then per page `varint(n_tokens) || zstd.compress(payload)` with `write_checksum=0, write_content_size=0, write_dict_id=0` (standard frame, magic present).
5. **New table** built alongside, then swapped:
   ```sql
   CREATE TABLE page_tokens (
       book_id    INTEGER NOT NULL,
       part_index INTEGER NOT NULL,
       page_id    INTEGER NOT NULL,
       encoding   INTEGER NOT NULL DEFAULT 1,  -- 1 = raw u32 LE, 2 = ranked varint + dict zstd
       token_ids  BLOB    NOT NULL,
       PRIMARY KEY (book_id, part_index, page_id)
   ) WITHOUT ROWID;
   CREATE TABLE token_codec (key TEXT PRIMARY KEY, data BLOB NOT NULL, meta TEXT);
   -- key 'rank_to_def': uint32 LE array, index = rank, value = token_definitions.id
   -- key 'zstd_dict'  : dictionary bytes; meta = JSON {level, dict_size, definitions, created_at, ...}
   ```
   The PK is unchanged; the app's `(book_id, page_id)` lookup uses the PK prefix as it does today.
6. **Verify** 2,000 random pages round-trip against the old table before the swap (abort and leave the old table if any mismatch), `UPDATE db_info SET schema_version = 3`, optional fixtures, `VACUUM`.
- Fixtures for Part II (`--fixtures DIR`): `blobs_v2.jsonl` (200 pages: keys, `n_tokens`, `def_ids`, `ranks`, `blob_hex`), `zstd_dict.bin`, `rank_to_def.bin`, `README.txt`. A sample set is at `kashshaf-data-clean/fixtures/sample-mini/`.
- `--status` prints the encoding distribution and codec metadata; `--check` decodes 500 sampled encoding-2 blobs. `update_token_counts` reads `n_tokens` from the varint prefix without decompressing.
- Measured on the 25-book sample: blobs 2.39× smaller at level 9 (16.4 → 6.9 MB), `corpus.db` 62 → 34 MB after VACUUM. Expect ~2.4 GB back on the full corpus.

### I.A.5 `corpus.db` trims
- Drop `idx_token_def_surface` (the app queries `token_definitions` by `id`, `lemma_id`, `root_id` only) if I.0.4 shows it is worth it (~0.3 GB).
- Add `CREATE INDEX idx_token_def_root ON token_definitions(root_id)`; the app currently creates only the lemma index at startup, so root-mode variants scan.
- `pages` table is already gone from the build script; confirm it is absent from `final-data/corpus.db`.

### I.A.6 Phase A rebuild and manifest
One command now drives the whole sequence:
```
python ingest_to_index.py --rebuild --version 3.0.0 --recompress --zstd-level <L> -y
```
which runs `build_sqlite_tokens.py --rebuild` → `--recompress` → the indexer (single thread, reading order, zstd docstore, final merge + GC) → `check_order` (fails the run if doc ids are not monotonic). Then `python generate_manifest.py --data-dir data --corpus-version 3.0.0 --schema-version 2 --min-app-version 0.5.0`. Pick `<L>` from Part II's page-load bench (II.A.1); the indexer default is 3. Keep the 2.0.0 files under a versioned prefix on R2 for rollback.

Sample runs: `python make_sample.py --fraction 0.05` then the same command with `--data-dir data/sample`.

**Exit criteria (Part I, Phase A):** `check_order` passes; `corpus.db` ≤ ~2.7 GB; `tantivy_index/` ≤ ~10.5 GB in a single segment; fixtures delivered; Part II's parity harness passes on the sample.

## I.B Phase B — compound triple field

### I.B.1 Triples
- After all books are written:
  ```sql
  CREATE TABLE triples (
      id       INTEGER PRIMARY KEY,
      surface  TEXT    NOT NULL,
      lemma_id INTEGER NOT NULL,
      root_id  INTEGER,
      UNIQUE(surface, lemma_id, root_id)
  );
  ALTER TABLE token_definitions ADD COLUMN triple_id INTEGER;
  CREATE INDEX idx_triples_lemma ON triples(lemma_id);
  CREATE INDEX idx_triples_root  ON triples(root_id);
  CREATE INDEX idx_triples_surface ON triples(surface);
  ```
  Populate from `SELECT DISTINCT surface, lemma_id, root_id FROM token_definitions`, ordered by total frequency so common triples get small ids; backfill `triple_id`. Expected ~3M rows. `db_info.schema_version = 3`.

### I.B.2 Optional sidecar
Only if Part II measures startup > 1 s loading triples from SQLite. `write_sidecar.py` → `triples.bin`: header `{magic "KTRP", version u32, n_defs u32, n_triples u32}` then little-endian arrays `def_to_triple[u32; n_defs]`, `triple_lemma[u32]`, `triple_root[u32]` (0 = null), `surface_offsets[u32; n_triples+1]`, `surface_bytes[u8]`, and `surface_sorted[u32; n_triples]` (triple ids ordered by surface). Listed in the manifest like any other file.

### I.B.3 Indexer: `tokens` field
- The searchable text is now derived from `corpus.db`, not from `surface_text`/`lemma_text`/`root_text` in the JSONL. For each page: decode the blob (port the I.A.4 decoder into the indexer, or depend on `kashshaf-engine` by path), map `def_id → triple_id`, emit `tokens = ids.map(|t| format!("{t:07}")).join(" ")`.
- Schema: remove `surface_text`, `lemma_text`, `root_text`; add `tokens` (whitespace tokenizer, `WithFreqsAndPositions`, not stored). Everything else unchanged: `text_id`, `part_index`, `page_id` (INDEXED|FAST|STORED), the four numeric FAST fields, `part_label`, `page_number`, `body` (STORED, zstd).
- Alignment assertion during the first sample build: `triple_ids.len() == surface_text.split_whitespace().count()` for every page.
- Build the sample **twice**: with and without a hedge field `root_text` at `IndexRecordOption::Basic` (no positions). Part II's checkpoint decides which ships.

### I.B.4 Phase B rebuild
`--rebuild --corpus-version 4.0.0` → `--recompress` → triples → (sidecar) → indexer (compound) → `merge` → `check_order` → manifest with `schema_version 3`, `min_app_version 0.6.0`. Compare final per-extension sizes with REPORT.md §2 (`.store` ~4.5, `.pos` ~1.05, `.idx` ~0.9, `corpus.db` ~2.4; ~9.1 GB, ~9.8 GB with the root hedge).

---

# Part II — Application (`kashshaf-app`)

Owner scope: `src-tauri/`, `api/`, `src/`. Deliverables are app releases and API deploys that read the Part I artifacts.

**Status 2026-09-09 — Phase 0, Phase A and Phase B code complete; all verified on the 25-book sample, not yet on the full corpus.**

| Item | State | Evidence |
|---|---|---|
| II.0.1 API → Tantivy 0.25 | done | `api/Cargo.toml` depends on the engine crate; builds clean |
| II.0.2 shared engine crate | done | `engine/` (`kashshaf-engine`): `search`, `cache`, `blob`, `collectors`, `corpus_db`, `forward`, `triples`, `variants`, `normalize`, `tokens`; `src-tauri` and `api` depend on it by path; the duplicated copies are deleted |
| II.0.3 behaviour fixes | done | `sanitize.ts` keeps `*`; API `limit` clamp 1–250 (`MAX_LIMIT`); `SearchFilters` now **applied** (fast-field range queries), not deleted |
| II.0.4 bench + parity harness | done | `engine/src/bin/bench.rs`, `engine/bench/queries.json` (23 cases), `engine/bench/compare.py`; reports in `engine/bench/reports/` |
| II.0.5 shared `IndexReader` | done | one `IndexReader` with `ReloadPolicy::Manual`; 14 per-call readers removed |
| II.A.1 zstd docstore | done | `zstd-compression` feature on the engine's Tantivy dependency |
| II.A.2 `ReadingOrderCollector` | done | exact `total_hits` + window in one pass; enabled only after a startup scan verifies the single segment is monotonic; `TopDocs` fallback otherwise |
| II.A.3 encoding-2 codec | done | `engine/src/blob.rs` (LEB128 + dictionary zstd), `TokenCache` reads `encoding`, batched `get_ids_batch`; 16 unit tests |
| II.A.4 schema gating | done | `corpus_db::check_corpus_schema_supported` (max 4); indexes created at startup only for schema < 3 |
| II.B.1 `TripleMaps` | done | `engine/src/triples.rs`, CSR reverse maps + surface arena; loads from SQLite (sidecar not needed yet, see below) |
| II.B.2 query translation | done | `TermSetQuery` per word; `RegexPhraseQuery` when the alternation's prefix-trie fits the FST's 1000-state budget, otherwise bag-of-words + forward verification |
| II.B.3 forward-index scan | done | `engine/src/forward.rs`; highlighting, proximity, name and wildcard verification on compound indexes |
| II.B.4 filters on fast fields | done | `RangeQuery` on `author_id`, `genre_id`, `century_ah`, `death_ah`; both index kinds |
| II.B.5 checkpoint 1 | done (sample) | root hedge **kept on** (root term 4.1 → 1.6 ms p50); `RegexPhraseQuery` kept for small alternations (lemma phrase 13 ms vs 95 ms via fallback) |
| II.B.6 checkpoint 2 | done (sample) | `compare.py` three-field → compound: result sets and counts identical for all 23 cases |
| II.B.7 React + docs | done | `SearchResults.was_capped` type + results banner; API spec rewritten; specs updated |
| Full-corpus benchmark | done | `engine/bench/reports/full-*.json`, `prox-full-*.json`; table in PROXIMITY_REGRESSION_REPORT.md §6 |
| Proximity tier 1 / tier 2 | done | streaming forward path with cap; positional intersection (default); see PROXIMITY_REGRESSION_REPORT.md |
| `PageKey` with `part_index` | done | 45 books restart page ids per part; keys now carry `part_index` end to end |
| Sidecar `triples.bin` | **deferred** | 215k triples load in ~90 ms; ~3M would be ~1.5 s from SQLite. Decide after measuring on the full corpus |

Measured on `data/sample-mini` (20,813 pages), p50 in ms, three-field → compound+root-hedge: surface term 1.0 → 3.7; lemma term 1.0 → 4.2; root term 0.9 → 1.6; lemma phrase (2 words) 7.7 → 15.5; proximity lemma×lemma 11.5 → 37; wildcard prefix 9.6 → 12.7; wildcard phrase 108 → 144 (was **33,000** in 0.4.1); deep offset 4,750 27 → 6 (both new); variants unchanged. Index size 42 → 27 MB. Startup +100 ms for triple maps.

Two correctness findings from the parity work: (1) the 0.4.1 multi-word wildcard verification undercounted (`ابن ال*`: 971 reported, 2,418 actual, confirmed by scanning the token blobs); (2) `root_text` positions drift on 9% of pages because the pipeline drops null roots, so root-mode highlights and root proximity were misplaced there in every release up to 0.4.1. Compound-mode forward highlighting is exact.

## II.0 Foundations

**II.0.1 Tantivy 0.25 in the API.** `api/Cargo.toml` `tantivy = "0.22"` → `"0.25"`; fix fast-field and collector API breaks. Verify `/health` reports the same `index_docs` against corpus 2.0.0. This is a prerequisite for reading any Phase A index.

**II.0.2 Shared engine crate.** New workspace member `engine/` (`kashshaf-engine`) with `search.rs`, `cache.rs`, `variants.rs`, `tokens.rs`, `normalize.rs`; `src-tauri` and `api` depend on it by path. While merging the two copies: keep the API's `extract_result()`; make highlight caps an `EngineConfig { result_highlight_cap, page_highlight_cap }` (desktop 5/100, API 20/100) instead of divergent literals; collapse the three `normalize_arabic` copies. Everything below is then written once.

**II.0.3 Behaviour fixes (ship as 0.4.2).** From KASHSHAF_SPECIFICATION.md §22 items 1–3; without them the parity harness compares broken to broken.
- `src/utils/sanitize.ts:9`: remove `*` from the class; unit test `stripPunctuation('أب*') === 'أب*'`.
- API `limit` cap 100 → 250 (`api/src/main.rs`, every `.min(100)`), so online load-more stops skipping rows.
- `SearchFilters`: the frontend only sends `book_ids`. Keep the five fields (they are implemented in II.B.5 on fast fields), but until then document them as "accepted, not applied" in `KASHSHAF_API_SPEC.md`.

**II.0.4 Benchmark and parity harness.**
- `engine/src/bin/bench.rs --index --corpus-db --queries engine/bench/queries.json --runs N` → JSON with p50/p95, `total_hits`, ordered `(text_id, part_index, page_id)` for the first 250 results, and matched positions for the first 50, per query.
- `queries.json`: surface term common/rare; lemma term common (`قال`, `كتاب`)/medium/rare; root term productive (`ق.#.ل`, `ع.ل.م`)/rare; lemma phrases of 2 and 3 common words; surface phrase; proximity lemma×lemma d=5 and root×surface d=10; wildcard `أب*`, `أح*مد`, `ابن ال*`; a captured 4-form name payload (~200 patterns); variants for one common lemma and one productive root; page+token load for 200 random `(book, page)` pairs; deep-offset boolean search (offset 4,750).
- `engine/bench/compare.py old.json new.json`: fail on any result-set difference, any p95 regression > 10%, or any highlight set in `new` that is not a superset of `old`.
- Record **baseline** on corpus 2.0.0. Every step below is accepted only against it.

**II.0.5 One `IndexReader`.** `SearchEngine { index, schema, reader }`, built once in `open()` with `ReloadPolicy::Manual`; all 14 sites use `self.reader.searcher()`. Also fix `search()` deciding phrase-vs-term from a `HashSet` (`search.rs:454-459`). Expect tens of ms per query back; results identical.

## II.A Phase A — read the new artifacts, paginate by document order

### II.A.1 Zstd docstore support
Add `features = ["zstd-compression"]` to tantivy in `engine/Cargo.toml` (and thus the desktop and API builds). Without it the store cannot be decompressed. Run the page-load benchmark against Part I's six sample indexes and return the chosen level/blocksize.

### II.A.2 `ReadingOrderCollector`
- `engine/src/collectors.rs`: `ReadingOrderCollector { offset, limit }` with `requires_scoring = false`. The segment collector counts every hit and records `DocAddress` only for hits whose running index falls in `[offset, offset+limit)`; `merge_fruits` concatenates in segment order. One pass returns exact `total_hits` and the page without fetching `offset` documents.
- Replace `TopDocs::order_by_u64_field("death_ah") + sort_results_by_reading_order + skip(offset)` in `search`, `combined_search`, `name_search`, and the single-term `wildcard_search` path.
- Guard: if `searcher.segment_readers().len() > 1` (unmerged index) fall back to the current `death_ah` ordering path, using the existing `sort_key` fast field as tiebreak. Keep `sort_results_by_reading_order` as a `debug_assert!` that the collected page is already ordered.
- Bench: deep-offset query should cost about the same as the first page.

### II.A.3 Blob codec (encoding 2)
- `engine/src/blob.rs`: at startup load `token_rank` into `Vec<u32>` (~18 MB) and `blob_dict` into `zstd::bulk::Decompressor::with_dictionary`. `decode(blob, encoding) -> Result<Vec<u32>>`: encoding 1 → `chunks_exact(4)`; encoding 2 → decompress into a reusable buffer sized from the leading varint, LEB128-decode, map rank → def_id. Malformed input returns `Err`, never panics.
- Read `encoding, token_ids` in `cache.rs` and `variants.rs`; batch the variants scan into `IN`-chunked prepared statements instead of one `query_row` per hit.
- Tests: round-trip against Part I's `fixtures/blobs_v2.jsonl` + `dict.bin`; property test encode→decode identity (a tiny Rust encoder in tests only); fuzz truncated/garbage blobs.
- Remove the runtime `CREATE INDEX IF NOT EXISTS idx_token_def_lemma` from `state.rs` and `api/src/main.rs` once schema 2 guarantees both lemma and root indexes; keep it behind `if schema_version < 2`.

### II.A.4 Version gating
`check_corpus_status` already flags a schema change as `update_required`. Confirm app 0.5.0 opens schema 1 **and** 2 (the encoding column makes this trivial) so users who have not re-downloaded keep working; refuse schema ≥ 3 with a clear message.

### II.A.5 React
No functional change. Verify the reader, prev/next, overlay, variants, and export flows on the sample corpus in `npm run tauri dev`, and the web build against a locally running API on the sample.

**Exit criteria (Part II, Phase A):** `compare.py` passes against baseline for every query on both the sample and the full 3.0.0 corpus; deep-offset latency O(limit); page load p95 ≤ baseline + 1 ms; token load p95 ≤ baseline + 0.1 ms.

## II.B Phase B — triple-id query translation

### II.B.1 `TripleMaps`
- `engine/src/triples.rs`: `def_to_triple: Vec<u32>`, `triple_lemma: Vec<u32>`, `triple_root: Vec<u32>`, surface arena + offsets, `lemma_to_triples: HashMap<u32, Vec<u32>>`, `root_to_triples: HashMap<u32, Vec<u32>>`, `surface_to_triples: HashMap<String, Vec<u32>>`, `surface_sorted: Vec<u32>`.
- Loader A: from `corpus.db` `triples` + `token_definitions.triple_id`. Measure startup on the full corpus; if > 1 s, Loader B: mmap `triples.bin` (Part I.B.2) with the SQLite path as fallback when the file is absent or its version mismatches. Print resident size in debug builds; budget 150–250 MB.

### II.B.2 Query translation (`engine/src/query_builder.rs`, behind Cargo feature `compound` until it replaces the old path)
- `triples_for(mode, word) -> Vec<u32>`: surface → `surface_to_triples[normalize_arabic(word)]`; lemma → `lemma_to_triples[lemma_id(word)]`; root → `root_to_triples[root_id(normalize_root_query(word))]`.
- Single word → `TermSetQuery` on `tokens` with `Term::from_field_text(tokens, &format!("{t:07}"))`.
- Phrase → `RegexPhraseQuery` with one alternation per position (`^(0001234|0009876)$`, slop 0). Fallback: `BooleanQuery(Must TermSetQuery per position)` + forward-index adjacency (II.B.3).
- Remove every `get_field("surface_text"|"lemma_text"|"root_text")`; `get_search_field` and `build_term_query` go away.

### II.B.3 Forward-index scan replaces postings
- `engine/src/forward.rs`: `matches(ids: &[u32], sets: &[HashSet<u32>]) -> Vec<u32>` (all match start positions, no cap), `min_distance(a, b) -> Option<u32>`, `adjacent(...)`.
- Highlighting: `TokenCache` gains `get_ids(key) -> Arc<Vec<u32>>` so overlay and highlighting share one decoded blob; result rows fetch the page's ≤250 blobs in one `IN` statement; positions computed by membership after `def_to_triple`. Drops the 5-position cap in results.
- Proximity: candidates = `Must(TermSetQuery(t1)) AND Must(TermSetQuery(t2))` + book filter through `ReadingOrderCollector`; verification via `min_distance`; `total_hits` exact when all candidates are verified, capped at 50k with a `was_capped` flag otherwise (mirrors `variants.was_sampled`).
- Wildcard: prefix/infix expansion over `surface_sorted` (binary search, suffix filter) → triple set → `TermSetQuery`; delete `RegexQuery`, the FST range scan, and the SQLite phrase recomputation in `commands.rs`. Validation rules unchanged. *(2026-09-11: the 200,000-word refusal was replaced by a per-slot threshold with a bitset path for wide phrase slots, and the 2-letter internal-wildcard rule was dropped; see WILDCARD_REWORK_REPORT.md.)*
- Name search: phrases through II.B.2; fan-out 1–3 triples per word.
- Variants: same scan with per-position sets = `lemma_to_triples`/`root_to_triples`, tallying `triple_surface` tuples; delete `lemma_candidates_for_query` SQL.

### II.B.4 Filters on fast fields (no schema change)
The four numeric fields remain FAST-only. Apply `SearchFilters` as fast-field range queries on the `tokens` query's `BooleanQuery`:
- `author_id`, `genre_id`, `century_ah` → `RangeQuery` with inclusive equal bounds on the fast column;
- `death_ah_min`/`death_ah_max` → `RangeQuery` with the given bounds;
- `book_ids` unchanged (`TermQuery` on the indexed `text_id`).
Add a bench query per filter type. Then update `KASHSHAF_API_SPEC.md` to say the filters are applied, and expose date/genre filters in the React sidebar only if wanted; the engine work does not depend on UI.

### II.B.5 Checkpoint 1 (sample): decide hedges
Run the baseline queries on Part I's two sample indexes. Rules: root term p95 > 2× baseline → ship the `root_text` Basic hedge and route single-word root queries to it; lemma phrase p95 > 150 ms on common words → phrases use the fallback path. Record decisions in REPORT.md.

### II.B.6 Checkpoint 2: parity, then full corpus
`compare.py` Phase A engine/Phase A sample vs Phase B engine/Phase B sample: result sets identical; positions in B ⊇ A; proximity `total_hits` in B ≥ A. Then run against the full 4.0.0 build.

### II.B.7 React and docs
- Highlighting no longer capped: remove the "first 5 positions" assumption in `useReaderNavigation.loadResultIntoTab` (it re-fetches only when `matched_token_indices` is empty; that logic still works but becomes rarely needed).
- Proximity `was_capped` surfaces like the variants sampling banner in `ResultsPanel`.
- Update KASHSHAF_SPECIFICATION.md §6.3, §8, §10.3, §17.3; `KASHSHAF_API_SPEC.md`; PIPELINE.md Stages 3–4; CORPUS_DATA_MODEL.md (`triples`, `token_rank`, `blob_dict`, `encoding`).
- App 0.6.0 ships with the `compound` feature removed and the three-field code deleted.

---

# Part III — Interface Contract (what each side promises the other)

| Item | Owner | Consumer | Definition |
|---|---|---|---|
| `db_info.schema_version` (in both DBs) | I | II | 1 = original; 2 = `parts` column (already written by the current script); **3 = Phase A** (`encoding` column, `WITHOUT ROWID`, `token_codec`, root index, surface index dropped); 4 = Phase B (`triples`, `triple_id`). Distinct from `corpus_manifest.schema_version` (1 today → **2** for Phase A → 3 for Phase B), which is what the app uses to force re-downloads. App refuses `db_info` versions it does not know. |
| Blob encoding 1 | I | II | Little-endian `u32` per token, no header (unchanged). |
| Blob encoding 2 | I | II | `varint(n_tokens)` (unsigned LEB128, **outside** the frame) followed by one **standard** zstd frame (magic present, no checksum, no content size, no dict id) compressed with dictionary `token_codec['zstd_dict']`. Decompressed payload = `n_tokens` unsigned LEB128 varints, each a `rank`. `def_id = rank_to_def[rank]` where `token_codec['rank_to_def']` is a uint32 LE array. Rust: `zstd::bulk::Decompressor::with_dictionary`, capacity `n_tokens * 5`. |
| `page_tokens` key | I | II | PK `(book_id, part_index, page_id)` unchanged; `(book_id, page_id)` stays unique per book and the app's lookup uses the PK prefix. Read `encoding` alongside `token_ids`. |
| Fixtures | I | II | `fixtures/<sample>/blobs_v2.jsonl` (200 pages: keys, `n_tokens`, `def_ids`, `ranks`, `blob_hex`), `zstd_dict.bin`, `rank_to_def.bin`, `README.txt`. Delivered: `kashshaf-data-clean/fixtures/sample-mini/`. |
| Index schema, Phase A | I | II | Unchanged from today (three text fields, `sort_key`, four FAST numeric fields, `body` stored) but zstd docstore, single segment, doc ids monotonic in `(death_ah ?? MAX, text_id, part_index, page_id)`. |
| Index schema, Phase B | I | II | `tokens` text field of zero-padded 7-digit triple ids, whitespace tokenizer, positions; optional `root_text` with `IndexRecordOption::Basic` (`--keep-root-text`, the root hedge, which the engine prefers for single-word root queries); the four FAST numeric fields untouched; three old text fields removed. The engine detects the kind from the schema (`tokens` present → compound). |
| `triples` (schema 4) | I | II | `triples(id, surface, lemma_id, root_id)` ordered by best definition rank; `token_definitions.triple_id`; indexes on `lemma_id`, `root_id`, `surface`, and `idx_token_def_triple`. Built by `build_sqlite_tokens.py --build-triples` (after `--recompress`); `db_info.schema_version = 4`. The engine matches query surfaces against **normalized** triple surfaces. |
| `triples.bin` sidecar | I | II | Not built. Engine loads from SQLite (~90 ms per 200k triples). Revisit if full-corpus startup exceeds ~1.5 s. |
| `SearchResults.was_capped` | II | clients | Optional boolean; present only when `total_hits` is a lower bound (verification stopped at 50,000 candidates). |
| Tantivy version | II | I | Both sides on 0.25 with `zstd-compression` from Phase A on. |
| Docstore parameters | II decides, I builds | | Level and block size chosen from II.A.1's benchmark on I.A.2's six sample indexes. |
| Bench sample indexes | I | II | The six I.A.2 variants and the two I.B.3 variants, on the 5% sample. |

---

# Part IV — Sequencing, releases, risks

## Sequence and handoffs

```
Part I (data)                              Part II (app)
─────────────────────────────────────────  ─────────────────────────────────────────
I.0.1 indexer → 0.25                       II.0.1 API → 0.25
I.0.2 path flags                           II.0.2 engine crate
I.0.3 sample corpus  ──── sample ────────► II.0.4 harness + baseline
I.0.4 dbstat                               II.0.3 fixes → ship 0.4.2
I.0.5 freeze date                          II.0.5 shared reader
I.A.1 merge (measure)                      II.A.2 ReadingOrderCollector
I.A.2 six zstd samples ── indexes ───────► II.A.1 page-load bench ── level/block ──► I.A.2 final
I.A.3 reading-order + check_order
I.A.4 recompress ──── fixtures ──────────► II.A.3 blob codec
I.A.5 trims                                II.A.4 gating
I.A.6 full 3.0.0 build ── files ─────────► II.A parity on full corpus → ship API, then 0.5.0, then manifest
I.B.1 triples                              II.B.1 TripleMaps (measure startup) ── need sidecar? ──► I.B.2
I.B.3 two sample indexes ── indexes ─────► II.B.2/3/4 → II.B.5 checkpoint ── hedge decision ──► I.B.3 final
I.B.4 full 4.0.0 build ── files ─────────► II.B.6 parity → ship API, then 0.6.0, then manifest
```

Ship order at each milestone is fixed: API deploy first (it must read the new files before any client switches), then app release, then corpus files + manifest (the `min_app_version` gate stops older apps from downloading a schema they cannot read).

## Versions

| Milestone | Corpus | Manifest schema | `db_info.schema_version` | App / API | Update type |
|---|---|---|---|---|---|
| 0.4.1 (shipped) | 2.0.0 | 1 | 1 (corpus.db) / 2 (metadata.db) | 0.4.1 | — |
| Phase 0 + A + B code | any of the above | — | — | **0.5.0** | optional against 2.0.0; reads schema 1–4 and both index kinds |
| Phase A data | 3.0.0 | 2 | 3 | 0.5.0 | required (`min_app_version 0.5.0`: zstd store + encoding 2) |
| Phase B data | 4.0.0 | 3 | 4 | 0.5.0 | required (`min_app_version 0.5.0`: compound `tokens` field) |

The plan's separate 0.4.2 (fixes only) and 0.6.0 (Phase B) releases were folded into one 0.5.0 codebase because the engine detects the index kind and the blob encoding at startup, so a single app version can read every corpus from 2.0.0 to 4.0.0. Cut releases from it in whatever order the data builds land.

## Rollback
Corpus files stay on R2 under versioned prefixes; pointing the manifest back restores the previous state for any client that has not downloaded. Apps 0.5.x read schema 1 and 2; 0.6.x read 2 and 3, so a manifest rollback by one version never strands a client.

## Risks
| Risk | Mitigation |
|---|---|
| Root-term queries slow on productive roots | II.B.5 rule; `root_text` Basic hedge (+0.7 GB) |
| `RegexPhraseQuery` slow on wide alternations | Fallback to TermSet AND + forward adjacency; decided at II.B.5 |
| Startup memory +150–250 MB | Sidecar mmap (I.B.2); lazy reverse maps |
| Merge needs ~1× index temp space | Merge on a copy; delete old index after `check_order` |
| Engine copies drift again | II.0.2 shared crate is a hard prerequisite for II.A |
| Pipeline content still changing | I.0.5 freeze before the 3.0.0 build |
| Fast-field range filters slower than term filters | They only apply when a user sets a filter; bench per filter in II.B.4; if slow, intersect with `book_ids` resolved client-side as today |
| Web build | API response shapes do not change in either phase |

## Effort
Part I: Phase 0 ~3 days; Phase A ~5 days + two full builds (several hours SQLite, 1–2 h indexer, ~1 h merge, ~1 h hashing/upload of ~13 GB); Phase B ~6 days + one build. Part II: Phase 0 ~5 days; Phase A ~5 days; Phase B ~15–20 days including both checkpoints. The two parts overlap almost entirely; the critical path is Part II Phase B.
