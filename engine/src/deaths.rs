//! Death years by text, for the reading-order key (death year or none,
//! text, part, page) that results are paged in and that matches across
//! page breaks are merged by.
//!
//! Metadata is not in the index: author, death year, century and genre
//! live in `metadata.db`, and the engine reads the one it needs from
//! there. An index from before metadata left the schema still carries a
//! `death_ah` fast column and can supply the years itself, so such a
//! corpus opens unchanged when no `metadata.db` is found.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;

/// The year of a text without one: those sort last.
pub const NO_DEATH: u64 = u64::MAX;

#[derive(Debug, Default, Clone)]
pub struct Deaths {
    by_text: HashMap<u64, u64>,
}

impl Deaths {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_pairs(pairs: impl IntoIterator<Item = (u64, u64)>) -> Self {
        Self { by_text: pairs.into_iter().collect() }
    }

    /// `SELECT id, death_ah FROM books` of a `metadata.db`.
    pub fn load(metadata_db: &Path) -> Result<Self> {
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = rusqlite::Connection::open_with_flags(metadata_db, flags)
            .with_context(|| format!("opening {}", metadata_db.display()))?;
        let mut stmt = conn
            .prepare("SELECT id, death_ah FROM books WHERE death_ah IS NOT NULL")
            .context("metadata.db has no books(id, death_ah)")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        let mut by_text = HashMap::new();
        for row in rows {
            let (id, death) = row?;
            if id >= 0 && death >= 0 {
                by_text.insert(id as u64, death as u64);
            }
        }
        Ok(Self { by_text })
    }

    /// From an index that still carries `death_ah` as a fast column: the
    /// value on the first document of each text.
    pub fn from_index(searcher: &tantivy::Searcher) -> Result<Self> {
        let mut by_text = HashMap::new();
        for seg in searcher.segment_readers() {
            let ff = seg.fast_fields();
            let (Ok(text), Ok(death)) = (ff.u64("text_id"), ff.u64("death_ah")) else { continue };
            // Documents of one text are contiguous in a reading-order index,
            // so most lookups are skipped; an unordered index is merely slower.
            let mut last: Option<u64> = None;
            for doc in 0..seg.max_doc() {
                let Some(t) = text.first(doc) else { continue };
                if last == Some(t) {
                    continue;
                }
                last = Some(t);
                if let Some(d) = death.first(doc) {
                    by_text.entry(t).or_insert(d);
                }
            }
        }
        Ok(Self { by_text })
    }

    /// [`Self::from_index`] on the index at `index_path`.
    pub fn from_index_dir(index_path: &Path) -> Result<Self> {
        let index = tantivy::Index::open_in_dir(index_path).with_context(|| format!("opening {}", index_path.display()))?;
        let reader: tantivy::IndexReader = index.reader_builder().reload_policy(tantivy::ReloadPolicy::Manual).try_into()?;
        Self::from_index(&reader.searcher())
    }

    /// A text's death year, or [`NO_DEATH`].
    #[inline]
    pub fn of(&self, text_id: u64) -> u64 {
        self.by_text.get(&text_id).copied().unwrap_or(NO_DEATH)
    }

    /// Texts with a death year.
    pub fn len(&self) -> usize {
        self.by_text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_text.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (u64, u64)> + '_ {
        self.by_text.iter().map(|(&t, &d)| (t, d))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_without_a_year_sorts_last() {
        let d = Deaths::from_pairs([(1, 450), (2, 300)]);
        assert_eq!(d.of(2), 300);
        assert_eq!(d.of(1), 450);
        assert_eq!(d.of(3), NO_DEATH);
        assert!((d.of(1), 1u64) < (d.of(3), 0u64));
    }

    #[test]
    fn loads_from_a_books_table() {
        let dir = std::env::temp_dir().join(format!("kashshaf-deaths-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("metadata.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, death_ah INTEGER);
                 INSERT INTO books VALUES (7, 'a', 256), (8, 'b', NULL), (9, 'c', 1000);",
            )
            .unwrap();
        }
        let d = Deaths::load(&path).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!(d.of(7), 256);
        assert_eq!(d.of(8), NO_DEATH);
        assert_eq!(d.of(9), 1000);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
