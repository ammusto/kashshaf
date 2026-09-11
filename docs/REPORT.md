# Kashshaf Storage & Search Rebuild — Report

**Date:** 2026-09-08
**Scope:** Reduce on-disk footprint (~17.2 GB) while keeping or improving search performance. Covers `corpus.db`, the Tantivy index, and `search.rs`.

---

## 1. Diagnosis

### Corpus stats
| | |
|---|---|
| Books | 7,176 |
| Pages | 5,711,697 (avg ~173 tokens/page) |
| Tokens | 987,907,098 |
| `corpus.db` | 5.1 GB |
| Tantivy index | 12.1 GB (10 segments, has `.del` files) |

### Where the bytes are
**corpus.db (5.1 GB)**
- `page_tokens` BLOBs: 988M × 4 bytes = **3.95 GB** (uint32 per token; ids only need ~22 bits)
- Everything else (`token_definitions`, surface index, `pages`, PK indexes): ~1.15 GB — not yet broken down; run `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;`

**Tantivy (12.1 GB)**
| Component | Size | Notes |
|---|---|---|
| `.store` | 6.21 GB | page bodies (tashkil + HTML), LZ4 |
| `.pos` | 3.17 GB | positions for 3 fields × ~1B tokens ≈ 1.07 B/position |
| `.idx` | 2.50 GB | term–doc postings, 3 fields |
| `.term` | 0.14 GB | dictionaries (segment merge won't help much) |
| `.fast`/`.fieldnorm`/other | 0.10 GB | |

### Structural redundancy
The same token stream is indexed three times (`surface_text`, `lemma_text`, `root_text`), each with positions. Lemma and root are functions of the token definition, so two of the three position streams and postings sets are derivable.

### Code issues in `search.rs` (independent of storage)
1. **`reader_builder().try_into()` on every call** (15 sites). Opens fresh segment readers and spawns a watcher thread per query. Should be built once in `open()`.
2. **Deep pagination fetches `limit + offset` full docs** (bodies + positions) in `search()` / `combined_search()`, then `skip(offset)`. Offset 2000 → 2000 body decompressions for 50 results.
3. **Filters other than `book_ids` are never applied** (`author_id`, `genre_id`, `death_ah_min/max`, `century_ah` exist on `SearchFilters` but are ignored).
4. **`proximity_search` `total_hits` is a lower bound** (capped by 5000-candidate overfetch); verification does `read_postings` per term per candidate instead of one cursor per term walked in doc order (`get_matched_positions_batch` has the right shape but is dead code).
5. **Spec drift:** proximity and highlighting read positions from Tantivy postings, not SQLite. The two-phase SQLite verification described in the spec does not exist in code. `.pos` is load-bearing for every result row.

---

## 2. Plan

### Phase A — No semantic change (target: 17.2 → ~12.8 GB)
| Change | Saves | Notes |
|---|---|---|
| Merge index to 1 segment, GC | 0–1.5 GB | reclaims deleted docs; queries get faster; needs temp headroom |
| `page_tokens`: frequency-ranked ids + LEB128 varint + dictionary-trained zstd per blob | ~2.4 GB | nothing random-accesses inside a blob; decode is µs. Use magicless/no-checksum zstd frames (173-token pages) |
| `page_tokens` → `WITHOUT ROWID` | small | composite PK becomes clustered key |
| Drop `idx_token_def_surface` and/or `pages` table if unused at runtime | ~0.3 GB | `part_label`/`page_number` already stored in Tantivy |
| Doc store: `Compressor::Zstd`, `docstore_blocksize: 65536` | ~1.5–2 GB | test on 5% JSONL sample first; +0.3–1 ms per page load |
| Build index in reading order (`death_ah, text_id, part_index, page_id`) | 0 | enables stable `TopDocs` ordering via doc-id tiebreak; prerequisite for pagination fix |

### Phase B — Single compound field (target: → ~9.1 GB)
Index each token **once** as a *triple id*.

**Data changes**
- New table `triples(id, surface, lemma_id, root_id)` = distinct `(surface, lemma_id, root_id)` from `token_definitions` (~3M rows).
- Add `triple_id` column to `token_definitions`.
- Tantivy: replace `surface_text`/`lemma_text`/`root_text` with one text field `tokens` containing zero-padded triple ids (e.g. `0001234`), whitespace tokenizer, positions on. Keep `body` stored, keep fast fields.
- Ship a binary sidecar (mmap-able arrays) for: `triple_id → (surface_idx, lemma_id, root_id)`, `definition_id → triple_id`, reverse maps `lemma_id → [triple_id]`, `root_id → [triple_id]`, and a surface-sorted array for prefix scans. ~150–250 MB resident. Loading from SQLite instead costs 0.5–1.5 s at startup.

**Expected index**
| | Now | After |
|---|---|---|
| `.store` | 6.21 | ~4.5 (zstd) |
| `.pos` | 3.17 | ~1.05 |
| `.idx` | 2.50 | ~0.9 |
| `.term` | 0.14 | tiny (fixed-width ids) |
| **Tantivy total** | **12.1** | **~6.7** |
| **+ corpus.db** | 5.1 | ~2.4 |
| **Grand total** | **17.2** | **~9.1** |

**`search.rs` changes**
| Area | Change |
|---|---|
| `open()` | Build `IndexReader` once; store on `SearchEngine`. Load triple sidecar. |
| `build_term_query` / `get_search_field` | `(mode, word)` → triple-id set via reverse maps → `TermSetQuery`. Remove all `get_field("…_text")` matches. |
| Multi-word queries (all modes) | `RegexPhraseQuery`, one alternation per position (`^(0001234\|0009876)$`). Verify tantivy version has it (~0.23+). |
| Highlighting (`get_matched_positions_*`, `get_phrase_positions_limited`) | Replace with forward-index scan: load `token_ids` blob (already done for token overlay), map `definition_id → triple_id`, test membership in query triple set. Returns all positions, not first 5. |
| `proximity_search` | Candidate retrieval unchanged (`AND` of two `TermSetQuery`); verification = forward-index scan with exact unordered min-distance; batch blob fetch in one prepared statement. `total_hits` can become exact. |
| `wildcard_search` / `get_wildcard_positions` | Prefix/infix expansion over in-memory surface-sorted array → triple set → `TermSetQuery`. Remove FST range scan. |
| `name_search` | Same `RegexPhraseQuery` path; fan-out 1–3 per word. |
| `search()` / `combined_search()` | Rely on reading-order index + single segment for stable sort; fetch only `limit` docs after `offset`. Drop `sort_results_by_reading_order` pre-skip. |
| `SearchFilters` | Apply `author_id`/`genre_id`/`century_ah` as term queries and `death_ah_min/max` as `RangeQuery` on fast fields (or confirm frontend resolves to `book_ids`). |
| `collect_all_hits` (variants) | Migrate to triple-set queries. |

**Downstream**
- `api/` (FastAPI) and any scripts that query `lemma_text`/`root_text` must adopt the same query translation.
- Highlighting now requires `corpus.db` (already required in offline mode; API server already reads it for tokens).

---

## 3. Impact Summary

**Functionality:** result sets unchanged for all modes. Gains: full highlighting (no 5-position cap), exact proximity counts (optional), mixed-mode phrases possible.

**Performance**
| Operation | Expected |
|---|---|
| Surface term, surface phrase, name search, wildcard | same |
| Lemma term | slightly slower on very common lemmas (50–300 cursor union) |
| Lemma phrase (common words) | ~2–4× slower (est. 30 → ~100 ms); **benchmark** |
| Root term | noticeably slower on productive roots (thousands of triples); **benchmark** |
| Highlighting | comparable; ~5–20 ms for 50 results |
| Proximity | same ballpark |
| Page load | +0.3–1 ms (zstd) |
| Every query | −tens of ms (shared reader) |
| Deep scroll | O(limit) instead of O(offset) doc fetches |
| Startup | +~50 ms with sidecar; +0.5–1.5 s if loading triples from SQLite |
| Memory | +150–250 MB |

**Hedges if benchmarks fail**
- Root too slow → keep `root_text` as a separate field with `IndexRecordOption::Basic` (no positions). Costs ~0.7 GB; root phrases/proximity go through forward index. Total ≈ 9.8 GB.
- `RegexPhraseQuery` too slow on wide alternations → lemma phrases fall back to `TermSetQuery AND TermSetQuery` + adjacency check on the blob (same cost profile as proximity).

---

## 4. Sequence
1. Merge segments + GC; re-measure per-extension sizes.
2. Fix shared `IndexReader` (immediate win, no rebuild).
3. Zstd doc-store test on 5% sample; pick level/blocksize.
4. Ship `page_tokens` recompression (pure win, no query changes).
5. Prototype compound field on the same 5% sample; benchmark lemma phrase, root term, name search.
6. Decide on root hedge; full rebuild in reading order; rewrite `search.rs` per table above; update `api/`.
