//! Token caching with LRU eviction, loads from SQLite corpus.db.
//!
//! Two caches share one capacity setting:
//! * decoded `token_definitions.id` arrays per page (`get_ids`) — what
//!   highlighting, proximity and variants need;
//! * fully resolved `Token`s per page (`get`) — what the reader overlay needs.

use crate::blob::{decode_blob, BlobCodec};
use crate::corpus_db::page_tokens_has_encoding;
use crate::normalize::normalize_arabic;
use crate::tokens::{PageKey, Token, TokenClitic, TokenField};
use anyhow::{Context, Result};
use lru::LruCache;
use rusqlite::Connection;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct LookupTables {
    roots: HashMap<i64, String>,
    lemmas: HashMap<i64, String>,
    pos_types: HashMap<i64, String>,
    feature_sets: HashMap<i64, Vec<String>>,
    clitic_sets: HashMap<i64, Vec<TokenClitic>>,
}

pub struct TokenCache {
    tokens: Mutex<LruCache<PageKey, Arc<Vec<Token>>>>,
    ids: Mutex<LruCache<PageKey, Arc<Vec<u32>>>>,
    tokens_db_path: PathBuf,
    lookups: LookupTables,
    codec: Option<BlobCodec>,
    has_encoding_column: bool,
}

/// Parallel arrays of a fetched page blob.
struct RawPage {
    encoding: i64,
    blob: Vec<u8>,
}

/// Timing and counters for one batched id fetch.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct BatchStats {
    pub cache_hits: usize,
    pub fetched: usize,
    pub blob_bytes: u64,
    pub open_us: u64,
    pub fetch_us: u64,
    pub decode_us: u64,
}

impl BatchStats {
    pub fn add(&mut self, o: &BatchStats) {
        self.cache_hits += o.cache_hits;
        self.fetched += o.fetched;
        self.blob_bytes += o.blob_bytes;
        self.open_us += o.open_us;
        self.fetch_us += o.fetch_us;
        self.decode_us += o.decode_us;
    }
}

impl TokenCache {
    /// Open `corpus.db`, load the lookup tables and (if present) the encoding-2
    /// codec. Fails instead of panicking when the database is unusable.
    pub fn new(tokens_db_path: PathBuf, capacity: usize) -> Result<Self> {
        let cap = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::new(1000).unwrap());
        let conn = Connection::open(&tokens_db_path)
            .with_context(|| format!("Failed to open corpus.db at {:?}", tokens_db_path))?;
        let lookups = Self::load_lookup_tables(&conn)?;
        let codec = BlobCodec::load(&conn).context("loading token_codec")?;
        let has_encoding_column = page_tokens_has_encoding(&conn)?;
        if let Some(c) = &codec {
            eprintln!(
                "[corpus.db] token codec loaded: {} ranked definitions",
                c.rank_count()
            );
        }
        Ok(Self {
            tokens: Mutex::new(LruCache::new(cap)),
            ids: Mutex::new(LruCache::new(cap)),
            tokens_db_path,
            lookups,
            codec,
            has_encoding_column,
        })
    }

    pub fn has_codec(&self) -> bool {
        self.codec.is_some()
    }

    pub fn codec(&self) -> Option<&BlobCodec> {
        self.codec.as_ref()
    }

    pub fn db_path(&self) -> &PathBuf {
        &self.tokens_db_path
    }

    fn load_lookup_tables(conn: &Connection) -> Result<LookupTables> {
        let roots: HashMap<i64, String> = conn
            .prepare("SELECT id, root FROM roots")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let lemmas: HashMap<i64, String> = conn
            .prepare("SELECT id, lemma FROM lemmas")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let pos_types: HashMap<i64, String> = conn
            .prepare("SELECT id, pos FROM pos_types")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let feature_sets: HashMap<i64, Vec<String>> = conn
            .prepare("SELECT id, features FROM feature_sets")?
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let json: String = row.get(1)?;
                Ok((id, json))
            })?
            .filter_map(|r| r.ok())
            .map(|(id, json)| (id, serde_json::from_str(&json).unwrap_or_default()))
            .collect();

        let clitic_sets: HashMap<i64, Vec<TokenClitic>> = conn
            .prepare("SELECT id, clitics FROM clitic_sets")?
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let json: String = row.get(1)?;
                Ok((id, json))
            })?
            .filter_map(|r| r.ok())
            .map(|(id, json)| (id, serde_json::from_str(&json).unwrap_or_default()))
            .collect();

        Ok(LookupTables {
            roots,
            lemmas,
            pos_types,
            feature_sets,
            clitic_sets,
        })
    }

    fn open(&self) -> Result<Connection> {
        Connection::open(&self.tokens_db_path)
            .with_context(|| format!("Failed to open corpus.db at {:?}", self.tokens_db_path))
    }

    fn blob_select(&self) -> &'static str {
        if self.has_encoding_column {
            "SELECT encoding, token_ids FROM page_tokens WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3"
        } else {
            "SELECT 1, token_ids FROM page_tokens WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3"
        }
    }

    fn fetch_raw(&self, conn: &Connection, key: &PageKey) -> Result<Option<RawPage>> {
        let row: Option<(i64, Vec<u8>)> = conn
            .query_row(
                self.blob_select(),
                rusqlite::params![key.id as i64, key.part_index as i64, key.page_id as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        Ok(row.map(|(encoding, blob)| RawPage { encoding, blob }))
    }

    /// Decode a raw page blob with this database's codec.
    pub fn decode(&self, encoding: i64, blob: &[u8]) -> Result<Vec<u32>> {
        decode_blob(encoding, blob, self.codec.as_ref())
    }

    /// Decoded `token_definitions.id`s for a page (cached). Missing page -> empty.
    pub fn get_ids(&self, key: &PageKey) -> Result<Arc<Vec<u32>>> {
        if let Some(ids) = self.ids.lock().unwrap().get(key) {
            return Ok(Arc::clone(ids));
        }
        let conn = self.open()?;
        let ids = match self.fetch_raw(&conn, key)? {
            Some(raw) => self.decode(raw.encoding, &raw.blob)?,
            None => Vec::new(),
        };
        let ids = Arc::new(ids);
        self.ids.lock().unwrap().put(*key, Arc::clone(&ids));
        Ok(ids)
    }

    /// Decoded ids for many pages in one statement per 250 keys.
    /// Pages that are not found are absent from the map.
    pub fn get_ids_batch(&self, keys: &[PageKey]) -> Result<HashMap<PageKey, Arc<Vec<u32>>>> {
        Ok(self.get_ids_batch_stats(keys)?.0)
    }

    /// Same as [`Self::get_ids_batch`] but also reports where the time went.
    pub fn get_ids_batch_stats(&self, keys: &[PageKey]) -> Result<(HashMap<PageKey, Arc<Vec<u32>>>, BatchStats)> {
        let mut stats = BatchStats::default();
        let mut out: HashMap<PageKey, Arc<Vec<u32>>> = HashMap::with_capacity(keys.len());
        let mut missing: Vec<PageKey> = Vec::new();
        {
            let mut cache = self.ids.lock().unwrap();
            for k in keys {
                if let Some(v) = cache.get(k) {
                    out.insert(*k, Arc::clone(v));
                    stats.cache_hits += 1;
                } else {
                    missing.push(*k);
                }
            }
        }
        if missing.is_empty() {
            return Ok((out, stats));
        }
        let t0 = std::time::Instant::now();
        let conn = self.open()?;
        stats.open_us += t0.elapsed().as_micros() as u64;
        let t0 = std::time::Instant::now();
        let fetched = self.fetch_raw_batch(&conn, &missing)?;
        stats.fetch_us += t0.elapsed().as_micros() as u64;
        stats.fetched += fetched.len();
        let t0 = std::time::Instant::now();
        let mut decoded = Vec::with_capacity(fetched.len());
        for (k, raw) in fetched {
            stats.blob_bytes += raw.blob.len() as u64;
            decoded.push((k, Arc::new(self.decode(raw.encoding, &raw.blob)?)));
        }
        stats.decode_us += t0.elapsed().as_micros() as u64;
        let mut cache = self.ids.lock().unwrap();
        for (k, ids) in decoded {
            cache.put(k, Arc::clone(&ids));
            out.insert(k, ids);
        }
        Ok((out, stats))
    }

    /// Every page of one book in reading order, as decoded definition ids:
    /// `(part_index, page_id, token_ids)`.
    ///
    /// One statement and one connection for the whole book. The primary key
    /// `(book_id, part_index, page_id)` is also reading order — the order the
    /// index is built in and the engine's reading-order check verifies — so
    /// this is a single indexed range scan and the `ORDER BY` is free.
    ///
    /// Use this instead of a loop over [`Self::get`] when the unit of work is
    /// a book: on a 6,336-page book the loop costs seconds, almost all of it
    /// in per-page connections and per-page ad-hoc `IN (…)` statements.
    ///
    /// Deliberately does **not** populate the LRUs. A book is far larger than
    /// their capacity, so caching it would evict everything a reader or a
    /// search had warmed in exchange for entries this caller already holds.
    pub fn book_pages(&self, book_id: u64) -> Result<Vec<(u64, u64, Vec<u32>)>> {
        let conn = self.open()?;
        let enc_col = if self.has_encoding_column { "encoding" } else { "1" };
        let mut stmt = conn.prepare(&format!(
            "SELECT part_index, page_id, {}, token_ids FROM page_tokens              WHERE book_id = ?1 ORDER BY part_index, page_id",
            enc_col
        ))?;
        let rows = stmt.query_map([book_id as i64], |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                RawPage { encoding: row.get(2)?, blob: row.get(3)? },
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (part_index, page_id, raw) = r?;
            out.push((part_index, page_id, self.decode(raw.encoding, &raw.blob)?));
        }
        Ok(out)
    }

    /// Resolve many pages of definition ids to `Token`s at once.
    ///
    /// The definitions of a whole book are fetched in one pass over the union
    /// of its ids rather than once per page: a 300K-token book draws on far
    /// fewer distinct definitions than it has tokens, so the per-page query
    /// was re-fetching the same rows thousands of times.
    ///
    /// Each output `Vec<Token>` has one token per input id, with the same
    /// `idx` numbering [`Self::get`] produces, including the placeholder for a
    /// definition that is missing.
    pub fn resolve_pages(&self, pages: &[Vec<u32>]) -> Result<Vec<Vec<Token>>> {
        let mut union: Vec<u32> = pages.iter().flatten().copied().collect();
        union.sort_unstable();
        union.dedup();
        if union.is_empty() {
            return Ok(pages.iter().map(|_| Vec::new()).collect());
        }
        let conn = self.open()?;
        let defs = self.fetch_definitions(&conn, &union)?;
        Ok(pages.iter().map(|ids| self.tokens_from_defs(ids, &defs)).collect())
    }

    fn fetch_raw_batch(&self, conn: &Connection, keys: &[PageKey]) -> Result<Vec<(PageKey, RawPage)>> {
        let mut out = Vec::with_capacity(keys.len());
        let enc_col = if self.has_encoding_column { "encoding" } else { "1" };
        // 3 params per key: 750 < SQLite's 999-variable default. The row-value
        // IN matches the full primary key (book_id, part_index, page_id).
        for chunk in keys.chunks(250) {
            let values: String = chunk.iter().map(|_| "(?,?,?)").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT book_id, part_index, page_id, {}, token_ids FROM page_tokens \
                 WHERE (book_id, part_index, page_id) IN (VALUES {})",
                enc_col, values
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<i64> = chunk
                .iter()
                .flat_map(|k| [k.id as i64, k.part_index as i64, k.page_id as i64])
                .collect();
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    PageKey::new(
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, i64>(1)? as u64,
                        row.get::<_, i64>(2)? as u64,
                    ),
                    RawPage {
                        encoding: row.get(3)?,
                        blob: row.get(4)?,
                    },
                ))
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------------
    // Micro-benchmark support (used by engine/src/bin/bench.rs --micro).
    // These bypass the LRU on purpose.
    // ------------------------------------------------------------------

    /// First `n` page keys with their part_index, in primary-key order.
    pub fn sample_keys(&self, n: usize) -> Result<Vec<(u64, u64, u64)>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens ORDER BY book_id, part_index, page_id LIMIT ?1")?;
        let rows = stmt.query_map([n as i64], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Raw blobs via the row-value `IN (VALUES …)` statement (the 0.5.0 path).
    pub fn bench_fetch_rowvalue(&self, keys: &[PageKey]) -> Result<Vec<(i64, Vec<u8>)>> {
        let conn = self.open()?;
        Ok(self.fetch_raw_batch(&conn, keys)?.into_iter().map(|(_, r)| (r.encoding, r.blob)).collect())
    }

    /// Raw blobs by full primary-key point lookups on one connection with a cached statement.
    pub fn bench_fetch_pk(&self, conn: &Connection, keys: &[(u64, u64, u64)]) -> Result<Vec<(i64, Vec<u8>)>> {
        let sql = if self.has_encoding_column {
            "SELECT encoding, token_ids FROM page_tokens WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3"
        } else {
            "SELECT 1, token_ids FROM page_tokens WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3"
        };
        let mut stmt = conn.prepare_cached(sql)?;
        let mut out = Vec::with_capacity(keys.len());
        for &(b, p, g) in keys {
            let row: Option<(i64, Vec<u8>)> = stmt
                .query_row(rusqlite::params![b as i64, p as i64, g as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                .ok();
            if let Some(r) = row {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// Raw blobs with `Connection::open` per lookup (the worst case).
    pub fn bench_fetch_pk_open_each(&self, keys: &[(u64, u64, u64)]) -> Result<Vec<(i64, Vec<u8>)>> {
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            let conn = self.open()?;
            out.extend(self.bench_fetch_pk(&conn, std::slice::from_ref(k))?);
        }
        Ok(out)
    }

    /// Open a connection for benchmarks.
    pub fn bench_connection(&self) -> Result<Connection> {
        self.open()
    }

    /// Fully resolved tokens for a page (cached). Missing page -> empty.
    pub fn get(&self, key: &PageKey) -> Result<Arc<Vec<Token>>> {
        if let Some(tokens) = self.tokens.lock().unwrap().get(key) {
            return Ok(Arc::clone(tokens));
        }
        let ids = self.get_ids(key)?;
        let tokens = Arc::new(self.resolve_tokens(&ids)?);
        self.tokens.lock().unwrap().put(*key, Arc::clone(&tokens));
        Ok(tokens)
    }

    /// Resolve definition ids to `Token`s. Indices are preserved even when a
    /// definition is missing (placeholder token), because the frontend maps
    /// visible words to `token.idx` positionally.
    fn resolve_tokens(&self, token_ids: &[u32]) -> Result<Vec<Token>> {
        if token_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.open()?;
        let defs = self.fetch_definitions(&conn, token_ids)?;
        Ok(self.tokens_from_defs(token_ids, &defs))
    }

    /// Build the `Token`s for one page from already-fetched definitions.
    #[allow(clippy::type_complexity)]
    fn tokens_from_defs(
        &self,
        token_ids: &[u32],
        defs: &HashMap<u32, (String, i64, Option<i64>, i64, i64, i64)>,
    ) -> Vec<Token> {
        token_ids
            .iter()
            .enumerate()
            .map(|(idx, &token_id)| match defs.get(&token_id) {
                None => Token {
                    idx,
                    surface: String::from("\u{FFFD}"),
                    noclitic_surface: None,
                    lemma: String::from("unknown"),
                    root: None,
                    pos: String::from("UNK"),
                    features: Vec::new(),
                    clitics: Vec::new(),
                },
                Some((surface, lemma_id, root_id, pos_id, fs_id, cs_id)) => Token {
                    idx,
                    surface: surface.clone(),
                    noclitic_surface: None,
                    lemma: self
                        .lookups
                        .lemmas
                        .get(lemma_id)
                        .cloned()
                        .unwrap_or_else(|| String::from("unknown")),
                    root: root_id.and_then(|rid| self.lookups.roots.get(&rid).cloned()),
                    pos: self
                        .lookups
                        .pos_types
                        .get(pos_id)
                        .cloned()
                        .unwrap_or_else(|| String::from("UNK")),
                    features: self.lookups.feature_sets.get(fs_id).cloned().unwrap_or_default(),
                    clitics: self.lookups.clitic_sets.get(cs_id).cloned().unwrap_or_default(),
                },
            })
            .collect()
    }

    #[allow(clippy::type_complexity)]
    fn fetch_definitions(
        &self,
        conn: &Connection,
        token_ids: &[u32],
    ) -> Result<HashMap<u32, (String, i64, Option<i64>, i64, i64, i64)>> {
        let mut unique: Vec<u32> = token_ids.to_vec();
        unique.sort_unstable();
        unique.dedup();

        let mut defs = HashMap::with_capacity(unique.len());
        // SQLite's default variable limit is 999.
        for chunk in unique.chunks(500) {
            let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT id, surface, lemma_id, root_id, pos_id, feature_set_id, clitic_set_id \
                 FROM token_definitions WHERE id IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(chunk.iter().map(|id| *id as i64)),
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u32,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ),
                    ))
                },
            )?;
            for r in rows.flatten() {
                defs.insert(r.0, r.1);
            }
        }
        Ok(defs)
    }

    pub fn get_token_at(&self, key: &PageKey, idx: usize) -> Result<Option<Token>> {
        let tokens = self.get(key)?;
        Ok(tokens.get(idx).cloned())
    }

    pub fn find_positions(&self, key: &PageKey, field: TokenField, value: &str) -> Result<Vec<usize>> {
        let tokens = self.get(key)?;
        Ok(tokens
            .iter()
            .filter(|t| field.matches(t, value))
            .map(|t| t.idx)
            .collect())
    }

    /// Surface strings for a set of definition ids (one IN-query per 500 ids).
    pub fn surfaces_for(&self, ids: &[u32]) -> Result<HashMap<u32, String>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.open()?;
        let defs = self.fetch_definitions(&conn, ids)?;
        Ok(defs.into_iter().map(|(id, d)| (id, d.0)).collect())
    }

    /// Exact wildcard-phrase highlight positions for many pages at once.
    ///
    /// Decodes the pages' definition ids in batches, fetches the surfaces of
    /// the distinct ids once, normalizes them, then slides a window of
    /// `all_terms.len()` over every page: the wildcard slot must start with
    /// `prefix` (and end with `suffix` when given); other slots must equal the
    /// corresponding term. Returns every position of every complete match.
    pub fn wildcard_phrase_positions_batch(
        &self,
        keys: &[PageKey],
        prefix: &str,
        suffix: Option<&str>,
        wildcard_term_index: usize,
        all_terms: &[String],
    ) -> Result<HashMap<PageKey, Vec<u32>>> {
        let n = all_terms.len();
        let mut out: HashMap<PageKey, Vec<u32>> = HashMap::with_capacity(keys.len());
        if n == 0 || keys.is_empty() {
            return Ok(out);
        }
        let pages = self.get_ids_batch(keys)?;
        let mut unique: Vec<u32> = pages.values().flat_map(|v| v.iter().copied()).collect();
        unique.sort_unstable();
        unique.dedup();
        let surfaces = self.surfaces_for(&unique)?;

        let prefix_n = normalize_arabic(prefix);
        let suffix_n = suffix.map(normalize_arabic);
        let terms_n: Vec<String> = all_terms.iter().map(|t| normalize_arabic(t)).collect();

        // Per definition id: does it satisfy slot k? Precompute once.
        let mut slot_ok: HashMap<u32, Vec<bool>> = HashMap::with_capacity(surfaces.len());
        for (id, surface) in &surfaces {
            let s = normalize_arabic(surface);
            let oks = (0..n)
                .map(|k| {
                    if k == wildcard_term_index {
                        match &suffix_n {
                            Some(suf) => s.starts_with(&prefix_n) && s.ends_with(suf),
                            None => s.starts_with(&prefix_n),
                        }
                    } else {
                        s == terms_n[k]
                    }
                })
                .collect();
            slot_ok.insert(*id, oks);
        }
        let falses = vec![false; n];

        for key in keys {
            let Some(ids) = pages.get(key) else {
                out.insert(*key, Vec::new());
                continue;
            };
            let mut positions = Vec::new();
            if ids.len() >= n {
                for start in 0..=(ids.len() - n) {
                    let ok = (0..n).all(|k| slot_ok.get(&ids[start + k]).unwrap_or(&falses)[k]);
                    if ok {
                        positions.extend((start..start + n).map(|p| p as u32));
                    }
                }
            }
            positions.dedup();
            out.insert(*key, positions);
        }
        Ok(out)
    }

    pub fn clear(&self) {
        self.tokens.lock().unwrap().clear();
        self.ids.lock().unwrap().clear();
    }

    /// (resolved-token pages cached, capacity)
    pub fn stats(&self) -> (usize, usize) {
        let cache = self.tokens.lock().unwrap();
        (cache.len(), cache.cap().get())
    }

    /// Find positions where a wildcard phrase matches.
    /// For a query like "معر*فة الله", finds positions where a token matches
    /// the wildcard pattern (prefix + optional suffix) and the following
    /// tokens match the remaining terms in order. Returns all token indices
    /// that are part of complete phrase matches.
    pub fn find_wildcard_phrase_positions(
        &self,
        key: &PageKey,
        prefix: &str,
        suffix: Option<&str>,
        wildcard_term_index: usize,
        all_terms: &[String],
    ) -> Result<Vec<u32>> {
        let tokens = self.get(key)?;
        let mut positions: Vec<u32> = Vec::new();
        let num_terms = all_terms.len();
        if num_terms == 0 || tokens.is_empty() {
            return Ok(positions);
        }

        let prefix_n = normalize_arabic(prefix);
        let suffix_n = suffix.map(normalize_arabic);
        let terms_n: Vec<String> = all_terms.iter().map(|t| normalize_arabic(t)).collect();
        let surfaces_n: Vec<String> = tokens.iter().map(|t| normalize_arabic(&t.surface)).collect();

        for i in 0..tokens.len() {
            if i + num_terms > tokens.len() {
                break;
            }
            let mut ok = true;
            for (j, term_n) in terms_n.iter().enumerate() {
                let s = &surfaces_n[i + j];
                let matches = if j == wildcard_term_index {
                    match &suffix_n {
                        Some(suf) => s.starts_with(&prefix_n) && s.ends_with(suf),
                        None => s.starts_with(&prefix_n),
                    }
                } else {
                    s == term_n
                };
                if !matches {
                    ok = false;
                    break;
                }
            }
            if ok {
                for j in 0..num_terms {
                    positions.push((i + j) as u32);
                }
            }
        }
        Ok(positions)
    }
}
