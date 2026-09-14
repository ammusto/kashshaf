//! `LocalSource`: the corpus on disk, opened read-only through
//! `kashshaf-engine` (Lab spec §2.4, §3.1).
//!
//! Ground rule 2: Lab never writes to the corpus, and must work while
//! Kashshaf has the same files open. Every connection here is opened
//! read-only, and nothing in this module issues a write.

use super::{unavailable, BookMetadata, BookSource, CandidateQuery, Layer, Page, PageRef};
use anyhow::{anyhow, Context, Result};
use kashshaf_engine::{
    check_corpus_schema_supported, tokens::PageKey, verify_corpus_versions_match, EngineConfig,
    SearchEngine, TokenCache,
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
        })
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
            None => format!("SELECT {} FROM books WHERE in_corpus = 1 ORDER BY death_ah ASC, id ASC", cols),
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

    fn book_pages(&self, id: u64, progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
        let refs = self.page_refs(id)?;
        let total = refs.len() as u64;
        let mut pages = Vec::with_capacity(refs.len());
        for (i, r) in refs.iter().enumerate() {
            let key = PageKey::new(r.book_id, r.part_index as u64, r.page_id);
            if let Some(p) = self.page_at(key)? {
                pages.push(p);
            }
            progress(i as u64 + 1, total);
        }
        Ok(pages)
    }

    fn page(&self, id: u64, part: u32, page: u64) -> Result<Option<Page>> {
        self.page_at(PageKey::new(id, part as u64, page))
    }

    fn freq(&self, _layer: Layer, _id: u32) -> Result<u64> {
        // Phase 1 (§4.1 keyness) implements this over token_definitions ranks.
        Err(unavailable("Corpus frequency", "not implemented before Phase 1"))
    }

    fn find_pages(&self, _q: &CandidateQuery) -> Result<Vec<PageRef>> {
        // Phase 3 (§4.3 reuse candidates) implements this over the engine's
        // phrase path.
        Err(unavailable("Candidate retrieval", "not implemented before Phase 3"))
    }
}
