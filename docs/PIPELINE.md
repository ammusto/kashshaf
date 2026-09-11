# Kashshaf Data Pipeline

This pipeline produces the corpus that backs Kashshaf, a search and reading
interface for premodern Arabic texts. It draws from three corpora: nuṣūṣ,
al-Maktaba al-Shāmila, and OpenITI, and it is restricted to authors who died before
1930. When a text is present in more than one corpus, Shamela takes
priority, then nuṣūṣ, then OpenITI.

The pipeline takes raw source files in three different formats, normalizes
them into a single canonical JSON schema, runs morphological analysis, and
emits two SQLite databases plus a Tantivy search index.

## Sources

**Shamela** texts are extracted from al-Maktaba al-Shāmila using the
[shamela-extractor](https://github.com/ammusto/shamela-extractor) pipeline.
The extractor walks Shamela's Lucene indices and produces one JSON per
book containing structured `parts/pages/body` data plus the original
Shamela `book_meta` entries.

**Nuṣūṣ** files come from the [nusus](https://github.com/ammusto/nusus)
project, where they are converted from TEI/XML into the same
`parts/pages/body` JSON shape used elsewhere in the pipeline.

**OpenITI** files are raw mARkdown from the OpenITI corpus. They are
converted to JSON by this pipeline (see below).

A combined `metadata.xlsx` file holds one row per book across all three
corpora. Each row carries `id`, `corpus`, `original_id`, `title`,
`author_id`, `author_name`, `death_ah`, `century_ah`, `genre_id`, page
and token counts, `paginated`, `tags`, `book_meta`, `author_meta`, and
an `in_corpus` flag. This spreadsheet is the canonical metadata source
for everything downstream. Note that `in_corpus` is mostly leftover
from earlier curation passes and currently isn't used as a hard filter
in most stages.

## Stage 1: Canonical JSON (`kashshaf-pipeline.py`)

This stage produces one JSON file per book at
`data/output/<corpus>.<original_id>.json`. The output schema is the same
regardless of source corpus:

```json
{
  "id": 11,
  "corpus": "openiti",
  "original_id": "0001HarithIbnHilliza...",
  "title": "...",
  "author": "...",
  "date": "0001",
  "author_id": 708,
  "genre_id": 26,
  "paginated": true,
  "token_count": null,
  "tags": [...],
  "book_meta": [...],
  "author_meta": [...],
  "parts": [{"part": "1", "pages": [{"page_id": "1", "page_number": "1", "body": "..."}]}]
}
```

`token_count` is left null at this stage and back-populated later from
the morphological output. `book_meta` and `author_meta` are lists of
`"key: value"` strings preserved verbatim from upstream metadata.

### Per-corpus handling

**Shamela and nuṣūṣ** files pass through almost untouched: the pipeline
reads each raw JSON, copies its `parts` array, and joins metadata from
`metadata.xlsx`. Page bodies in these corpora already contain
`<title>` tags inserted upstream (by the shamela-extractor and the TEI
converter) marking section headings, and these are preserved as-is.

**OpenITI** mARkdown files go through three stages:

1. **Conversion.** The mARkdown is parsed into `parts/pages/body`. OpenITI
   page markers like `PageV01P003` mark page boundaries; the volume and
   page numbers become the `part` and `page_number` fields. mARkdown
   headers (`# |` for top-level, `# ||` for nested, etc.) are converted
   into HTML-like `<title id=N parent=M>...</title>` tags, where `parent`
   points back to the enclosing section's id and is `0` for top-level.
   This produces the same tag format that the shamela and nuṣūṣ pipelines
   already emit, so downstream consumers see structurally consistent
   markup across all three corpora.

   Texts without page markers (typically short poems and some treatises)
   are flagged as `paginated: false` and chunked into ~300-word pages
   based on title boundaries, since they have no native pagination to
   preserve.

2. **Cleaning.** OpenITI mARkdown carries a substantial layer of
   editorial markup that needs to be stripped from the page bodies:

   - HTML tags (the `<title>` tags inserted in step 1 are explicitly
     preserved)
   - URLs and file references (`*.png`, `*.pdf`, etc.)
   - OpenITI control tokens: `AUTO`, `PageV...P...` remnants, `QUR`,
     `CHECK`, `NUM`, `HAD`, `#$word` directives, `ms\d+` manuscript
     references
   - Bracketed Latin sequences (typically transliteration notes)
   - Multiple consecutive pipe characters
   - Poetry hemistich markers `%~%` are converted to the Arabic ornament
     `۞` so that hemistich boundaries survive in a more readable form
   - Stray `%` markers are removed; collapsed whitespace is normalized

3. **Page fixing.** OpenITI texts vary widely in quality and frequently
   contain problematic pagination as well as large endnote pages and pages with
   garbled or missing pagination markers. This stage:

   - **Removes endnotes pages.** Endnotes are stripped because they
     consist almost entirely of editorial material (footnotes,
     references to modern editions, editor commentary), which is not
     part of the original text and which the project doesn't want to
     redistribute for copyright reasons. The detector looks for pages
     of ≥4000 tokens beginning with `#####ENDNOTES#`.

   - **Splits long pages.** Pages longer than 2000 tokens are split,
     because page-level granularity matters for search and citation. If
     the page contains malformed page markers (`PageVW...`, `PageVMS...`,
     `MS_PAGE`, etc.), the splitter uses those as natural boundaries.
     Otherwise it splits by token count, targeting ~400 tokens per page
     within a 300–500 range.

   - **Flips `paginated` to false** when the modifications affected
     anything other than trailing endnotes. The rule: `paginated` stays
     true only if every modification happened on the final page of a
     part with more than 10 pages, i.e., the modifications were
     trimming editorial trailers from a real paginated text. Anything
     else means the page boundaries can't be trusted and the text
     should be treated as if it lacks reliable pagination.

The `--no-clean` and `--fix-pages` flags toggle stages 2 and 3
respectively. Default behavior is convert + clean (no fix-pages).

## Stage 2: Morphological analysis (`process_batch.py`)

Each canonical JSON goes through CAMeL Tools'
`BERTUnfactoredDisambiguator` to produce token-level lemma, root, POS,
feature, and clitic data. Output is JSONL, one line per page:

```json
{
  "id": 1, "part_index": 0, "page_id": 1,
  "author_id": 1908, "corpus": "nusus", "title": "...",
  "death_ah": null, "century_ah": 1, "genre_id": 8,
  "part_label": "1", "page_number": "55",
  "body": "...",
  "surface_text": "...",        // search-normalized surface forms, space-joined
  "lemma_text": "...",           // lemmas, space-joined
  "root_text": "...",            // roots (nulls dropped), space-joined
  "tokens": [
    {
      "idx": 0, "surface": "كرز", "lemma": "كرز",
      "root": "ك.ر.ز", "pos": "noun",
      "features": ["INDEF", "SG", "MASC"], "clitics": []
    },
    ...
  ]
}
```

A morphological override system handles cases where BERT falls back to
its catch-all analysis (`pos=noun_prop, root=O`) on tokens it doesn't
recognize. Without intervention, common closed-class words (prepositions like في, particles like لا, demonstrative pronouns like
هذا) get tagged as proper nouns when BERT happens to fail on them,
which damages downstream search and analysis.

Two layers of overrides are loaded, in increasing priority:

- **Closed-class auto-overrides** (`morph_overrides_auto.json`):
  generated similarly, but restricted to a curated whitelist of
  closed-class POS tags (`prep`, `conj`, `part_neg`, `pron_dem`, etc.).
  Closed-class items repeat constantly across the corpus, and a single
  good override there can fix hundreds of thousands of token analyses.
- **Manual overrides** (`morph_overrides.json`): hand-curated entries.
  These take precedence over both auto layers, so a manual decision
  always wins.

The override only fires when BERT's top analysis is the noun_prop+O
backoff. Override keys are
normalized at load time using the same alif/ya/tashkil normalization
the pipeline applies before BERT sees a token, so they match what
BERT actually returns. Each auto-generated override carries provenance
metadata (how often the surface form triggered the backoff, how often
the substituted analysis was seen elsewhere in the corpus) which is
ignored at runtime but useful for auditing.


The page `body` is stored alongside the tokens so the original cleaned
text (with diacritics intact) survives for display, while the
search-oriented `surface_text` field is normalized (alif variants
unified, ya/alif maqsura unified, tashkil and Latin/punctuation
removed).

## Stage 3: SQLite databases (`build_sqlite_tokens.py`)

The morphological JSONL is too large to query directly. This stage
compresses it into two SQLite databases.

**`corpus.db`** holds the morphological data. The compression scheme is
straightforward dictionary encoding: every distinct lemma, root, POS,
feature set, and clitic set is stored once with an integer id, and a
token's full analysis is encoded as a tuple of those ids in the
`token_definitions` table.

```
roots             (id, root)
lemmas            (id, lemma)
pos_types         (id, pos)
feature_sets      (id, features)        JSON-encoded sorted feature list
clitic_sets       (id, clitics)         JSON-encoded sorted clitic list
token_definitions (id, surface, lemma_id, root_id, pos_id, feature_set_id, clitic_set_id)
page_tokens       (book_id, part_index, page_id, token_ids BLOB)
```

A page is then stored as a single BLOB of `uint32` ids referencing
`token_definitions`. Because Arabic morphology has heavy repetition —
the same `(surface, lemma, root, pos, features, clitics)` tuple recurs
constantly. The dictionary is small (low millions of distinct
definitions) and the per-page blobs are dense. The current corpus is
roughly one billion tokens; `corpus.db` and `metadata.db` together
come to about 5 GB, not counting the Tantivy index.

**`metadata.db`** holds book/author/genre metadata in a small,
queryable form. `authors`, `genres`, and `books` are loaded from
`metadata.xlsx` and the corresponding lookup spreadsheets. Page and
token counts are not trusted from the spreadsheet; instead they are
derived from `corpus.db`'s `page_tokens` table after each build, so
that the counts always reflect what actually went through morphological
analysis.

A `db_info` table in each database records the `corpus_version`,
schema version, build timestamp, and totals. Building or reloading
either database always sets these.

## Stage 4: Tantivy search index (`indexer/`)

The full-text search index is built by the Rust binary in `indexer/`.
It reads the same morphological JSONL files that `build_sqlite_tokens.py`
consumes and produces a Tantivy index at `data/tantivy_index/`.

The index has three indexed-only text fields (`surface_text`,
`lemma_text`, and `root_text`) using a whitespace tokenizer with
positions and frequencies. Token alignment across the three fields is
preserved so that a hit in `lemma_text` at position N corresponds to
the same word as position N in `surface_text` and `root_text`. Numeric
filter fields (`author_id`, `genre_id`, `death_ah`, `century_ah`) are
stored as fast fields for filtered search and faceted browsing. A
composite `sort_key = death_ah * 10_000_000 + page_id` provides
chronologically-ordered results within an author.

The page `body` is stored in Tantivy for display (so a hit can be
rendered with the original surface text including diacritics), but
token-level data  lives in `corpus.db` and is fetched on
demand for the morphological detail panel.

The indexer accepts an `--exclude` file listing book ids to skip,
typically generated from `metadata.db` to filter `in_corpus=0` books.

## Putting it together

```
nusus/         shamela/        openiti/
   │              │                │
   └──────┬───────┴────────┬───────┘
          │ (raw JSON)     │ (mARkdown)
          ▼                ▼
   ┌─────────────────────────────┐
   │  kashshaf-pipeline.py       │
   │  • convert                  │  ← OpenITI only: parse mARkdown,
   │  • clean                    │    insert <title> tags, strip markup
   │  • fix_pages                │  ← OpenITI only: drop endnotes,
   └─────────────┬───────────────┘    split long pages
                 │
                 ▼  data/output/<corpus>.<original_id>.json
   ┌─────────────────────────────┐
   │  process_batch.py           │
   │  CAMeL Tools BERT           │
   │  morphological analysis     │
   └─────────────┬───────────────┘
                 │
                 ▼  data/processed/<book_id>.jsonl
        ┌────────┴─────────┐
        ▼                  ▼
 ┌────────────────┐  ┌──────────────────┐
 │ build_sqlite   │  │ indexer (Rust)   │
 │   _tokens.py   │  │                  │
 │                │  │                  │
 │ corpus.db      │  │ tantivy_index/   │
 │ metadata.db    │  │                  │
 └────────────────┘  └──────────────────┘
```

## Caveats

- The priority handling between corpora (Shamela > nuṣūṣ > OpenITI) needs systematic auditing as duplicates may have been
  missed, and some.
- `metadata.xlsx`'s `page_count` and `token_count` columns are
  placeholders. The authoritative counts live in `corpus.db` and are
  written back to `metadata.db` automatically after every build.
- `paginated: true` does not guarantee that every page in a book has a
  meaningful page number — it only guarantees that the source had
  page markers and that the fix-pages stage didn't significantly
  modify the page structure. For citation purposes, `paginated: false`
  texts should be cited by part/page id, not page number.

## Phase A additions (September 2026)

See `REPORT_IMPLEMENTATION_PLAN.md` Part I. All of the following are implemented in `kashshaf-data-clean` and tested on a 25-book sample; the full corpus 3.0.0 rebuild is still to be run.

**Stage 3 (`build_sqlite_tokens.py`)**
- `--data-dir DIR` builds into another directory (e.g. a sample made with `make_sample.py`).
- `--recompress` re-encodes `page_tokens` blobs as frequency-ranked LEB128 varints compressed with a trained zstd dictionary (encoding 2; see CORPUS_DATA_MODEL.md "Schema v3"). Verifies a random sample round-trips before swapping tables, bumps `db_info.schema_version` to 3, and can emit decoder fixtures with `--fixtures DIR`.
- Schema v3 also drops `idx_token_def_surface` and adds `idx_token_def_root`.

**Stage 4 (`indexer/`)**, now Tantivy 0.25 with the `zstd-compression` feature:
- The doc store is zstd-compressed (`--zstd-level`, default 3; `--blocksize`, default 65536; `--lz4` to revert). Readers must be built with the same Tantivy feature.
- Books are ingested in reading order `(death_ah, text_id)` with `NULL` death last, on a single writer thread (`--threads 1`, the default), and the index is merged to one segment and garbage-collected at the end (`--no-merge` to skip). Doc ids are therefore monotonic in `(death_ah, text_id, part_index, page_id)`, which the app will use to paginate without sorting.
- `--input DIR` / `--index DIR` replace the hardcoded paths. Progress is by bytes read; the old full pre-pass that counted every line is gone.
- New binaries: `merge` (merge + GC an existing index, prints per-extension sizes), `check_order` (verifies reading order; exit 1 on violation, 2 on multi-segment), and `prune --merge` now performs a real merge after deletes.
- The schema is unchanged. `author_id`, `genre_id`, `death_ah`, `century_ah` remain FAST-only fields; `sort_key` is kept as a fallback for unmerged indexes.

**Orchestration (`ingest_to_index.py`)**: `--data-dir`, `--recompress`, `--zstd-level`, `--blocksize`, `--threads`, `--no-merge`, `--skip-check-order`. A Phase A build is `python ingest_to_index.py --rebuild --version 3.0.0 --recompress -y`, followed by `generate_manifest.py --schema-version 2 --min-app-version 0.5.0`.

## Phase B additions (September 2026)

**Stage 3**: `build_sqlite_tokens.py --build-triples` populates `triples` and `token_definitions.triple_id` (schema v4, see CORPUS_DATA_MODEL.md "Schema v4"). Run it after `--recompress` so triple ids follow token frequency.

**Stage 4**: `kashshaf-indexer --compound --corpus-db PATH [--keep-root-text]` indexes one `tokens` text field per page — the page's token ids read **from `corpus.db`** (both blob encodings), mapped `definition → triple` and written as zero-padded 7-digit strings — in place of `surface_text`, `lemma_text` and `root_text`. Everything else in the schema is unchanged (the four FAST numeric fields, `sort_key`, `part_label`, `page_number`, stored `body`). `--keep-root-text` additionally indexes `root_text` without positions; the app uses it for single-word root queries because a `TermQuery` there is cheaper than a set of hundreds of triple ids ("root hedge"). The indexer checks per page that the blob length equals the `surface_text` token count and reports mismatches (0 on the sample). On the sample the compound index is 38% smaller than the three-field one (`.pos` and `.idx` roughly halved, `.term` a third).

`ingest_to_index.py --rebuild --version 4.0.0 --recompress --compound [--keep-root-text] -y` runs the whole chain: SQLite build → recompress → triples → compound index → merge → `check_order`.

### Caveat: `root_text` positions are not aligned

`root_text` is built as "roots (nulls dropped), space-joined" (Stage 2 above). Any token without a root therefore shifts every later `root_text` position by one. On the 25-book sample this affects 1,861 of 20,813 pages (9%). Consequences:

- In the three-field index, root-mode **matching** at the page level is still correct, but postings-derived root **positions** (highlights, proximity distances) are off by the number of dropped roots before them on affected pages. This is how every release up to app 0.4.1 behaved.
- The compound index does not use `root_text` positions (the hedge indexes it without positions) and computes positions from the page's token ids, so it is unaffected.

If the three-field index is rebuilt again, emit a placeholder token (e.g. `-`) for null roots so all three fields stay aligned; the app's `normalize_root_query` never produces `-`, so it cannot match.
