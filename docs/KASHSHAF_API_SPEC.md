# Kashshaf API Specification

**Base URL:** `https://api.kashshaf.com`
**Server:** `api/` (Rust, axum) over the shared `kashshaf-engine` crate — the same engine the desktop app embeds.
**Version described:** 0.5.0 (2026-09-09)

Rate limiting, TLS and the `api.kashshaf.com` virtual host are provided by the reverse proxy in front of the process (which binds `127.0.0.1:3000`); the server itself enforces no request rate.

---

## Conventions

- Arabic queries are normalized server-side (diacritics removed; alif/hamza and Persian/Urdu letter variants folded) for **surface** mode; **root** queries are converted to the dotted form with weak letters as `#` (`قول` → `ق.#.ل`); **lemma** queries are matched verbatim as CAMeL Tools emits them.
- Results are ordered in reading order: author death year (unknown last), book id, part, page. `score` is `0` for search results and only nonzero for `/page` lookups.
- `limit` on every search endpoint defaults to 50 and is clamped to **1–250** (`max_limit` is reported by `/health`).
- `matched_token_indices` are positions in the page's token array, the same indices `/page/tokens` returns. In search results they are capped at 20 per row (combined: 50); the `/page/matches*` endpoints return up to 100 (combined/name: uncapped).
- Errors: `{"error": "message"}` with HTTP **400** for invalid input the server can detect up front (wildcard validation, surface-mode variants) and **500** for everything else. Malformed query parameters produce axum's own 400.

---

## GET /health

```json
{
  "status": "ok",
  "version": "0.5.0",
  "index_docs": 5711697,
  "segments": 1,
  "reading_order": true,
  "corpus_version": "3.0.0",
  "db_schema_version": 3,
  "max_supported_db_schema": 4,
  "max_limit": 250,
  "wildcard_grammar": "glob",
  "exact_counts": false,
  "max_verified_hits": 20000,
  "walks_active": 0,
  "walks_queued": 0,
  "max_concurrent_walks": 10,
  "prefix_cache_entries": 3,
  "prefix_cache_bytes": 3153984,
  "rss_mb": 485.5,
  "peak_rss_mb": 535.1,
  "private_mb": 434.0
}
```

`walks_active` / `walks_queued` count walk threads running and waiting for a permit (at most `max_concurrent_walks` detached walks run at once); `prefix_cache_*` describe the cached verified prefixes; the memory figures are the server process (the working set includes memory-mapped index pages).

---

## GET /search/status

| Parameter | Type | Notes |
|---|---|---|
| `key` | string | the `walk_key` of a search response |

```json
{"verified_hits": 20000, "was_capped": true, "complete": true, "incomplete": false}
```

404 `{"error": "unknown walk key"}` once the walk has left the prefix cache. Poll it while a response's `complete` is `false` (once after ~0.5 s, again after ~2 s) and update the count; the rows already received never change.

`reading_order` is true when the index is a single segment in reading order (the server then paginates without over-fetching). `db_schema_version` is `corpus.db`'s `db_info.schema_version`. `wildcard_grammar` is `glob` on a compound index and `legacy` on a three-field one (rules under `/search/wildcard`). `exact_counts` is always `false` on the server: verified searches stop at `max_verified_hits` (see "Capped counts").

---

## Search

### `SearchTerm`
```json
{"query": "كتاب", "mode": "lemma"}        // mode: surface | lemma | root (required)
```

### `SearchFilters`
```json
{
  "book_ids": [1, 2, 3],        // term filter on text_id
  "author_id": 67,              // equality on the fast field
  "genre_id": 12,
  "century_ah": 5,
  "death_ah_min": 300,          // inclusive range on death_ah
  "death_ah_max": 400
}
```
All fields optional. As of 0.5.0 every field is applied (before 0.5.0 only `book_ids` was).

### `SearchResults`
```json
{
  "query": "كتاب",
  "mode": "lemma",
  "total_hits": 12345,
  "results": [ { ...SearchResult } ],
  "elapsed_ms": 45,
  "was_capped": true            // present only when total_hits is a lower bound
}
```

### `SearchResult`
```json
{
  "id": 123,                    // book id (metadata.db books.id)
  "part_index": 0,
  "page_id": 45,
  "author_id": 67,
  "genre_id": 12,
  "death_ah": 428,
  "century_ah": 5,
  "part_label": "1",
  "page_number": "45",
  "body": "…",                  // omitted when empty
  "score": 0.0,
  "matched_token_indices": [3, 7, 15]
}
```
Author, title, genre and corpus names are **not** included; resolve them from `/books`, `/authors`, `/genres`.

### GET /search
| Parameter | Type | Default | Notes |
|---|---|---|---|
| `q` | string | required | |
| `mode` | `surface`/`lemma`/`root` | `lemma` | |
| `limit` | int | 50 | clamped 1–250 |
| `offset` | int | 0 | |
| `book_ids` | CSV of ints | — | unparseable entries ignored |

Multi-word `q` is an exact-adjacency phrase.

### POST /search/combined
```json
{"and_terms": [SearchTerm...], "or_terms": [SearchTerm...], "filters": SearchFilters?, "limit": 50, "offset": 0}
```
Semantics: `AND1 AND AND2 … AND (OR1 OR OR2 …)`. Both arrays are required (may be empty, not both).

### POST /search/proximity
```json
{"term1": SearchTerm, "term2": SearchTerm, "distance": 5, "filters": SearchFilters?, "limit": 50, "offset": 0}
```
Distance in tokens between the two terms (phrase terms measured from their first token). On a compound index this is a capped walk (see "Capped counts"): single-word sides are matched positionally on the postings, phrase sides on the forward index; `total_hits` is the verified count, exact when `was_capped` is absent. On a three-field index the count is a lower bound from a 12,500-candidate over-fetch (`was_capped` when not exhaustive).

### POST /search/name
```json
{"forms": [{"patterns": ["ابو منصور", "ابا منصور", "…"]}, …], "filters": SearchFilters?, "limit": 50, "offset": 0}
```
OR within a form, AND across forms. Patterns are surface phrases with proclitic expansion already applied by the client.

### GET /search/wildcard
| Parameter | Type | Default |
|---|---|---|
| `q` | string with one `*` | required |
| `limit`, `offset`, `book_ids` | as `/search` | |

Grammar depends on `/health.wildcard_grammar` (400 on violation):

- `glob` (compound index): `*`-only glob, any number of `*` per word, any position — `أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`. Every word containing `*` needs at least 2 literal Arabic letters ("A wildcard word needs at least 2 letters besides *"). Any word of a phrase may carry wildcards. No `?`, no character classes, no limit on how many words a pattern matches.
- `legacy` (three-field index): one `*` per query ("Only one wildcard (*) allowed per search term"), not at the start of a word ("Wildcard cannot be at start of word").

Single-word patterns return an exact `total_hits` however broad (`ال*`: 5,659,240 pages in ~0.5 s). Phrases are matched with exact adjacency; a phrase whose alternations do not fit the regex budget is a capped walk (see below): `ابن ال*` reports `20,000+` after ~0.5 s.

### Capped counts

Proximity, wildcard phrases beyond the regex budget, and boolean / name searches that need forward-index verification are *walks*: pages are verified one by one in reading order and the walk stops after `max_verified_hits` (20,000) verified pages or a 3 s safety budget. `total_hits` is then the verified count and `was_capped` is `true` (clients show `20,000+`). The verified prefix is cached on the server (shared by all clients; 200 entries / 256 MiB, LRU), so `offset`-based paging over it never re-runs the walk. A request whose `offset + limit` lies within the cap is answered once that many hits are verified and a 150 ms allowance has passed; walk-backed responses carry `walk_key` and `complete`. When `complete` is `false` the count is still growing: poll `GET /search/status` and take its `verified_hits`. Paging past the verified prefix returns an empty `results` array with the same `total_hits`.

At most `max_concurrent_walks` detached walks run at once; a walk that waits more than 2 s for a slot stops (`incomplete: true`), its prefix stays usable, and a page beyond it starts a fresh walk.

### Rate limiting

When the server runs with `KASHSHAF_RATE_LIMIT` set (`1`: 10 requests per second with a burst of 30, per client IP as seen through `X-Forwarded-For` / `X-Real-IP`), excess requests get **429** `{"error": "rate limit exceeded; retry in N s"}`. Unset in local runs; production also limits at the proxy.

### POST /search/variants
```json
{"query": "كتاب", "mode": "lemma", "filters": SearchFilters?}
```
Response:
```json
{"variants": [{"surface_tuple": ["الكتاب"], "freq": 1200}, …], "total_hits": 4707, "scanned_hits": 4707, "was_sampled": false, "elapsed_ms": 60}
```
Surface mode → 400. Above 50,000 matching pages the scan is uniformly sampled and `was_sampled` is true.

---

## Pages

### GET /page — `id`, `part_index`, `page_id` → `SearchResult | null`
### GET /page/by-label — `id`, `part_label`, `page_number` → `SearchResult | null`
### GET /page/tokens — `id`, `part_index`, `page_id` (all required; `page_id` is not unique within a book) → `Token[]`
```json
{"idx": 0, "surface": "الكتاب", "noclitic_surface": null, "lemma": "كتاب", "root": "ك.ت.ب",
 "pos": "noun", "features": ["DEF", "SG", "MASC"], "clitics": [{"type": "Al_det", "display": "الـ"}]}
```
`noclitic_surface` is always `null`.

### GET /page/matches — `id`, `part_index`, `page_id`, `q`, `mode?` → `number[]` (≤100)
### GET /page/with-matches — same parameters → `{id, part_label, page_number, body, matched_token_indices} | null`
### POST /page/matches/combined — `{id, part_index, page_id, terms: SearchTerm[]}` → `number[]`
### POST /page/matches/name — `{id, part_index, page_id, patterns: string[]}` → `number[]`

---

## Metadata (from `metadata.db`)

### GET /books → full `books` table, ordered by `death_ah` (unknown last), then `id`
```json
{"id": 1, "corpus": "shamela", "title": "…", "author_id": 67, "death_ah": 428, "century_ah": 5, "genre_id": 12,
 "page_count": 1234, "token_count": 567890, "original_id": "…", "paginated": true, "tags": "[…]",
 "book_meta": "[…]", "author_meta": "[…]", "in_corpus": true, "parts": 3, "metadata_json": "{…}", "citation_json": "{…}"}
```
### GET /authors → `[[id, "author"], …]`
### GET /genres → `[[id, "genre"], …]`

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KASHSHAF_DATA_DIR` | `/opt/kashshaf/data` | directory holding `tantivy_index/`, `corpus.db`, `metadata.db` |
| `KASHSHAF_BIND` | `127.0.0.1:3000` | listen address |

The server refuses to start on a `corpus.db` whose `db_info.schema_version` is newer than it supports, and it must be built with the same Tantivy version and `zstd-compression` feature as the index (both come from `kashshaf-engine`).
