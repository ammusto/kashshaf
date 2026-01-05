# Kashshaf API Specification

**Base URL:** `https://api.kashshaf.com`

**Rate Limit:** 10 requests/second, burst 30

---

## Health Check

### GET /health

Returns API status and index statistics.

**Response:**
```json
{
  "status": "ok",
  "index_docs": 1234567
}
```

---

## Search Endpoints

### GET /search

Simple search across the corpus.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| q | string | yes | - | Search query (Arabic text) |
| mode | string | no | lemma | Search mode: `surface`, `lemma`, `root` |
| limit | int | no | 50 | Max results (1-100) |
| offset | int | no | 0 | Pagination offset |
| book_ids | string | no | - | Comma-separated book IDs to filter |

**Example:**
```
GET /search?q=كتاب&mode=lemma&limit=10
GET /search?q=كتاب&mode=surface&book_ids=1,2,3
```

**Response:**
```json
{
  "query": "كتاب",
  "mode": "lemma",
  "total_hits": 12345,
  "results": [
    {
      "id": 123,
      "part_index": 0,
      "page_id": 45,
      "author_id": 67,
      "corpus": "nusus",
      "author": "ابن سينا",
      "title": "الشفاء",
      "death_ah": 428,
      "century_ah": 5,
      "genre": "falsafa",
      "part_label": "الجزء الأول",
      "page_number": "45",
      "body": "<p>النص الكامل للصفحة...</p>",
      "score": 12.5,
      "matched_token_indices": [3, 7, 15]
    }
  ],
  "elapsed_ms": 45
}
```

---

### POST /search/combined

Boolean search with AND/OR logic.

**Request Body:**
```json
{
  "and_terms": [
    {"query": "كتاب", "mode": "lemma"},
    {"query": "علم", "mode": "lemma"}
  ],
  "or_terms": [
    {"query": "فلسفة", "mode": "lemma"}
  ],
  "filters": {
    "book_ids": [1, 2, 3]
  },
  "limit": 50,
  "offset": 0
}
```

**Logic:** `(term1 AND term2 AND ...) AND (or1 OR or2 OR ...)`

**Response:** Same as `/search`

---

### POST /search/proximity

Find two terms within N tokens of each other.

**Request Body:**
```json
{
  "term1": {"query": "كتاب", "mode": "lemma"},
  "term2": {"query": "علم", "mode": "lemma"},
  "distance": 5,
  "filters": {
    "book_ids": [1, 2, 3]
  },
  "limit": 50,
  "offset": 0
}
```

**Response:** Same as `/search`

---

### POST /search/name

Search for Arabic personal names using pattern matching.

**Request Body:**
```json
{
  "forms": [
    {
      "patterns": ["أبو منصور", "أبا منصور", "أبي منصور"]
    },
    {
      "patterns": ["الأصبهاني", "الاصبهاني"]
    }
  ],
  "filters": {
    "book_ids": [1, 2, 3]
  },
  "limit": 50,
  "offset": 0
}
```

**Logic:** All forms must match (AND). Within each form, any pattern matches (OR).

**Response:** Same as `/search`

---

### GET /search/wildcard

Wildcard search with `*` for prefix/infix matching. Surface mode only.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| q | string | yes | - | Query with `*` wildcard |
| limit | int | no | 50 | Max results (1-100) |
| offset | int | no | 0 | Pagination offset |
| book_ids | string | no | - | Comma-separated book IDs |

**Wildcard Rules:**
- One `*` per query
- `*` cannot be at start of word
- Internal `*` requires 2+ chars before it

**Examples:**
```
GET /search/wildcard?q=كتا*        # Prefix: كتاب, كتابة, كتابين...
GET /search/wildcard?q=أح*مد      # Infix: أحمد, أحامد...
GET /search/wildcard?q=ابن ال*    # Phrase with wildcard
```

**Response:** Same as `/search`

---

## Page Endpoints

### GET /page

Get a single page by ID.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | int | yes | Book ID |
| part_index | int | yes | Part index (0-based) |
| page_id | int | yes | Page ID |

**Example:**
```
GET /page?id=123&part_index=0&page_id=45
```

**Response:**
```json
{
  "id": 123,
  "part_index": 0,
  "page_id": 45,
  "author_id": 67,
  "corpus": "nusus",
  "author": "ابن سينا",
  "title": "الشفاء",
  "death_ah": 428,
  "century_ah": 5,
  "genre": "falsafa",
  "part_label": "الجزء الأول",
  "page_number": "45",
  "body": "<p>النص الكامل للصفحة...</p>",
  "score": 0,
  "matched_token_indices": []
}
```

---

### GET /page/tokens

Get morphological tokens for a page.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | int | yes | Book ID |
| part_index | int | yes | Part index (0-based) |
| page_id | int | yes | Page ID |

**Example:**
```
GET /page/tokens?id=123&part_index=0&page_id=45
```

**Response:**
```json
[
  {
    "idx": 0,
    "surface": "الكتاب",
    "noclitic_surface": null,
    "lemma": "كتاب",
    "root": "كتب",
    "pos": "NOUN",
    "features": ["DEF", "NOM", "SG", "MASC"],
    "clitics": ["Al"]
  },
  {
    "idx": 1,
    "surface": "والعلم",
    "noclitic_surface": null,
    "lemma": "علم",
    "root": "علم",
    "pos": "NOUN",
    "features": ["DEF", "NOM", "SG", "MASC"],
    "clitics": ["wa", "Al"]
  }
]
```

---

### GET /page/matches

Get token positions matching a query on a specific page.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| id | int | yes | - | Book ID |
| part_index | int | yes | - | Part index |
| page_id | int | yes | - | Page ID |
| q | string | yes | - | Search query |
| mode | string | no | lemma | Search mode |

**Example:**
```
GET /page/matches?id=123&part_index=0&page_id=45&q=كتاب&mode=lemma
```

**Response:**
```json
[3, 7, 15, 23]
```

---

## Metadata Endpoints

### GET /books

Get all book metadata.

**Response:**
```json
[
  {
    "id": 1,
    "corpus": "nusus",
    "title": "الشفاء",
    "author_id": 67,
    "author": "ابن سينا",
    "death_ah": 428,
    "century_ah": 5,
    "genre": "falsafa",
    "page_count": 1234,
    "token_count": 567890
  }
]
```

---

## Search Modes

| Mode | Field | Description |
|------|-------|-------------|
| `surface` | surface_text | Exact normalized word forms |
| `lemma` | lemma_text | Base forms + inflections (default) |
| `root` | root_text | Arabic triconsonantal roots |

---

## Error Response

All endpoints return errors in this format:
```json
{
  "error": "Error message here"
}
```

**HTTP Status Codes:**
- `200` - Success
- `400` - Bad request (invalid query)
- `429` - Rate limit exceeded
- `500` - Internal server error

---

## Notes

1. **Arabic Normalization:** All queries are normalized (diacritics removed, alif/hamza variants unified)
2. **Sorting:** Results sorted by author death year (earliest first), nulls last
3. **Token Indices:** `matched_token_indices` correspond to token positions in `/page/tokens` response
4. **Body HTML:** The `body` field contains HTML with tashkeel preserved for display