//! `LocalSource`: the corpus on disk, opened read-only through
//! `kashshaf-engine` (Lab spec §2.4, §3.1).
//!
//! Ground rule 2: Lab never writes to the corpus, and must work while
//! Kashshaf has the same files open. Every connection here is opened
//! read-only, and nothing in this module issues a write.

use super::freq::{FreqLayer, FreqTable};
use super::{unavailable, BookMetadata, BookSource, CandidateQuery, Hits, Layer, Page, PageRef};
use std::sync::Mutex;
use anyhow::{anyhow, Context, Result};
use kashshaf_engine::{
    check_corpus_schema_supported, tokens::PageKey, verify_corpus_versions_match, EngineConfig, SearchEngine, SearchFilters,
    SearchMode, TokenCache,
};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Token cache capacity in pages. Larger than Kashshaf's 1,000: Lab's unit of
/// work is a whole book, so the working set is one book's pages, not the
/// scattered hits of a search.
const CACHE_CAPACITY: usize = 4000;

pub struct LocalSource {
    engine: Arc<SearchEngine>,
    token_cache: Arc<TokenCache>,
    corpus_db: PathBuf,
    metadata_db: PathBuf,
    corpus_version: String,
    schema_version: Option<i64>,
    data_dir: PathBuf,
    /// Loaded frequency tables, one per layer (spec §3.4).
    freq: Mutex<[Option<Arc<FreqTable>>; 2]>,
}

impl LocalSource {
    /// Open the corpus in `data_dir`. Fails with a message the mode banner can
    /// show if the corpus is absent, unreadable, or of a schema this build
    /// does not support.
    pub fn open(data_dir: &Path) -> Result<Self> {
        Self::open_with_index(data_dir, &data_dir.join("tantivy_index"))
    }

    /// Open with the index somewhere other than `<data_dir>/tantivy_index`.
    /// Production always uses [`Self::open`]; the sample corpus the §3.3
    /// acceptance test runs against names its index differently.
    pub fn open_with_index(data_dir: &Path, index_path: &Path) -> Result<Self> {
        let corpus_db = data_dir.join("corpus.db");
        let metadata_db = data_dir.join("metadata.db");

        for (label, path) in [("corpus.db", &corpus_db), ("metadata.db", &metadata_db)] {
            if !path.exists() {
                return Err(anyhow!("{} is missing from {}", label, data_dir.display()));
            }
        }
        if !index_path.is_dir() {
            return Err(anyhow!("the search index is missing from {}", index_path.display()));
        }

        let info = check_corpus_schema_supported(&corpus_db)?;
        verify_corpus_versions_match(&corpus_db, &metadata_db)?;
        let corpus_version = info
            .as_ref()
            .map(|i| i.corpus_version.clone())
            .ok_or_else(|| anyhow!("{} has no db_info: it predates corpus 3.0.0", corpus_db.display()))?;
        let schema_version = info.as_ref().map(|i| i.schema_version);

        // exact_counts per spec §2.4: Lab's statistics are only meaningful on
        // complete results, so it never runs with a capped walk.
        let config = EngineConfig { exact_counts: true, ..EngineConfig::default() };
        let mut engine = SearchEngine::open_with_corpus(index_path, Some(&corpus_db), config)?;
        let token_cache = Arc::new(TokenCache::new(corpus_db.clone(), CACHE_CAPACITY)?);
        engine.set_token_cache(token_cache.clone());

        Ok(Self {
            engine: Arc::new(engine),
            token_cache,
            corpus_db,
            metadata_db,
            corpus_version,
            schema_version,
            data_dir: data_dir.to_path_buf(),
            freq: Mutex::new([None, None]),
        })
    }

    pub fn token_cache(&self) -> &Arc<TokenCache> {
        &self.token_cache
    }

    /// Where a shipped or locally built frequency table would be: the corpus
    /// directory first (the manifest lists them when present), then Lab's own
    /// cache, where a local build lands.
    pub fn freq_candidates(&self, layer: FreqLayer) -> Vec<PathBuf> {
        let mut v = vec![self.data_dir.join(layer.file_name())];
        if let Ok(lab) = kashshaf_common::lab_data_dir() {
            v.push(lab.join("cache").join(format!("{}-{}", self.corpus_version, layer.file_name())));
        }
        v
    }

    /// Store tables a local build produced, so `freq_table` finds them.
    pub fn install_freq_tables(&self, lemma: FreqTable, root: FreqTable) -> Result<()> {
        let lab = kashshaf_common::lab_data_dir()?;
        let dir = lab.join("cache");
        std::fs::create_dir_all(&dir)?;
        for t in [&lemma, &root] {
            t.write(&dir.join(format!("{}-{}", self.corpus_version, t.layer.file_name())))?;
        }
        let mut slots = self.freq.lock().unwrap();
        slots[0] = Some(Arc::new(lemma));
        slots[1] = Some(Arc::new(root));
        Ok(())
    }

    pub fn schema_version(&self) -> Option<i64> {
        self.schema_version
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn engine(&self) -> &Arc<SearchEngine> {
        &self.engine
    }

    /// A read-only connection. `SQLITE_OPEN_READ_ONLY` is the enforcement of
    /// ground rule 2, not just a convention: a stray write fails loudly here
    /// rather than corrupting a corpus Kashshaf may also have open.
    fn open_ro(path: &Path) -> Result<Connection> {
        Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("opening {} read-only", path.display()))
    }

    fn books_where(&self, filter: Option<u64>) -> Result<Vec<BookMetadata>> {
        let conn = Self::open_ro(&self.metadata_db)?;
        let cols = "id, corpus, title, author_id, death_ah, century_ah, genre_id, page_count, \
                    token_count, original_id, paginated, tags, book_meta, author_meta, in_corpus, \
                    parts, metadata_json, citation_json";
        let sql = match filter {
            // Lab operates on one text at a time, so the browser lists only
            // books whose pages are actually in the corpus.
            //
            // `NULLS LAST` is required, not cosmetic: SQLite sorts NULLs first
            // under a bare ASC, while the API's /books uses NULLS LAST. Without
            // it the two modes would list undated books at opposite ends of the
            // browser — a parity break the sample corpus cannot show, because
            // none of its in-corpus books lacks a death year.
            None => format!(
                "SELECT {} FROM books WHERE in_corpus = 1 ORDER BY death_ah ASC NULLS LAST, id ASC",
                cols
            ),
            Some(_) => format!("SELECT {} FROM books WHERE id = ?1", cols),
        };
        let mut stmt = conn.prepare(&sql)?;
        let map = |row: &rusqlite::Row| -> rusqlite::Result<BookMetadata> {
            Ok(BookMetadata {
                id: row.get(0)?,
                corpus: row.get(1)?,
                title: row.get(2)?,
                author_id: row.get(3)?,
                death_ah: row.get(4)?,
                century_ah: row.get(5)?,
                genre_id: row.get(6)?,
                page_count: row.get(7)?,
                token_count: row.get(8)?,
                original_id: row.get(9)?,
                paginated: row.get::<_, Option<i64>>(10)?.map(|v| v != 0),
                tags: row.get(11)?,
                book_meta: row.get(12)?,
                author_meta: row.get(13)?,
                in_corpus: row.get::<_, Option<i64>>(14)?.map(|v| v != 0),
                parts: row.get(15)?,
                metadata_json: row.get(16)?,
                citation_json: row.get(17)?,
            })
        };
        let rows = match filter {
            None => stmt.query_map([], map)?.collect::<Result<Vec<_>, _>>()?,
            Some(id) => stmt.query_map([id], map)?.collect::<Result<Vec<_>, _>>()?,
        };
        Ok(rows)
    }

    /// Assemble one page from the index (body and labels) and the token cache.
    fn page_at(&self, key: PageKey) -> Result<Option<Page>> {
        let Some(result) = self.engine.get_page(key.id, key.part_index, key.page_id)? else {
            return Ok(None);
        };
        let tokens = self.token_cache.get(&key)?;
        Ok(Some(Page {
            book_id: key.id,
            part_index: key.part_index as u32,
            page_id: key.page_id,
            part_label: result.part_label,
            page_number: result.page_number,
            body: result.body,
            tokens: (*tokens).clone(),
        }))
    }
}

impl BookSource for LocalSource {
    fn corpus_version(&self) -> &str {
        &self.corpus_version
    }

    fn books(&self) -> Result<Vec<BookMetadata>> {
        self.books_where(None)
    }

    fn book(&self, id: u64) -> Result<Option<BookMetadata>> {
        Ok(self.books_where(Some(id))?.into_iter().next())
    }

    /// Schema 4 has no `pages` table — the page list lives in `page_tokens`,
    /// whose primary key `(book_id, part_index, page_id)` is also reading
    /// order, so one indexed range scan gives the book in order.
    fn page_refs(&self, id: u64) -> Result<Vec<PageRef>> {
        let conn = Self::open_ro(&self.corpus_db)?;
        let mut stmt = conn.prepare(
            "SELECT part_index, page_id FROM page_tokens WHERE book_id = ?1 ORDER BY part_index, page_id",
        )?;
        let refs = stmt
            .query_map([id], |row| {
                Ok(PageRef { book_id: id, part_index: row.get(0)?, page_id: row.get(1)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(refs)
    }

    /// The whole book, through the engine's bulk path.
    ///
    /// `TokenCache::book_pages` reads every page's ids in one ordered
    /// statement and `resolve_pages` resolves their definitions in one pass
    /// over the union, which is the difference between seconds and tens of
    /// milliseconds on a large book (§8). The index is still asked for each
    /// page's `body`, `part_label` and `page_number`, but that costs
    /// ~0.02 ms/page and has no bulk equivalent.
    fn book_pages(&self, id: u64, progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
        let raw = self.token_cache.book_pages(id)?;
        let total = raw.len() as u64;
        if total == 0 {
            return Ok(Vec::new());
        }
        let ids: Vec<Vec<u32>> = raw.iter().map(|(_, _, ids)| ids.clone()).collect();
        let resolved = self.token_cache.resolve_pages(&ids)?;

        let mut pages = Vec::with_capacity(raw.len());
        for (i, ((part_index, page_id, _), tokens)) in raw.into_iter().zip(resolved).enumerate() {
            // A page in `page_tokens` with no document in the index has no
            // body to align against, so it is skipped rather than carried
            // with an empty one.
            if let Some(result) = self.engine.get_page(id, part_index, page_id)? {
                pages.push(Page {
                    book_id: id,
                    part_index: part_index as u32,
                    page_id,
                    part_label: result.part_label,
                    page_number: result.page_number,
                    body: result.body,
                    tokens,
                });
            }
            progress(i as u64 + 1, total);
        }
        Ok(pages)
    }

    fn page(&self, id: u64, part: u32, page: u64) -> Result<Option<Page>> {
        self.page_at(PageKey::new(id, part as u64, page))
    }

    fn freq_table(&self, layer: FreqLayer) -> Result<Arc<FreqTable>> {
        let slot = match layer {
            FreqLayer::Lemma => 0,
            FreqLayer::Root => 1,
        };
        if let Some(t) = &self.freq.lock().unwrap()[slot] {
            return Ok(Arc::clone(t));
        }
        for path in self.freq_candidates(layer) {
            if !path.is_file() {
                continue;
            }
            let t = FreqTable::read(&path)?;
            if t.corpus_version != self.corpus_version {
                eprintln!(
                    "[lab] ignoring {}: built for corpus {}, this is {}",
                    path.display(),
                    t.corpus_version,
                    self.corpus_version
                );
                continue;
            }
            if t.layer != layer {
                return Err(anyhow!("{} holds the {:?} layer, not {:?}", path.display(), t.layer, layer));
            }
            let t = Arc::new(t);
            self.freq.lock().unwrap()[slot] = Some(Arc::clone(&t));
            return Ok(t);
        }
        Err(unavailable(
            "Corpus frequencies",
            &format!(
                "{} is not in the corpus directory. Build it from Settings (a one-off scan of the corpus), or update the corpus: newer manifests ship it.",
                layer.file_name()
            ),
        ))
    }

    /// A multi-word query on one layer is a phrase query in the engine (the
    /// same `SearchEngine::search` Kashshaf runs), so an anchor of three lemmas
    /// returns exactly the pages where they occur in that order.
    fn find_pages(&self, q: &CandidateQuery) -> Result<Hits> {
        let mode = match q.layer {
            Layer::Surface => SearchMode::Surface,
            Layer::Lemma => SearchMode::Lemma,
            Layer::Root => SearchMode::Root,
        };
        let query = q.terms.join(" ");
        if q.slop > 0 && q.terms.len() > 1 {
            let (hits, total) = self
                .engine
                .phrase_hits(&query, mode, q.slop, &SearchFilters::default())
                .with_context(|| format!("slop-{} phrase {:?} on {:?}", q.slop, query, q.layer))?;
            return Ok(Hits {
                total,
                pages: hits.into_iter().take(q.limit.max(1)).map(|(id, part, page)| PageRef { book_id: id, part_index: part as u32, page_id: page }).collect(),
            });
        }
        let r = self
            .engine
            .search(&query, mode, &SearchFilters::default(), q.limit.max(1), 0)
            .with_context(|| format!("candidate query {:?} on {:?}", query, q.layer))?;
        Ok(Hits {
            total: r.total_hits,
            pages: r
                .results
                .into_iter()
                .map(|h| PageRef { book_id: h.id, part_index: h.part_index as u32, page_id: h.page_id })
                .collect(),
        })
    }

    fn as_local(&self) -> Option<&LocalSource> {
        Some(self)
    }
}
