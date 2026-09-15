//! `toc.db` — every book's table of contents (Lab spec 1.5, §3.1).
//!
//! The pipeline keeps Shamela's heading markup as `<title id=N parent=M>` in
//! each page body; `kashshaf-data-clean/build_toc.py` crawls it into one
//! table so a reader can show a book's contents without loading the book:
//!
//! ```text
//! toc(book_id, id, parent, title, part_index, page_id, page_number)
//! ```
//!
//! `id` and `parent` are the tag's own values, scoped to the book, with
//! `parent = 0` for a top-level entry. Pages are keyed by `(part_index,
//! page_id)` — `page_id` is not unique within a book, 45 books of corpus 4.x
//! restart it per part.
//!
//! The file is optional at this layer: a corpus published before it exists
//! simply has none, and every caller degrades with the reason (ground rule
//! 5). The whole corpus is 2,384,556 entries in 242 MB, carrying one index,
//! `(book_id, parent)`; a book's rows are few enough that ordering them for
//! display costs nothing, and a second index cost 35 MB. It is opened
//! read-only, so Lab, Kashshaf and the API can share one file.

use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One heading, as stored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TocRow {
    pub id: i64,
    pub parent: i64,
    pub title: String,
    pub part_index: u32,
    pub page_id: u64,
    /// The printed page number, for display (spec 1.5 §C1).
    pub page_number: String,
}

/// A heading with the headings under it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TocNode {
    pub id: i64,
    pub parent: i64,
    pub title: String,
    pub part_index: u32,
    pub page_id: u64,
    pub page_number: String,
    /// Nesting depth, 0 at the top — so a flat list can be indented.
    pub depth: u32,
    pub children: Vec<TocNode>,
}

/// An open `toc.db`.
pub struct TocDb {
    path: PathBuf,
    corpus_version: Option<String>,
    schema_version: i64,
}

/// The schema this build reads.
pub const SUPPORTED_SCHEMA: i64 = 1;

impl TocDb {
    /// Open `toc.db`, checking its schema. Errors name the file.
    pub fn open(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Err(anyhow!("{} is missing", path.display()));
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening {}", path.display()))?;
        let get = |k: &str| -> Option<String> { conn.query_row("SELECT value FROM db_info WHERE key = ?1", [k], |r| r.get(0)).ok() };
        let schema_version: i64 = get("schema_version").and_then(|v| v.parse().ok()).unwrap_or(0);
        if schema_version > SUPPORTED_SCHEMA {
            return Err(anyhow!(
                "{} is schema {}; this build reads up to {}",
                path.display(),
                schema_version,
                SUPPORTED_SCHEMA
            ));
        }
        let corpus_version = get("corpus_version").filter(|v| !v.is_empty());
        Ok(Self { path: path.to_path_buf(), corpus_version, schema_version })
    }

    /// `<data_dir>/toc.db` if it is there and readable, else the reason.
    pub fn open_in(data_dir: &Path) -> Result<Self> {
        Self::open(&data_dir.join("toc.db"))
    }

    pub fn corpus_version(&self) -> Option<&str> {
        self.corpus_version.as_deref()
    }

    pub fn schema_version(&self) -> i64 {
        self.schema_version
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connect(&self) -> Result<Connection> {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening {}", self.path.display()))
    }

    /// Every heading of one book, in reading order.
    pub fn rows(&self, book_id: u64) -> Result<Vec<TocRow>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, parent, title, part_index, page_id, page_number FROM toc \
             WHERE book_id = ?1 ORDER BY part_index, page_id, id",
        )?;
        let rows = stmt
            .query_map([book_id as i64], |r| {
                Ok(TocRow {
                    id: r.get(0)?,
                    parent: r.get(1)?,
                    title: r.get(2)?,
                    part_index: r.get::<_, i64>(3)? as u32,
                    page_id: r.get::<_, i64>(4)? as u64,
                    page_number: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// One book's contents as a tree.
    pub fn tree(&self, book_id: u64) -> Result<Vec<TocNode>> {
        Ok(nest(self.rows(book_id)?))
    }

    /// How many books have any entry — for the status line.
    pub fn book_count(&self) -> Result<u64> {
        let conn = self.connect()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM (SELECT 1 FROM toc GROUP BY book_id)", [], |r| r.get::<_, i64>(0))? as u64)
    }
}

/// Nest rows by `parent`. An entry whose parent is missing (or which points
/// at itself, or into a cycle) is treated as top-level rather than dropped:
/// a heading the pipeline recorded is always shown somewhere.
pub fn nest(rows: Vec<TocRow>) -> Vec<TocNode> {
    use std::collections::{HashMap, HashSet};
    let by_id: HashMap<i64, usize> = rows.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    // A row is a root when its parent is 0, missing, itself, or reachable
    // only through a cycle — so nothing the pipeline recorded is lost.
    let in_cycle = |i: usize| -> bool {
        let mut seen: HashSet<usize> = HashSet::new();
        let mut at = i;
        loop {
            if !seen.insert(at) {
                return true;
            }
            let parent = rows[at].parent;
            match by_id.get(&parent) {
                Some(&p) if parent != 0 => at = p,
                _ => return false,
            }
        }
    };
    let mut children_of: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        if r.parent != 0 && r.parent != r.id && by_id.contains_key(&r.parent) && !in_cycle(i) {
            children_of.entry(r.parent).or_default().push(i);
        } else {
            roots.push(i);
        }
    }

    // Iterative build, so a deep book cannot overflow the stack, with a
    // visited set so a cycle among parents cannot loop forever.
    fn build(i: usize, depth: u32, rows: &[TocRow], children_of: &HashMap<i64, Vec<usize>>, seen: &mut HashSet<usize>) -> TocNode {
        let r = &rows[i];
        let mut node = TocNode {
            id: r.id,
            parent: r.parent,
            title: r.title.clone(),
            part_index: r.part_index,
            page_id: r.page_id,
            page_number: r.page_number.clone(),
            depth,
            children: Vec::new(),
        };
        if depth < 32 {
            if let Some(kids) = children_of.get(&r.id) {
                for &k in kids {
                    if seen.insert(k) {
                        node.children.push(build(k, depth + 1, rows, children_of, seen));
                    }
                }
            }
        }
        node
    }

    let mut seen: HashSet<usize> = roots.iter().copied().collect();
    roots.iter().map(|&i| build(i, 0, &rows, &children_of, &mut seen)).collect()
}

/// The entry a page falls under: the last heading at or before
/// `(part_index, page_id)` in reading order. `None` before the first.
pub fn entry_for_page(rows: &[TocRow], part_index: u32, page_id: u64) -> Option<&TocRow> {
    rows.iter().filter(|r| (r.part_index, r.page_id) <= (part_index, page_id)).next_back()
}

/// The page range of a section: from its own page to the page before the
/// next entry at the same depth or shallower (end exclusive, `None` = to the
/// end of the book). Used by the section scopes of §G and §H3.
pub fn section_range(rows: &[TocRow], id: i64) -> Option<((u32, u64), Option<(u32, u64)>)> {
    let at = rows.iter().position(|r| r.id == id)?;
    let start = (rows[at].part_index, rows[at].page_id);
    // Depth by walking up the parent chain.
    fn depth_of(rows: &[TocRow], r: &TocRow) -> u32 {
        let mut parent = r.parent;
        let mut d = 0;
        let mut guard = 0;
        while parent != 0 && guard < 64 {
            match rows.iter().find(|x| x.id == parent) {
                Some(p) => {
                    parent = p.parent;
                    d += 1;
                }
                None => break,
            }
            guard += 1;
        }
        d
    }
    let mine = depth_of(&rows, &rows[at]);
    let end = rows[at + 1..]
        .iter()
        .find(|r| depth_of(&rows, r) <= mine)
        .map(|r| (r.part_index, r.page_id));
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, parent: i64, title: &str, part: u32, page: u64) -> TocRow {
        TocRow { id, parent, title: title.into(), part_index: part, page_id: page, page_number: page.to_string() }
    }

    #[test]
    fn nesting_follows_parent_and_keeps_orphans() {
        let rows = vec![
            row(1, 0, "المقدمة", 0, 1),
            row(2, 1, "ترجمة المؤلف", 0, 3),
            row(3, 2, "نشأته", 0, 4),
            row(4, 0, "كتاب الإيمان", 0, 10),
            row(5, 99, "باب يتيم", 0, 12), // parent does not exist
        ];
        let tree = nest(rows);
        assert_eq!(tree.len(), 3, "two real roots plus the orphan");
        assert_eq!(tree[0].title, "المقدمة");
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].title, "نشأته");
        assert_eq!(tree[0].children[0].children[0].depth, 2);
        assert_eq!(tree[2].title, "باب يتيم");
        assert_eq!(tree[2].depth, 0);
    }

    #[test]
    fn a_parent_cycle_does_not_hang_and_loses_nothing() {
        let rows = vec![row(1, 2, "a", 0, 1), row(2, 1, "b", 0, 2)];
        let tree = nest(rows);
        // Neither can be nested without looping, so both are shown at the top.
        assert_eq!(tree.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(tree.iter().all(|n| n.children.is_empty()));
        // A row that is its own parent is a root too.
        assert_eq!(nest(vec![row(7, 7, "self", 0, 1)]).len(), 1);
    }

    #[test]
    fn page_lookup_and_section_ranges() {
        let rows = vec![
            row(1, 0, "كتاب أول", 0, 1),
            row(2, 1, "باب", 0, 5),
            row(3, 1, "باب آخر", 0, 9),
            row(4, 0, "كتاب ثان", 1, 2),
        ];
        assert_eq!(entry_for_page(&rows, 0, 1).unwrap().id, 1);
        assert_eq!(entry_for_page(&rows, 0, 4).unwrap().id, 1);
        assert_eq!(entry_for_page(&rows, 0, 5).unwrap().id, 2);
        assert_eq!(entry_for_page(&rows, 0, 8).unwrap().id, 2);
        assert_eq!(entry_for_page(&rows, 1, 3).unwrap().id, 4);
        // A part boundary is ordered by (part, page), not page alone.
        assert_eq!(entry_for_page(&rows, 1, 1).unwrap().id, 3);

        // A top-level section runs to the next top-level entry.
        assert_eq!(section_range(&rows, 1), Some(((0, 1), Some((1, 2)))));
        // A sub-section runs to its sibling.
        assert_eq!(section_range(&rows, 2), Some(((0, 5), Some((0, 9)))));
        // The last section runs to the end.
        assert_eq!(section_range(&rows, 4), Some(((1, 2), None)));
        assert_eq!(section_range(&rows, 99), None);
    }
}
