# Building the Kashshaf Corpus (3.0.0, schema 3)

**Repo:** `d:\DH Projects\kashshaf-data-clean`
**Applies to:** corpus 3.0.0 (Phase A of [REPORT.md](REPORT.md)); app 0.5.0 or later
**Last updated:** 2026-09-09

This is the operator's guide: what to run, in what order, how long it takes, and how to check the result. Background on why each step exists is in [REPORT_IMPLEMENTATION_PLAN.md](REPORT_IMPLEMENTATION_PLAN.md) Part I; the data formats are in [CORPUS_DATA_MODEL.md](CORPUS_DATA_MODEL.md) ("Schema v3") and [PIPELINE.md](PIPELINE.md) ("Phase A additions").

---

## 1. What is new in corpus 3.0.0

Nothing upstream changes. Stages 1 and 2 of the pipeline (canonical JSON, CAMeL BERT analysis) and the JSONL in `data/processed/` are the same input as for 2.0.0. What changes is how Stages 3 and 4 pack that input.

| Artifact | 2.0.0 | 3.0.0 | Why |
|---|---|---|---|
| `corpus.db` `page_tokens` | raw `uint32` per token, rowid table | `encoding` column; blobs are frequency-ranked LEB128 varints under a trained zstd dictionary (encoding 2); `WITHOUT ROWID` | ~2.4 GB smaller; decode is microseconds |
| `corpus.db` `token_codec` | — | new table: `rank_to_def` (uint32 LE array) and `zstd_dict` | the app loads the codec in two reads |
| `corpus.db` indexes | `idx_token_def_surface`, `idx_token_def_lemma` | `idx_token_def_lemma`, `idx_token_def_root` | surface index was never used; root index makes root-mode variants fast |
| `corpus.db` `db_info.schema_version` | 1 | 3 | app gates on it |
| `metadata.db` | unchanged | unchanged (`corpus_version` string bumped) | |
| Tantivy doc store | LZ4, 16 KiB blocks | zstd, 64 KiB blocks | `.store` ~6.2 → ~4.5 GB |
| Tantivy segments | 18, with tombstones | 1, garbage-collected | smaller, faster, and required for the next row |
| Tantivy doc order | 8 interleaved writer threads | monotonic in `(death_ah, text_id, part_index, page_id)`, verified by `check_order` | the app paginates in reading order without sorting or over-fetching |
| Tantivy schema | — | **unchanged** | `author_id`, `genre_id`, `death_ah`, `century_ah` stay FAST-only; `sort_key` kept |
| Tantivy library | 0.22 | 0.25 with `zstd-compression` | must match the app and API |
| `corpus_manifest.json` `schema_version` | 1 | 2 | forces clients to re-download; `min_app_version` 0.5.0 |

Two version numbers are easy to confuse. `db_info.schema_version` (inside each SQLite file) is 3 for this corpus. `corpus_manifest.json` `schema_version` (what the app's downloader compares) is 2. They are independent counters.

### What users will notice
- Same search results, same highlighting, same texts. Result ordering within a page is unchanged (author death, book, volume, page).
- Corrected page bodies: `patch_jsonl_bodies.py` rewrote `body` in the JSONL in September 2026; since `body` is stored in Tantivy, the rebuilt index is how those fixes reach the reader.
- A ~4 GB smaller download.

### What developers must know
- Apps built without the Tantivy `zstd-compression` feature open the index but cannot read documents. App 0.5.0 has the feature; 0.4.x does not, which is why `min_app_version` is 0.5.0.
- Apps must read `page_tokens.encoding` and decode encoding 2 (see CORPUS_DATA_MODEL.md "Schema v3" for the byte layout and `fixtures/` for test vectors).

---

## 2. Prerequisites

- Rust toolchain (stable) and the indexer built: `cd indexer && cargo build --release`. Produces `kashshaf-indexer.exe`, `merge.exe`, `check_order.exe`, `prune.exe`, `query.exe` in `indexer/target/release/`.
- `venv` with `numpy`, `zstandard`, `pandas`, `openpyxl`, `tqdm` (already present).
- Disk: `corpus.db` recompress needs ~1× its size free for VACUUM (~5 GB); the Tantivy build needs ~1× the final index for the merge (~10 GB) on top of the index itself.
- Time budget: recompress 15–40 min; Tantivy build 1–2 h single-threaded plus ~1 h merge and hashing.
- **Freeze `data/processed/` first.** Anything patched after the Tantivy build starts will not be in the index.

---

## 3. Decide: full rebuild or in-place upgrade?

| You need | Run |
|---|---|
| Only the 3.0.0 packing (same tokens as 2.0.0) | **Option A**: recompress `corpus.db` in place + rebuild Tantivy. No SQLite rebuild from JSONL. |
| Token changes (new books, new morphological overrides, `--force` replacements) | **Option B**: full Stage 3 + Stage 4 from JSONL. |
| A 5% sample to test the app against | **Option C**. |

Option A is the normal case for 3.0.0: the only JSONL change since 2.0.0 was to `body`, which lives in Tantivy, not `corpus.db`.

---

## 4. Option A — in-place upgrade (recommended for 3.0.0)

Work on `data/final-data/`, which holds the shipped 2.0.0 files.

```powershell
cd "d:\DH Projects\kashshaf-data-clean"

# 0. back up
copy data\final-data\corpus.db data\final-data\corpus.db.v2.bak
copy data\final-data\metadata.db data\final-data\metadata.db.v2.bak

# 1. recompress page_tokens (schema v3), keep decoder fixtures for the app tests
venv\Scripts\python build_sqlite_tokens.py --data-dir data\final-data --recompress --zstd-level 9 --fixtures fixtures\full

# 2. sanity
venv\Scripts\python build_sqlite_tokens.py --data-dir data\final-data --status
venv\Scripts\python build_sqlite_tokens.py --data-dir data\final-data --check

# 3. exclude list for the indexer: the in_corpus = 0 book ids from metadata.db, one per line.
#    (ingest_to_index.py writes this file itself only during its own --rebuild/--append runs.)
venv\Scripts\python -c "import sqlite3,os; c=sqlite3.connect('data/final-data/metadata.db'); out=set(r[0] for r in c.execute('SELECT id FROM books WHERE in_corpus=0')); meta=set(r[0] for r in c.execute('SELECT id FROM books')); jsonl=set(int(f[:-6]) for f in os.listdir('data/processed') if f.endswith('.jsonl') and f[:-6].isdigit()); orphan=jsonl-meta; ids=sorted(out|orphan); open('data/final-data/.indexer_exclude.txt','w').write('# in_corpus=0 books, plus JSONL files with no metadata row\n'+''.join(f'{i}\n' for i in ids)); print(len(out),'in_corpus=0 +',sorted(orphan),'without metadata =',len(ids),'excluded')"
cd indexer
target\release\kashshaf-indexer.exe --rebuild ^
    --input ..\data\processed ^
    --index ..\data\final-data\tantivy_index ^
    --exclude ..\data\final-data\.indexer_exclude.txt ^
    --zstd-level 3
target\release\check_order.exe --index ..\data\final-data\tantivy_index
target\release\query.exe --index ..\data\final-data\tantivy_index
cd ..

# 4. stamp the corpus version in both databases
venv\Scripts\python - <<EOF
import sqlite3
for f in ("data/final-data/corpus.db", "data/final-data/metadata.db"):
    c = sqlite3.connect(f); c.execute("UPDATE db_info SET corpus_version='3.0.0'"); c.commit(); c.close()
EOF

# 5. manifest
venv\Scripts\python generate_manifest.py --data-dir data\final-data --corpus-version 3.0.0 --schema-version 2 --min-app-version 0.5.0
```

Notes:
- `--exclude` is mandatory for a correct corpus: `data/processed/` holds 7,483 JSONL files but only 7,176 books are `in_corpus = 1`; the other 307 must not be indexed. The file is one decimal book id per line (`#` lines are comments). Step 3 generates it; `ingest_to_index.py` regenerates it automatically during its own `--rebuild`/`--append` runs.
- `--zstd-level 3` is the indexer default. The plan's Part II benchmark may pick 6; anything above 9 costs build time for little gain on Arabic text.
- The indexer prints a per-extension size table at the end. Record it against REPORT.md §2.

---

## 5. Option B — full Stage 3 + Stage 4 from JSONL

One command runs SQLite build → recompress → index → merge → `check_order`:

```powershell
cd "d:\DH Projects\kashshaf-data-clean"
venv\Scripts\python ingest_to_index.py --rebuild --version 3.0.0 --recompress --zstd-level 3 -y
venv\Scripts\python generate_manifest.py --data-dir data --corpus-version 3.0.0 --schema-version 2 --min-app-version 0.5.0
```

This writes into `data/` (not `final-data/`). Expect several hours: the SQLite build is the slow part (single writer, ~1B tokens). `--workers N` for `build_sqlite_tokens.py` is forwarded by the orchestrator's defaults (CPU count − 2).

Incremental additions later: `build_sqlite_tokens.py --add --corpus-version 3.0.1 [--books ...]` writes new pages as encoding 1; run `--recompress` again afterwards. It reuses the stored rank map and dictionary and appends new definitions, so all blobs stay decodable with the codec the app already loaded. Then `kashshaf-indexer --append` for Tantivy, followed by `merge` and `check_order` (an appended index is no longer in reading order until it is rebuilt; the app falls back to `death_ah` ordering on multi-segment indexes, so prefer a full index rebuild for releases).

---

## 6. Option C — sample corpus (for app development and benchmarks)

```powershell
venv\Scripts\python make_sample.py --fraction 0.05            # -> data/sample/processed (hard links)
venv\Scripts\python ingest_to_index.py --rebuild --version sample --recompress --data-dir data\sample -y
venv\Scripts\python build_sqlite_tokens.py --data-dir data\sample --recompress --fixtures fixtures\sample
```

`make_sample.py --max-books 25 --out data\sample-mini` gives a 25-book set that builds in about three minutes; one already exists at `data/sample-mini/` with fixtures at `fixtures/sample-mini/`. `--check` on a sample reports "in_corpus=1 books without token data" for every book not sampled; that is expected.

---

## 7. Verifying a build

| Check | Command | Expect |
|---|---|---|
| Blob encodings | `build_sqlite_tokens.py --status` | `Blob encodings: 2=<all pages>`, `token_codec.rank_to_def` and `zstd_dict` present, `schema v3` |
| Decode sample | `build_sqlite_tokens.py --check` | `[OK] 500 sampled encoding-2 blobs decode` |
| Reading order | `check_order.exe --index ...` | `Segments: 1`, `Violations: 0`, exit 0 |
| Doc count | `query.exe --index ...` | `Total documents` equals `SELECT COUNT(*) FROM page_tokens` |
| Docstore | `query.exe` | `Docstore: Zstd(...)` |
| Versions | `sqlite3 corpus.db "SELECT * FROM db_info"` and same for `metadata.db` | identical `corpus_version`; schema 3 |
| Sizes | indexer/merge size table | `.store` well below 2.0.0's 6.2 GB; single `.idx/.pos/.term` set |

---

## 8. Publishing

Ship order is fixed: API server first (it must read schema 3 and the zstd store before any client switches), then the app release (0.5.0), then the corpus files and `corpus_manifest.json` to R2. The `min_app_version` gate stops 0.4.x from downloading a corpus it cannot read. Keep 2.0.0 under a versioned prefix on R2 so a manifest rollback is one upload. See [RELEASE_REF.MD](RELEASE_REF.MD) for the R2 and GitHub steps.

---

## 9. Tools reference

| Tool | Purpose |
|---|---|
| `build_sqlite_tokens.py --rebuild/--add/--recompress/--status/--check/--update-counts/--load-metadata [--data-dir]` | Stage 3 |
| `indexer/target/release/kashshaf-indexer.exe --rebuild/--append --input --index --exclude [--zstd-level --blocksize --lz4 --threads --heap-gb --no-merge --no-reading-order]` | Stage 4 |
| `merge.exe --index` | merge an existing index to one segment + GC, with size report |
| `check_order.exe --index [--allow-multi-segment]` | verify reading order |
| `prune.exe --index --exclude [--merge]` | delete books from an existing index |
| `query.exe [--index]` | smoke queries and index stats |
| `ingest_to_index.py --rebuild/--append/--status [--data-dir --recompress --zstd-level --blocksize --threads --no-merge --skip-check-order --tantivy-only --sqlite-only -y]` | orchestrates Stage 3 + 4 |
| `make_sample.py [--fraction --max-books --out --seed --clean]` | stratified sample |
| `generate_manifest.py --data-dir --corpus-version --schema-version --min-app-version` | `corpus_manifest.json` |

---

## 10. Option D — corpus 4.0.0 (compound index, Phase B)

App 0.5.0 reads both index kinds, so 4.0.0 can follow 3.0.0 whenever its full-corpus benchmark is satisfactory (REPORT_IMPLEMENTATION_PLAN.md II.B.5/II.B.6).

```powershell
cd "d:\DH Projects\kashshaf-data-clean"
# from a schema-3 corpus.db (after Option A step 1):
venv\Scripts\python build_sqlite_tokens.py --data-dir data\final-data --build-triples
cd indexer
target\release\kashshaf-indexer.exe --rebuild --compound --keep-root-text ^
    --corpus-db ..\data\final-data\corpus.db ^
    --input ..\data\processed ^
    --index ..\data\final-data\tantivy_index ^
    --exclude ..\data\final-data\.indexer_exclude.txt --zstd-level 3
target\release\check_order.exe --index ..\data\final-data\tantivy_index
cd ..
venv\Scripts\python generate_manifest.py --data-dir data\final-data --corpus-version 4.0.0 --schema-version 3 --min-app-version 0.5.0
```

Or the one-liner from scratch: `python ingest_to_index.py --rebuild --version 4.0.0 --recompress --compound --keep-root-text -y`.

What is new in 4.0.0: `db_info.schema_version` 4 (`triples`, `triple_id`), a `tokens` field of triple ids instead of the three text fields, `root_text` kept without positions, and the alignment check output `Compound mode: alignment mismatches 0, pages without blob 0` in the indexer summary (a non-zero value means `corpus.db` and the JSONL disagree; do not ship). Manifest `schema_version` becomes 3. Benchmark with `engine/target/release/bench.exe --index … --corpus-db … --queries engine/bench/queries.json` and compare against the 3.0.0 report with `engine/bench/compare.py … --ignore-highlights` (root highlights legitimately differ, see PIPELINE.md "Caveat").

---

## 11. Indexer fix of 2026-09-11 — rebuild the 3.0.0 index

The 3.0.0 index built on 2026-09-10 is **not in reading order** (`check_order`: 33 violations at the 100k-document commit boundaries). Cause: Tantivy's default merge policy merged flushed segments in the background in registry order, and the final merge did not sort segments. The indexer now sets `NoMergePolicy` and merges in first-doc reading-key order; `merge.exe` and `prune --merge` do the same. Results on the current index are correct (the app detects the disorder and falls back to `death_ah` ordering), but deep pagination and the proximity candidate pass are slower, and `check_order` must pass before publishing.

Rebuild the index only (corpus.db is unaffected):

```powershell
cd "d:\DH Projects\kashshaf-data-clean\indexer"
cargo build --release
target\release\kashshaf-indexer.exe --rebuild --input ..\data\processed --index ..\data\final-data\tantivy_index --exclude ..\data\final-data\.indexer_exclude.txt --zstd-level 3
target\release\check_order.exe --index ..\data\final-data\tantivy_index      # must print Violations: 0
cd .. && venv\Scripts\python generate_manifest.py --data-dir data\final-data --corpus-version 3.0.0 --schema-version 2 --min-app-version 0.5.0
```

Also new in the exclude list: book 7524 (a JSONL with no `metadata.db` row and no `corpus.db` pages; 307 excluded books now). Any index built before 2026-09-11 contains its 13 pages.
