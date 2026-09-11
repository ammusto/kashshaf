# Corpus Database: Data Model & Token Compression

This document explains the data architecture of `corpus.db`, a SQLite database designed for efficient storage and retrieval of tokenized Arabic text corpora.

---

## Overview

The corpus database uses a **normalized, deduplicated token storage model** that achieves significant compression by storing each unique token definition only once, then referencing it by ID across all occurrences. This is especially effective for Arabic text where morphological forms repeat frequently.

**Key metrics (example):**
- Compression ratio: typically **10-50x** (total tokens / unique token definitions)
- Storage: ~500MB for millions of tokens

---

## Schema Architecture

The database follows a **star schema** pattern with lookup/dimension tables surrounding the core token and page tables.

### Entity Relationship Diagram

```
                    ┌─────────────┐
                    │   authors   │
                    │─────────────│
                    │ id (PK)     │
                    │ author      │
                    └──────┬──────┘
                           │
┌─────────────┐            │           ┌─────────────┐
│   genres    │            │           │corpus_builds│
│─────────────│            │           │─────────────│
│ id (PK)     │            │           │ id (PK)     │
│ genre       │            │           │ corpus_ver  │
└──────┬──────┘            │           │ schema_ver  │
       │                   │           │ built_at    │
       │         ┌─────────┴─────────┐ │ counts...   │
       └────────►│      books        │─└─────────────┘
                 │───────────────────│
                 │ id (PK)           │
                 │ corpus            │
                 │ title             │
                 │ author_id (FK)    │
                 │ genre_id (FK)     │
                 │ death_ah          │
                 │ century_ah        │
                 │ page_count        │
                 │ token_count       │
                 │ ...               │
                 └────────┬──────────┘
                          │
          ┌───────────────┼───────────────────────┐
          │               │                       │
          ▼               ▼                       │
   ┌─────────────┐ ┌─────────────┐                │
   │    pages    │ │ page_tokens │                │
   │─────────────│ │─────────────│                │
   │ book_id     │ │ book_id     │                │
   │ part_index  │ │ part_index  │                │
   │ page_id     │ │ page_id     │                │
   │ part_label  │ │ token_ids   │◄───── BLOB     │
   │ page_number │ │ (u32 BLOB)  │                │
   │ token_count │ └─────────────┘                │
   └─────────────┘                                │
                                                  │
                                                  │
                    ┌──────────────────────────┐  │
                    │    token_definitions     │  │
                    │──────────────────────────│  │
                    │ id (PK)                  │◄─┘
                    │ surface                  │     (referenced by ID)
                    │ lemma_id (FK)            │
                    │ root_id (FK, nullable)   │
                    │ pos_id (FK)              │
                    │ feature_set_id (FK)      │
                    │ clitic_set_id (FK)       │
                    └───────────┬──────────────┘
                                │
        ┌───────────┬───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────────┐ ┌───────────┐
   │ lemmas  │ │  roots  │ │pos_types│ │feature_sets│ │clitic_sets│
   │─────────│ │─────────│ │─────────│ │─────────── │ │───────────│
   │ id (PK) │ │ id (PK) │ │ id (PK) │ │ id (PK)    │ │ id (PK)   │
   │ lemma   │ │ root    │ │ pos     │ │ features   │ │ clitics   │
   │ (UNIQUE)│ │ (UNIQUE)│ │ (UNIQUE)│ │ (UNIQUE)   │ │ (UNIQUE)  │
   └─────────┘ └─────────┘ └─────────┘ └────────────┘ └───────────┘
```

---

## Table Definitions

### Lookup/Dimension Tables

These tables store unique values once and provide integer IDs for foreign key references:

| Table | Column | Description |
|-------|--------|-------------|
| **roots** | `root` | Arabic trilateral/quadrilateral roots (e.g., ك-ت-ب) |
| **lemmas** | `lemma` | Dictionary headwords/lemmas |
| **pos_types** | `pos` | Part-of-speech tags (NOUN, VERB, ADJ, etc.) |
| **feature_sets** | `features` | JSON array of morphological features |
| **clitic_sets** | `clitics` | JSON array of attached clitics |

**Example `feature_sets.features` value:**
```json
["definite", "masculine", "singular", "nominative"]
```

**Example `clitic_sets.clitics` value:**
```json
["wa+", "bi+"]
```

### Core Token Table

**`token_definitions`** - The heart of the compression system:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Unique token definition ID |
| `surface` | TEXT | The actual word form as it appears in text |
| `lemma_id` | INTEGER FK | Reference to lemmas table |
| `root_id` | INTEGER FK | Reference to roots table (nullable) |
| `pos_id` | INTEGER FK | Reference to pos_types table |
| `feature_set_id` | INTEGER FK | Reference to feature_sets table |
| `clitic_set_id` | INTEGER FK | Reference to clitic_sets table |

**Unique constraint:** `(surface, lemma_id, root_id, pos_id, feature_set_id, clitic_set_id)`

This means the same surface form with different analyses (different lemma, different POS, etc.) gets separate entries.

### Page Storage Tables

**`pages`** - Page metadata:

| Column | Type | Description |
|--------|------|-------------|
| `book_id` | INTEGER | Book this page belongs to |
| `part_index` | INTEGER | Volume/part number (0-indexed) |
| `page_id` | INTEGER | Page sequence within part |
| `part_label` | TEXT | Human-readable part label (e.g., "الجزء الأول") |
| `page_number` | TEXT | Page number as printed (may be non-numeric) |
| `token_count` | INTEGER | Number of tokens on this page |

**Primary key:** `(book_id, part_index, page_id)`

**`page_tokens`** - The compressed token data:

| Column | Type | Description |
|--------|------|-------------|
| `book_id` | INTEGER | Book reference |
| `part_index` | INTEGER | Part/volume reference |
| `page_id` | INTEGER | Page reference |
| `token_ids` | **BLOB** | Packed array of token definition IDs |

**Primary key:** `(book_id, part_index, page_id)`

---

## Token Compression: How It Works

### The Compression Strategy

Instead of storing full token data for each occurrence:

```
❌ Naive approach (repeated data):
Page 1: {"surface": "الكتاب", "lemma": "كتاب", "root": "ك-ت-ب", "pos": "NOUN", ...}
Page 5: {"surface": "الكتاب", "lemma": "كتاب", "root": "ك-ت-ب", "pos": "NOUN", ...}
Page 42: {"surface": "الكتاب", "lemma": "كتاب", "root": "ك-ت-ب", "pos": "NOUN", ...}
... repeated thousands of times
```

The system stores each unique combination once and references by ID:

```
✅ Compressed approach:
token_definitions[12345] = {surface: "الكتاب", lemma_id: 100, root_id: 50, ...}

page_tokens for Page 1:  [..., 12345, ...]
page_tokens for Page 5:  [..., 12345, ...]
page_tokens for Page 42: [..., 12345, ...]
```

### Binary Blob Format

The `token_ids` column stores tokens as a **packed binary array** of unsigned 32-bit integers:

```python
from array import array

# Encoding (in build script):
token_ids = array("I")  # 'I' = unsigned 32-bit integers
for token in page_tokens:
    token_ids.append(token_definition_id)
blob = token_ids.tobytes()  # Stored in SQLite

# Decoding (in application):
token_ids = array("I")
token_ids.frombytes(blob_from_db)
# Now token_ids[i] gives the token_definition.id for the i-th token
```

**Storage efficiency:**
- Each token reference = 4 bytes (unsigned int)
- vs. ~100+ bytes for full JSON token data
- **25x+ compression** at the token storage level

### Multi-Level Normalization

The schema applies normalization at multiple levels:

1. **String deduplication**: Lemmas, roots, POS tags stored once each
2. **Feature set deduplication**: Identical feature arrays stored once
3. **Token definition deduplication**: Same morphological analysis stored once
4. **Reference compression**: All stored as small integer IDs
5. **Binary packing**: Token sequences stored as compact byte arrays

---

## Book & Metadata Structure

### `books` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Unique book identifier |
| `corpus` | TEXT | Source corpus name |
| `title` | TEXT | Book title |
| `author_id` | INTEGER FK | Reference to authors table |
| `death_ah` | INTEGER | Author's death year (Hijri) |
| `century_ah` | INTEGER | Century (Hijri) |
| `genre_id` | INTEGER FK | Reference to genres table |
| `page_count` | INTEGER | Total pages in book |
| `token_count` | INTEGER | Total tokens in book |
| `original_id` | TEXT | ID in source corpus |
| `paginated` | INTEGER | Whether book has pagination info |
| `tags` | TEXT | Additional tags |
| `book_meta` | TEXT | Additional book metadata (JSON) |
| `author_meta` | TEXT | Additional author metadata (JSON) |

### `authors` and `genres` Tables

Simple reference tables loaded from Excel files:
- `authors(id, author)` - Author names
- `genres(id, genre)` - Genre categories

### `corpus_builds` Table

Tracks database build history:

| Column | Description |
|--------|-------------|
| `corpus_version` | Version string (e.g., "1.0.0") |
| `schema_version` | Internal schema version number |
| `built_at` | ISO timestamp of build |
| `book_count` | Total books at build time |
| `page_count` | Total pages at build time |
| `token_count` | Total tokens at build time |

---

## Data Flow: Build Process

### Input Format

Source data comes from JSONL files (one per book), where each line is a page:

```json
{
  "part_index": 0,
  "page_id": 1,
  "part_label": "المقدمة",
  "page_number": "أ",
  "tokens": [
    {
      "surface": "بسم",
      "lemma": "اسم",
      "root": "س-م-و",
      "pos": "NOUN",
      "features": ["genitive", "masculine", "singular"],
      "clitics": ["bi+"]
    },
    ...
  ]
}
```

### Processing Pipeline

```
┌─────────────────┐
│  JSONL Files    │  Input: one file per book
│  (*.jsonl)      │  Each line = one page with tokens
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Worker Process  │  Parallel: CPU_COUNT - 2 workers
│ (JSON parsing)  │  Parse JSON, extract token tuples
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Result Queue   │  Inter-process communication
│                 │  ProcessedBook objects
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Database Writer │  Single writer (SQLite constraint)
│ (main process)  │  Caches, deduplication, batch inserts
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   corpus.db     │  Output: SQLite database
│                 │  Normalized, compressed tokens
└─────────────────┘
```

### Caching Strategy

The `DatabaseWriter` maintains in-memory caches to avoid repeated lookups:

```python
lemma_cache: dict[str, int]    # lemma text → lemma_id
root_cache: dict[str, int]     # root text → root_id
pos_cache: dict[str, int]      # POS tag → pos_id
feat_cache: dict[str, int]     # features JSON → feature_set_id
clit_cache: dict[str, int]     # clitics JSON → clitic_set_id
token_cache: dict[tuple, int]  # (surface, lemma_id, ...) → token_def_id
```

For incremental builds, these caches are pre-loaded from the existing database.

---

## Query Patterns

### Reconstructing Page Tokens

```sql
-- Get all tokens for a specific page with full details
SELECT
    td.surface,
    l.lemma,
    r.root,
    pt.pos,
    fs.features,
    cs.clitics
FROM page_tokens pg
JOIN token_definitions td ON td.id IN (
    -- Application must unpack the BLOB and query each ID
)
JOIN lemmas l ON l.id = td.lemma_id
LEFT JOIN roots r ON r.id = td.root_id
JOIN pos_types pt ON pt.id = td.pos_id
JOIN feature_sets fs ON fs.id = td.feature_set_id
JOIN clitic_sets cs ON cs.id = td.clitic_set_id
WHERE pg.book_id = ? AND pg.part_index = ? AND pg.page_id = ?
```

In practice, the application:
1. Fetches the `token_ids` BLOB
2. Unpacks it to get an array of token definition IDs
3. Fetches token definitions in batch
4. Joins with lookup tables to get full token data

### Finding All Occurrences of a Surface Form

```sql
-- Find all pages containing a specific word
SELECT DISTINCT p.book_id, p.part_index, p.page_id, b.title
FROM token_definitions td
JOIN page_tokens pt ON pt.token_ids LIKE '%' || ? || '%'  -- Approximate
JOIN pages p ON p.book_id = pt.book_id
    AND p.part_index = pt.part_index
    AND p.page_id = pt.page_id
JOIN books b ON b.id = p.book_id
WHERE td.surface = ?
```

Note: Searching within BLOBs requires application-level unpacking for accuracy.

### Corpus Statistics

```sql
-- Token frequency across corpus
SELECT td.surface, l.lemma, COUNT(*) as frequency
FROM token_definitions td
JOIN lemmas l ON l.id = td.lemma_id
GROUP BY td.id
ORDER BY frequency DESC
LIMIT 100;
```

---

## Performance Characteristics

### Storage Efficiency

| Aspect | Typical Value |
|--------|---------------|
| Bytes per token reference | 4 (uint32) |
| Compression ratio | 10-50x |
| Database size for 10M tokens | ~200-500 MB |

### Build Performance

| Metric | Typical Value |
|--------|---------------|
| Pages/second | 1,000-5,000 |
| Tokens/second | 50,000-200,000 |
| Worker utilization | CPU_COUNT - 2 |

### SQLite Optimizations

```sql
PRAGMA journal_mode=WAL;        -- Write-ahead logging
PRAGMA synchronous=NORMAL;      -- Balanced durability
PRAGMA temp_store=MEMORY;       -- In-memory temp tables
PRAGMA cache_size=-500000;      -- ~500MB page cache
PRAGMA mmap_size=30000000000;   -- Memory-mapped I/O
```

---

## Indexes

```sql
CREATE INDEX idx_token_def_surface ON token_definitions(surface);
CREATE INDEX idx_pages_book ON pages(book_id);
CREATE INDEX idx_books_author ON books(author_id);
CREATE INDEX idx_books_genre ON books(genre_id);
```

These support common query patterns:
- Looking up tokens by surface form
- Fetching all pages for a book
- Filtering books by author or genre

---

## Summary

The corpus database achieves efficient storage through:

1. **Normalized lookup tables** - Strings stored once, referenced by integer IDs
2. **Deduplicated token definitions** - Each unique morphological analysis stored once
3. **Binary-packed token sequences** - Pages store compact arrays of token IDs
4. **Batch processing** - Multiprocess parsing with single-writer pattern
5. **Aggressive caching** - In-memory caches avoid repeated database lookups

This design is optimized for:
- Large-scale corpus storage (millions of tokens)
- Efficient morphological search and analysis
- Incremental updates without full rebuilds
- Fast sequential access to page content
---

## Schema v3 (Phase A, September 2026)

Implemented in `kashshaf-data-clean/build_sqlite_tokens.py` (`SCHEMA_VERSION = 3`, applied by `--rebuild` and, for existing databases, by `--recompress`). Everything above still holds except the following.

### `page_tokens` gains an `encoding` column and becomes `WITHOUT ROWID`

```sql
CREATE TABLE page_tokens (
    book_id     INTEGER NOT NULL,
    part_index  INTEGER NOT NULL,
    page_id     INTEGER NOT NULL,
    encoding    INTEGER NOT NULL DEFAULT 1,
    token_ids   BLOB NOT NULL,
    PRIMARY KEY (book_id, part_index, page_id)
) WITHOUT ROWID;
```

| `encoding` | Layout of `token_ids` |
|---|---|
| 1 | Little-endian `uint32` per token (the format described above). Written by `--rebuild`/`--add`. |
| 2 | `varint(n_tokens)` followed by one standard zstd frame (magic present; no checksum, content size, or dictionary id), compressed with the dictionary in `token_codec`. The decompressed payload is `n_tokens` unsigned LEB128 varints, each a **rank**; `token_definitions.id = rank_to_def[rank]`. Written by `--recompress`. |

Rank 0 is the most frequent token definition in the corpus, so common tokens cost one byte before compression. Token counts can be read from the varint prefix without decompressing.

### `token_codec`

```sql
CREATE TABLE token_codec (key TEXT PRIMARY KEY, data BLOB NOT NULL, meta TEXT);
-- 'rank_to_def' : uint32 LE array, index = rank, value = token_definitions.id (~18 MB for 4.5M definitions)
-- 'zstd_dict'   : trained dictionary (110 KiB); meta JSON records level, sample size, definition count, created_at
```

Re-running `--recompress` after an incremental `--add` reuses the stored map and dictionary and appends new definitions to the end of the rank array, so all encoding-2 blobs remain decodable with one codec. `--retrain` rebuilds both.

### Indexes

`idx_token_def_surface` is dropped (never used at runtime). `idx_token_def_root ON token_definitions(root_id)` is added alongside `idx_token_def_lemma` so root-mode variants no longer scan.

### Decoding (application side)

```
encoding 1: ids = chunks_exact(4).map(u32::from_le_bytes)
encoding 2: (n, off) = read_leb128(blob); payload = zstd_decompress_with_dict(blob[off..], capacity n*5);
            ranks = read n leb128 values from payload; ids = ranks.map(|r| rank_to_def[r])
```

Fixtures for testing a decoder live at `kashshaf-data-clean/fixtures/<sample>/` (`blobs_v2.jsonl`, `zstd_dict.bin`, `rank_to_def.bin`, `README.txt`), produced by `--recompress --fixtures DIR`.

---

## Schema v4 (Phase B, September 2026)

Written by `build_sqlite_tokens.py --build-triples` after `--recompress`; sets `db_info.schema_version = 4`. Required by the compound Tantivy index (`tokens` field, see PIPELINE.md "Phase B additions"). Everything in v3 still holds.

```sql
CREATE TABLE triples (
    id        INTEGER PRIMARY KEY,   -- ascending by best (lowest) definition rank: frequent triples get small ids
    surface   TEXT    NOT NULL,      -- raw surface as in token_definitions
    lemma_id  INTEGER NOT NULL,
    root_id   INTEGER                -- NULL when the analysis has no root
);
CREATE INDEX idx_triples_lemma   ON triples(lemma_id);
CREATE INDEX idx_triples_root    ON triples(root_id);
CREATE INDEX idx_triples_surface ON triples(surface);
ALTER TABLE token_definitions ADD COLUMN triple_id INTEGER;   -- every definition maps to exactly one triple
CREATE INDEX idx_token_def_triple ON token_definitions(triple_id);
```

A *triple* is a distinct `(surface, lemma_id, root_id)`. Several `token_definitions` rows (differing in POS, features or clitics) share one triple; on the 25-book sample 288,324 definitions collapse to 214,978 triples, on the full corpus ~4.5M definitions are expected to collapse to ~3M.

The compound index stores each token as `format!("{:07}", triple_id)`. The app loads, at startup, `def_to_triple` (from `token_definitions`), `triple → lemma_id / root_id`, reverse maps `lemma_id → [triple]` and `root_id → [triple]`, and the triples sorted by **normalized** surface (so surface queries and wildcard prefixes are matched after the same normalization the pipeline applied to `surface_text`). Resident size is roughly 50 bytes per triple.

Token ids in `page_tokens` remain `token_definitions.id` (not triple ids), so the token overlay, variants and the encoding-2 codec are unchanged by v4.
