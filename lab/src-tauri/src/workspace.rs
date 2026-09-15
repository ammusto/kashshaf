//! The workspace on disk (Lab spec 1.5 §A2).
//!
//! `analysis.db` stays the system of record — every verdict, link and note is
//! written there first — but the workspace is what a scholar keeps, moves
//! between machines, and reads with something other than Lab. One folder per
//! text under `<lab dir>/workspace/<book_id>/`:
//!
//! ```text
//! metadata.json            the text's full metadata record, as the corpus has it
//! isnads/confirmed.csv     one row per confirmed isnad
//! isnads/transmitters.csv  one row per transmitter of a confirmed isnad
//! isnads/rejected.csv      the ones rejected, so a decision is never lost
//! reuse/verdicts.csv       confirmed and rejected reuse matches, both spans
//! quran/verdicts.csv       confirmed and rejected quotations
//! notes.json               the annotations of §C4
//! state.json               per-tab UI state: last page, params, filters
//! ```
//!
//! Every action that changes one of those rewrites the affected file (the
//! whole file, not a patch: they are small, and a half-written CSV is worse
//! than a rewritten one). `export_all` rewrites the lot — what Ctrl+S does.
//!
//! Opening a text whose folder holds decisions `analysis.db` lacks — a folder
//! copied from another machine — imports them, re-anchored through §6.1.
//! Import never overwrites a decision already in the database: the local one
//! wins, and the count of skipped rows is reported.

use crate::error::LabError;
use crate::source::{BookMetadata, BookSource, Page};
use crate::store::now;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `<lab dir>/workspace`.
pub fn root() -> Result<PathBuf> {
    let dir = kashshaf_common::lab_data_dir()?.join("workspace");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

pub fn book_dir(book_id: u64) -> Result<PathBuf> {
    Ok(root()?.join(book_id.to_string()))
}

/// One text in the workspace, as the left pane lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub book_id: u64,
    /// From `metadata.json`, so the list renders without the corpus.
    pub title: String,
    pub author: Option<String>,
    pub death_ah: Option<i64>,
    /// RFC 3339, last time the text was opened.
    pub accessed: String,
    pub added: String,
    /// Counts from the last export, for the list's second line.
    #[serde(default)]
    pub confirmed_isnads: u64,
    #[serde(default)]
    pub notes: u64,
}

/// `state.json` — per-tab UI state (spec §A2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceState {
    /// The page the reader was on, `(part_index, page_id)`.
    #[serde(default)]
    pub last_page: Option<(u32, u64)>,
    /// Whatever each panel wants to remember, by panel id.
    #[serde(default)]
    pub panels: HashMap<String, serde_json::Value>,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn write_text(path: &Path, body: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

// ------------------------------------------------------------------ CSV ---

pub fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn csv(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    out.push_str(&header.join(","));
    out.push('\n');
    for r in rows {
        out.push_str(&r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

/// A CSV back to rows, header first. Quoted cells with embedded commas,
/// quotes and newlines round-trip with [`csv_cell`].
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else {
            match c {
                '"' if cell.is_empty() => quoted = true,
                ',' => row.push(std::mem::take(&mut cell)),
                '\n' => {
                    row.push(std::mem::take(&mut cell));
                    rows.push(std::mem::take(&mut row));
                }
                '\r' => {}
                _ => cell.push(c),
            }
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    rows
}

/// Look a column up by header name — so a hand-edited file with columns in
/// another order still imports.
struct Table {
    cols: HashMap<String, usize>,
    rows: Vec<Vec<String>>,
}

impl Table {
    fn read(path: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        let mut rows = parse_csv(&text);
        if rows.is_empty() {
            return None;
        }
        let header = rows.remove(0);
        let cols = header.iter().enumerate().map(|(i, h)| (h.trim().to_string(), i)).collect();
        Some(Self { cols, rows })
    }

    fn get<'a>(&self, row: &'a [String], name: &str) -> Option<&'a str> {
        self.cols.get(name).and_then(|&i| row.get(i)).map(|s| s.as_str()).filter(|s| !s.is_empty())
    }

    fn num(&self, row: &[String], name: &str) -> Option<i64> {
        self.get(row, name).and_then(|s| s.parse().ok())
    }
}

// -------------------------------------------------------------- exports ---

/// What one export pass wrote.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExportReport {
    pub book_id: u64,
    pub confirmed_isnads: u64,
    pub transmitters: u64,
    pub rejected_isnads: u64,
    pub reuse_verdicts: u64,
    pub quran_verdicts: u64,
    pub notes: u64,
    pub dir: String,
}

/// Which files a single change touches, so a confirm does not rewrite the lot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Isnads,
    Reuse,
    Quran,
    Notes,
    All,
}

/// Rewrite the files `part` names for `book_id`. Silently does nothing when
/// the text is not in the workspace: the database is still the record, and a
/// user who has not added a text has not asked for files.
pub fn export(conn: &Connection, source: Option<&dyn BookSource>, book_id: u64, part: Part) -> Result<Option<ExportReport>, LabError> {
    let dir = book_dir(book_id).map_err(|e| LabError::Other(e.to_string()))?;
    if !dir.exists() {
        return Ok(None);
    }
    let mut r = ExportReport { book_id, dir: dir.display().to_string(), ..Default::default() };

    if matches!(part, Part::All | Part::Isnads) {
        let (confirmed, transmitters, rejected) = isnad_rows(conn, book_id)?;
        r.confirmed_isnads = confirmed.len() as u64;
        r.transmitters = transmitters.len() as u64;
        r.rejected_isnads = rejected.len() as u64;
        write_text(&dir.join("isnads/confirmed.csv"), &csv(ISNAD_HEADER, &confirmed)).map_err(io)?;
        write_text(&dir.join("isnads/transmitters.csv"), &csv(TRANSMITTER_HEADER, &transmitters)).map_err(io)?;
        write_text(&dir.join("isnads/rejected.csv"), &csv(ISNAD_HEADER, &rejected)).map_err(io)?;
    }
    if matches!(part, Part::All | Part::Reuse) {
        let rows = reuse_rows(conn, book_id)?;
        r.reuse_verdicts = rows.len() as u64;
        write_text(&dir.join("reuse/verdicts.csv"), &csv(REUSE_HEADER, &rows)).map_err(io)?;
    }
    if matches!(part, Part::All | Part::Quran) {
        let rows = quran_rows(conn, book_id)?;
        r.quran_verdicts = rows.len() as u64;
        write_text(&dir.join("quran/verdicts.csv"), &csv(QURAN_HEADER, &rows)).map_err(io)?;
    }
    if matches!(part, Part::All | Part::Notes) {
        let notes = note_rows(conn, book_id)?;
        r.notes = notes.len() as u64;
        write_json(&dir.join("notes.json"), &notes).map_err(io)?;
    }
    if part == Part::All {
        if let Some(src) = source {
            if let Ok(Some(book)) = src.book(book_id) {
                write_json(&dir.join("metadata.json"), &book).map_err(io)?;
            }
        }
    }
    // The list's second line, without re-reading every file.
    if let Some(mut e) = read_json::<Entry>(&dir.join("entry.json")) {
        if matches!(part, Part::All | Part::Isnads) {
            e.confirmed_isnads = r.confirmed_isnads;
        }
        if matches!(part, Part::All | Part::Notes) {
            e.notes = r.notes;
        }
        write_json(&dir.join("entry.json"), &e).map_err(io)?;
    }
    Ok(Some(r))
}

fn io(e: impl std::fmt::Display) -> LabError {
    LabError::Other(e.to_string())
}

fn db(e: impl std::fmt::Display) -> LabError {
    LabError::Database(e.to_string())
}

const ISNAD_HEADER: &[&str] = &[
    "isnad_id", "book_id", "part_index", "page_id", "end_part_index", "end_page_id", "tok_start", "tok_end", "kind", "status",
    "links", "confidence", "matn_tok_start", "matn_tok_end", "matn_end_part_index", "matn_end_page_id", "chain", "snapshot",
    "corpus_version", "extractor_version", "updated_at",
];

const TRANSMITTER_HEADER: &[&str] = &[
    "transmitter_id", "isnad_id", "book_id", "position", "part_index", "page_id", "tok_start", "tok_end", "raw", "place",
    "kunya", "ism", "nasab", "nisba", "laqab", "verb_before", "person_id", "person",
];

const REUSE_HEADER: &[&str] = &[
    "match_id", "verdict", "book_id", "part_index", "page_id", "tok_start", "tok_end", "snapshot", "target_book_id",
    "target_part_index", "target_page_id", "target_tok_start", "target_tok_end", "score", "type", "surface_agree",
    "lemma_agree", "root_agree", "coverage", "banality_factor", "zone", "corpus_version",
];

const QURAN_HEADER: &[&str] = &[
    "match_id", "verdict", "book_id", "part_index", "page_id", "tok_start", "tok_end", "snapshot", "sura", "aya_start",
    "aya_end", "q_tok_start", "q_tok_end", "lemma_agree", "surface_agree", "cue", "ayas_json", "corpus_version",
    "detector_version",
];

type Rows = Vec<Vec<String>>;

fn s(v: impl std::fmt::Display) -> String {
    v.to_string()
}

fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

fn isnad_rows(conn: &Connection, book_id: u64) -> Result<(Rows, Rows, Rows), LabError> {
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut st = conn.prepare("SELECT id, canonical_name FROM person").map_err(db)?;
    for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(db)? {
        let (id, n) = row.map_err(db)?;
        names.insert(id, n);
    }

    let mut confirmed: Rows = Vec::new();
    let mut rejected: Rows = Vec::new();
    let mut transmitters: Rows = Vec::new();

    let mut st = conn
        .prepare(
            "SELECT id, part_index, page_id, end_part_index, end_page_id, tok_start, tok_end, kind, status, links, \
             confidence, matn_tok_start, matn_tok_end, matn_end_part_index, matn_end_page_id, snapshot, corpus_version, \
             extractor_version, updated_at FROM isnad WHERE book_id = ?1 AND status IN ('confirmed','rejected') \
             ORDER BY part_index, page_id, tok_start",
        )
        .map_err(db)?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i64, i64, i64, Option<i64>, Option<i64>, i64, i64, String, String, i64, f64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, String, String, String, String)> = st
        .query_map([book_id as i64], |r| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?, r.get(14)?, r.get(15)?, r.get(16)?, r.get(17)?, r.get(18)?,
            ))
        })
        .map_err(db)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db)?;

    let mut tr_st = conn
        .prepare(
            "SELECT id, position, part_index, page_id, tok_start, tok_end, raw, place, kunya, ism, nasab, nisba, laqab, \
             verb_before, person_id FROM transmitter WHERE isnad_id = ?1 ORDER BY position",
        )
        .map_err(db)?;

    for (id, part, page, end_part, end_page, a, b, kind, status, links, conf, ms, me, mep, meg, snap, cv, ev, updated) in rows {
        #[allow(clippy::type_complexity)]
        let trs: Vec<(i64, i64, Option<i64>, Option<i64>, i64, i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>)> = tr_st
            .query_map([id], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
                    r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?, r.get(14)?,
                ))
            })
            .map_err(db)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db)?;
        let chain = trs
            .iter()
            .map(|t| format!("[{}] {}", t.13.clone().unwrap_or_default(), t.6))
            .collect::<Vec<_>>()
            .join(" -> ");
        let row = vec![
            s(id), s(book_id), s(part), s(page), opt(end_part), opt(end_page), s(a), s(b), kind.clone(), status.clone(),
            s(links), format!("{:.3}", conf), opt(ms), opt(me), opt(mep), opt(meg), chain, snap, cv, ev, updated,
        ];
        if status == "confirmed" {
            confirmed.push(row);
            for t in &trs {
                transmitters.push(vec![
                    s(t.0), s(id), s(book_id), s(t.1), opt(t.2.or(Some(part))), opt(t.3.or(Some(page))), s(t.4), s(t.5),
                    t.6.clone(), t.7.clone().unwrap_or_default(), t.8.clone().unwrap_or_default(),
                    t.9.clone().unwrap_or_default(), t.10.clone().unwrap_or_default(), t.11.clone().unwrap_or_default(),
                    t.12.clone().unwrap_or_default(), t.13.clone().unwrap_or_default(), opt(t.14),
                    t.14.and_then(|p| names.get(&p).cloned()).unwrap_or_default(),
                ]);
            }
        } else {
            rejected.push(row);
        }
    }
    Ok((confirmed, transmitters, rejected))
}

fn reuse_rows(conn: &Connection, book_id: u64) -> Result<Rows, LabError> {
    let mut st = conn
        .prepare(
            "SELECT id, user_verdict, part_index, page_id, tok_start, tok_end, snapshot, target_book_id, target_part_index, \
             target_page_id, target_tok_start, target_tok_end, score, type, surface_agree, lemma_agree, root_agree, \
             coverage, banality_factor, zone, corpus_version FROM reuse_match \
             WHERE book_id = ?1 AND user_verdict IS NOT NULL ORDER BY part_index, page_id, tok_start",
        )
        .map_err(db)?;
    let rows = st
        .query_map([book_id as i64], |r| {
            Ok(vec![
                s(r.get::<_, i64>(0)?),
                r.get::<_, String>(1)?,
                s(book_id),
                s(r.get::<_, i64>(2)?),
                s(r.get::<_, i64>(3)?),
                s(r.get::<_, i64>(4)?),
                s(r.get::<_, i64>(5)?),
                r.get::<_, String>(6)?,
                s(r.get::<_, i64>(7)?),
                s(r.get::<_, i64>(8)?),
                s(r.get::<_, i64>(9)?),
                s(r.get::<_, i64>(10)?),
                s(r.get::<_, i64>(11)?),
                format!("{:.4}", r.get::<_, f64>(12)?),
                r.get::<_, String>(13)?,
                opt(r.get::<_, Option<f64>>(14)?.map(|v| format!("{:.3}", v))),
                opt(r.get::<_, Option<f64>>(15)?.map(|v| format!("{:.3}", v))),
                opt(r.get::<_, Option<f64>>(16)?.map(|v| format!("{:.3}", v))),
                opt(r.get::<_, Option<f64>>(17)?.map(|v| format!("{:.3}", v))),
                opt(r.get::<_, Option<f64>>(18)?.map(|v| format!("{:.3}", v))),
                r.get::<_, Option<String>>(19)?.unwrap_or_default(),
                r.get::<_, String>(20)?,
            ])
        })
        .map_err(db)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db)?;
    Ok(rows)
}

fn quran_rows(conn: &Connection, book_id: u64) -> Result<Rows, LabError> {
    let mut st = conn
        .prepare(
            "SELECT id, user_verdict, part_index, page_id, tok_start, tok_end, snapshot, sura, aya_start, aya_end, \
             q_tok_start, q_tok_end, lemma_agree, surface_agree, cue, ayas_json, corpus_version, detector_version \
             FROM quran_match WHERE book_id = ?1 AND user_verdict IS NOT NULL ORDER BY part_index, page_id, tok_start",
        )
        .map_err(db)?;
    let rows = st
        .query_map([book_id as i64], |r| {
            Ok(vec![
                s(r.get::<_, i64>(0)?),
                r.get::<_, String>(1)?,
                s(book_id),
                s(r.get::<_, i64>(2)?),
                s(r.get::<_, i64>(3)?),
                s(r.get::<_, i64>(4)?),
                s(r.get::<_, i64>(5)?),
                r.get::<_, String>(6)?,
                s(r.get::<_, i64>(7)?),
                s(r.get::<_, i64>(8)?),
                s(r.get::<_, i64>(9)?),
                s(r.get::<_, i64>(10)?),
                s(r.get::<_, i64>(11)?),
                format!("{:.3}", r.get::<_, f64>(12)?),
                format!("{:.3}", r.get::<_, f64>(13)?),
                r.get::<_, Option<String>>(14)?.unwrap_or_default(),
                r.get::<_, Option<String>>(15)?.unwrap_or_default(),
                r.get::<_, String>(16)?,
                r.get::<_, String>(17)?,
            ])
        })
        .map_err(db)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db)?;
    Ok(rows)
}

/// One annotation, as `notes.json` holds it (spec §C4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub text: String,
    /// The tokens the note is on, normalised — what re-anchoring matches.
    pub snapshot: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub corpus_version: String,
}

/// Every note of one book, in reading order (spec 1.5 C4).
pub fn notes(conn: &Connection, book_id: u64) -> Result<Vec<Note>, LabError> {
    note_rows(conn, book_id)
}

/// One note by id.
pub fn note(conn: &Connection, id: i64) -> Result<Note, LabError> {
    conn.query_row(
        "SELECT id, book_id, part_index, page_id, tok_start, tok_end, text, snapshot, created_at, updated_at, corpus_version          FROM note WHERE id = ?1",
        [id],
        |r| {
            Ok(Note {
                id: r.get(0)?,
                book_id: r.get::<_, i64>(1)? as u64,
                part_index: r.get::<_, i64>(2)? as u32,
                page_id: r.get::<_, i64>(3)? as u64,
                tok_start: r.get::<_, i64>(4)? as usize,
                tok_end: r.get::<_, i64>(5)? as usize,
                text: r.get(6)?,
                snapshot: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                corpus_version: r.get(10)?,
            })
        },
    )
    .map_err(|e| LabError::NotFound(format!("note {}: {}", id, e)))
}

fn note_rows(conn: &Connection, book_id: u64) -> Result<Vec<Note>, LabError> {
    let mut st = conn
        .prepare(
            "SELECT id, part_index, page_id, tok_start, tok_end, text, snapshot, created_at, updated_at, corpus_version \
             FROM note WHERE book_id = ?1 ORDER BY part_index, page_id, tok_start",
        )
        .map_err(db)?;
    let rows = st
        .query_map([book_id as i64], |r| {
            Ok(Note {
                id: r.get(0)?,
                book_id,
                part_index: r.get::<_, i64>(1)? as u32,
                page_id: r.get::<_, i64>(2)? as u64,
                tok_start: r.get::<_, i64>(3)? as usize,
                tok_end: r.get::<_, i64>(4)? as usize,
                text: r.get(5)?,
                snapshot: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                corpus_version: r.get(9)?,
            })
        })
        .map_err(db)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db)?;
    Ok(rows)
}

// ---------------------------------------------------------------- add ---

/// Add a text: create its folder, write `metadata.json` and `entry.json`,
/// and export whatever the database already holds for it.
pub fn add(conn: &Connection, source: &dyn BookSource, book: &BookMetadata, author: Option<String>) -> Result<Entry, LabError> {
    let dir = book_dir(book.id).map_err(io)?;
    std::fs::create_dir_all(&dir).map_err(io)?;
    let ts = now();
    let entry = Entry {
        book_id: book.id,
        title: book.title.clone(),
        author,
        death_ah: book.death_ah,
        accessed: ts.clone(),
        added: ts,
        confirmed_isnads: 0,
        notes: 0,
    };
    write_json(&dir.join("entry.json"), &entry).map_err(io)?;
    write_json(&dir.join("metadata.json"), book).map_err(io)?;
    export(conn, Some(source), book.id, Part::All)?;
    list_one(book.id).map(|e| e.unwrap_or(entry))
}

/// Delete a text's folder. The database keeps every row (spec §A2).
pub fn remove(book_id: u64) -> Result<(), LabError> {
    let dir = book_dir(book_id).map_err(io)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(io)?;
    }
    Ok(())
}

pub fn list() -> Result<Vec<Entry>, LabError> {
    let root = root().map_err(io)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&root).map_err(io)? {
        let e = e.map_err(io)?;
        if !e.path().is_dir() {
            continue;
        }
        let Some(id) = e.file_name().to_str().and_then(|n| n.parse::<u64>().ok()) else { continue };
        if let Ok(Some(entry)) = list_one(id) {
            out.push(entry);
        }
    }
    out.sort_by(|a, b| b.accessed.cmp(&a.accessed));
    Ok(out)
}

fn list_one(book_id: u64) -> Result<Option<Entry>, LabError> {
    let dir = book_dir(book_id).map_err(io)?;
    if !dir.exists() {
        return Ok(None);
    }
    if let Some(e) = read_json::<Entry>(&dir.join("entry.json")) {
        return Ok(Some(e));
    }
    // A folder copied in without `entry.json`: rebuild it from metadata.json.
    let meta: Option<BookMetadata> = read_json(&dir.join("metadata.json"));
    let ts = now();
    let entry = Entry {
        book_id,
        title: meta.as_ref().map(|m| m.title.clone()).unwrap_or_else(|| format!("book {}", book_id)),
        author: None,
        death_ah: meta.as_ref().and_then(|m| m.death_ah),
        accessed: ts.clone(),
        added: ts,
        confirmed_isnads: 0,
        notes: 0,
    };
    write_json(&dir.join("entry.json"), &entry).map_err(io)?;
    Ok(Some(entry))
}

/// Stamp a text as opened now, and return its saved UI state.
pub fn touch(book_id: u64) -> Result<WorkspaceState, LabError> {
    let dir = book_dir(book_id).map_err(io)?;
    if let Some(mut e) = read_json::<Entry>(&dir.join("entry.json")) {
        e.accessed = now();
        write_json(&dir.join("entry.json"), &e).map_err(io)?;
    }
    Ok(read_json(&dir.join("state.json")).unwrap_or_default())
}

pub fn save_state(book_id: u64, state: &WorkspaceState) -> Result<(), LabError> {
    let dir = book_dir(book_id).map_err(io)?;
    if !dir.exists() {
        return Ok(());
    }
    write_json(&dir.join("state.json"), state).map_err(io)
}

// ------------------------------------------------------------- import ---

/// What an import found and did.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub book_id: u64,
    /// Rows the folder had that the database did not.
    pub isnads: u64,
    pub transmitters: u64,
    pub reuse: u64,
    pub quran: u64,
    pub notes: u64,
    /// Rows skipped because the database already had a decision there.
    pub skipped: u64,
    /// Rows whose snapshot no longer matches the corpus at those offsets and
    /// which were re-anchored, or could not be (§6.1).
    pub reanchored: u64,
    pub orphaned: u64,
}

impl ImportReport {
    pub fn is_empty(&self) -> bool {
        self.isnads == 0 && self.reuse == 0 && self.quran == 0 && self.notes == 0
    }
}

/// Where a snapshot actually sits on its page now (spec §6.1), or `None`.
///
/// Exact offsets first, then the page scanned for the same normalised text.
fn reanchor(page: &Page, snapshot: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let norm: Vec<String> = page.tokens.iter().map(|t| kashshaf_engine::normalize_arabic(&t.surface)).collect();
    let want: Vec<&str> = snapshot.split_whitespace().collect();
    if want.is_empty() {
        return None;
    }
    let at = |a: usize, b: usize| -> String { norm[a.min(norm.len())..b.min(norm.len())].join(" ") };
    if end <= norm.len() && at(start, end) == snapshot {
        return Some((start, end));
    }
    let n = want.len();
    if n <= norm.len() {
        for i in 0..=norm.len() - n {
            if norm[i..i + n].iter().map(|s| s.as_str()).eq(want.iter().copied()) {
                return Some((i, i + n));
            }
        }
    }
    None
}

/// Import a folder's decisions that the database lacks (spec §A2).
pub fn import(conn: &Connection, source: &dyn BookSource, book_id: u64) -> Result<ImportReport, LabError> {
    let dir = book_dir(book_id).map_err(io)?;
    let mut rep = ImportReport { book_id, ..Default::default() };
    if !dir.exists() {
        return Ok(rep);
    }
    let corpus_version = source.corpus_version().to_string();
    let mut pages: HashMap<(u32, u64), Option<Page>> = HashMap::new();
    let mut page_of = |part: u32, page: u64| -> Option<Page> {
        pages
            .entry((part, page))
            .or_insert_with(|| source.page(book_id, part, page).ok().flatten())
            .clone()
    };

    // --- isnads -----------------------------------------------------------
    for (file, status) in [("isnads/confirmed.csv", "confirmed"), ("isnads/rejected.csv", "rejected")] {
        let Some(t) = Table::read(&dir.join(file)) else { continue };
        let transmitters = Table::read(&dir.join("isnads/transmitters.csv"));
        for row in &t.rows {
            let (Some(part), Some(page), Some(a), Some(b)) =
                (t.num(row, "part_index"), t.num(row, "page_id"), t.num(row, "tok_start"), t.num(row, "tok_end"))
            else {
                continue;
            };
            let (part, page) = (part as u32, page as u64);
            let snapshot = t.get(row, "snapshot").unwrap_or_default().to_string();
            // Already decided here? The local decision wins.
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM isnad WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 \
                     AND tok_start < ?5 AND ?4 < tok_end AND status IN ('confirmed','rejected')",
                    params![book_id as i64, part as i64, page as i64, a, b],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            if existing.is_some() {
                rep.skipped += 1;
                continue;
            }
            let (mut a, mut b) = (a as usize, b as usize);
            if !snapshot.is_empty() {
                match page_of(part, page).as_ref().and_then(|p| reanchor(p, &snapshot, a, b)) {
                    Some((x, y)) => {
                        if (x, y) != (a, b) {
                            rep.reanchored += 1;
                            a = x;
                            b = y;
                        }
                    }
                    None => {
                        rep.orphaned += 1;
                    }
                }
            }
            let hash = sha1_hex(&snapshot);
            conn.execute(
                "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 kind, matn_tok_start, matn_tok_end, links, confidence, confidence_json, status, created_at, updated_at, \
                 extractor_version, lexicon_hash, overrides_json, end_part_index, end_page_id, matn_end_part_index, matn_end_page_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, '{}', ?14, ?15, ?15, ?16, 'imported', '{}', ?17, ?18, ?19, ?20)",
                params![
                    corpus_version,
                    book_id as i64,
                    part as i64,
                    page as i64,
                    a as i64,
                    b as i64,
                    snapshot,
                    hash,
                    t.get(row, "kind").unwrap_or("isnad"),
                    t.num(row, "matn_tok_start"),
                    t.num(row, "matn_tok_end"),
                    t.num(row, "links").unwrap_or(0),
                    t.get(row, "confidence").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                    status,
                    now(),
                    t.get(row, "extractor_version").unwrap_or("imported"),
                    t.num(row, "end_part_index"),
                    t.num(row, "end_page_id"),
                    t.num(row, "matn_end_part_index"),
                    t.num(row, "matn_end_page_id"),
                ],
            )
            .map_err(db)?;
            let new_id = conn.last_insert_rowid();
            rep.isnads += 1;

            // Its transmitters, matched by the isnad_id the file recorded.
            if let (Some(tt), Some(old_id)) = (&transmitters, t.num(row, "isnad_id")) {
                for tr in tt.rows.iter().filter(|r| tt.num(r, "isnad_id") == Some(old_id)) {
                    let (Some(ta), Some(tb)) = (tt.num(tr, "tok_start"), tt.num(tr, "tok_end")) else { continue };
                    conn.execute(
                        "INSERT INTO transmitter (isnad_id, position, tok_start, tok_end, raw, kunya, ism, nasab, nisba, \
                         laqab, verb_before, part_index, page_id, place) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        params![
                            new_id,
                            tt.num(tr, "position").unwrap_or(0),
                            ta,
                            tb,
                            tt.get(tr, "raw").unwrap_or_default(),
                            tt.get(tr, "kunya"),
                            tt.get(tr, "ism"),
                            tt.get(tr, "nasab"),
                            tt.get(tr, "nisba"),
                            tt.get(tr, "laqab"),
                            tt.get(tr, "verb_before"),
                            tt.num(tr, "part_index"),
                            tt.num(tr, "page_id"),
                            tt.get(tr, "place"),
                        ],
                    )
                    .map_err(db)?;
                    rep.transmitters += 1;
                }
            }
        }
    }

    // --- reuse ------------------------------------------------------------
    if let Some(t) = Table::read(&dir.join("reuse/verdicts.csv")) {
        // Imported matches need a run to hang from, created once.
        let mut run: Option<i64> = None;
        for row in &t.rows {
            let (Some(part), Some(page), Some(a), Some(b)) =
                (t.num(row, "part_index"), t.num(row, "page_id"), t.num(row, "tok_start"), t.num(row, "tok_end"))
            else {
                continue;
            };
            let (Some(tb_id), Some(tp), Some(tg), Some(ta), Some(tbe)) = (
                t.num(row, "target_book_id"),
                t.num(row, "target_part_index"),
                t.num(row, "target_page_id"),
                t.num(row, "target_tok_start"),
                t.num(row, "target_tok_end"),
            ) else {
                continue;
            };
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT id FROM reuse_match WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 AND tok_start = ?4 \
                     AND target_book_id = ?5 AND target_tok_start = ?6 AND user_verdict IS NOT NULL",
                    params![book_id as i64, part, page, a, tb_id, ta],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            if exists.is_some() {
                rep.skipped += 1;
                continue;
            }
            let run_id = match run {
                Some(r) => r,
                None => {
                    conn.execute(
                        "INSERT INTO reuse_run (corpus_version, book_id, mode, params_json, started_at, finished_at, status) \
                         VALUES (?1, ?2, 'passage', '{\"imported\":true}', ?3, ?3, 'done')",
                        params![corpus_version, book_id as i64, now()],
                    )
                    .map_err(db)?;
                    let r = conn.last_insert_rowid();
                    run = Some(r);
                    r
                }
            };
            let snapshot = t.get(row, "snapshot").unwrap_or_default().to_string();
            conn.execute(
                "INSERT INTO reuse_match (run_id, corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, \
                 snapshot_hash, target_book_id, target_part_index, target_page_id, target_tok_start, target_tok_end, score, \
                 type, surface_agree, lemma_agree, root_agree, coverage, banality_factor, zone, user_verdict) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
                params![
                    run_id,
                    corpus_version,
                    book_id as i64,
                    part,
                    page,
                    a,
                    b,
                    snapshot,
                    sha1_hex(&snapshot),
                    tb_id,
                    tp,
                    tg,
                    ta,
                    tbe,
                    t.get(row, "score").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                    t.get(row, "type").unwrap_or("weak"),
                    t.get(row, "surface_agree").and_then(|v| v.parse::<f64>().ok()),
                    t.get(row, "lemma_agree").and_then(|v| v.parse::<f64>().ok()),
                    t.get(row, "root_agree").and_then(|v| v.parse::<f64>().ok()),
                    t.get(row, "coverage").and_then(|v| v.parse::<f64>().ok()),
                    t.get(row, "banality_factor").and_then(|v| v.parse::<f64>().ok()),
                    t.get(row, "zone"),
                    t.get(row, "verdict").unwrap_or("confirmed"),
                ],
            )
            .map_err(db)?;
            rep.reuse += 1;
        }
    }

    // --- quran ------------------------------------------------------------
    if let Some(t) = Table::read(&dir.join("quran/verdicts.csv")) {
        for row in &t.rows {
            let (Some(part), Some(page), Some(a), Some(b), Some(sura), Some(aya)) = (
                t.num(row, "part_index"),
                t.num(row, "page_id"),
                t.num(row, "tok_start"),
                t.num(row, "tok_end"),
                t.num(row, "sura"),
                t.num(row, "aya_start"),
            ) else {
                continue;
            };
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT id FROM quran_match WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 AND tok_start = ?4 \
                     AND tok_end = ?5 AND sura = ?6 AND aya_start = ?7",
                    params![book_id as i64, part, page, a, b, sura, aya],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            if exists.is_some() {
                rep.skipped += 1;
                continue;
            }
            let snapshot = t.get(row, "snapshot").unwrap_or_default().to_string();
            conn.execute(
                "INSERT INTO quran_match (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, \
                 snapshot_hash, sura, aya_start, aya_end, q_tok_start, q_tok_end, lemma_agree, surface_agree, cue, \
                 user_verdict, created_at, detector_version, ayas_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    corpus_version,
                    book_id as i64,
                    part,
                    page,
                    a,
                    b,
                    snapshot,
                    sha1_hex(&snapshot),
                    sura,
                    aya,
                    t.num(row, "aya_end").unwrap_or(aya),
                    t.num(row, "q_tok_start").unwrap_or(0),
                    t.num(row, "q_tok_end").unwrap_or(0),
                    t.get(row, "lemma_agree").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                    t.get(row, "surface_agree").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                    t.get(row, "cue"),
                    t.get(row, "verdict").unwrap_or("confirmed"),
                    now(),
                    t.get(row, "detector_version").unwrap_or("imported"),
                    t.get(row, "ayas_json"),
                ],
            )
            .map_err(db)?;
            rep.quran += 1;
        }
    }

    // --- notes ------------------------------------------------------------
    if let Some(notes) = read_json::<Vec<Note>>(&dir.join("notes.json")) {
        for n in notes {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT id FROM note WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 AND tok_start = ?4 AND text = ?5",
                    params![book_id as i64, n.part_index as i64, n.page_id as i64, n.tok_start as i64, n.text],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            if exists.is_some() {
                rep.skipped += 1;
                continue;
            }
            let (mut a, mut b) = (n.tok_start, n.tok_end);
            if !n.snapshot.is_empty() {
                match page_of(n.part_index, n.page_id).as_ref().and_then(|p| reanchor(p, &n.snapshot, a, b)) {
                    Some((x, y)) => {
                        if (x, y) != (a, b) {
                            rep.reanchored += 1;
                            a = x;
                            b = y;
                        }
                    }
                    None => rep.orphaned += 1,
                }
            }
            conn.execute(
                "INSERT INTO note (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    corpus_version,
                    book_id as i64,
                    n.part_index as i64,
                    n.page_id as i64,
                    a as i64,
                    b as i64,
                    n.snapshot,
                    sha1_hex(&n.snapshot),
                    n.text,
                    n.created_at,
                    now(),
                ],
            )
            .map_err(db)?;
            rep.notes += 1;
        }
    }

    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trips_quotes_commas_and_newlines() {
        let rows = vec![vec!["a,b".to_string(), "he said \"hi\"".to_string(), "two\nlines".to_string(), String::new()]];
        let text = csv(&["x", "y", "z", "w"], &rows);
        let back = parse_csv(&text);
        assert_eq!(back[0], vec!["x", "y", "z", "w"]);
        assert_eq!(back[1], rows[0]);
    }

    #[test]
    fn a_table_finds_columns_by_name_whatever_their_order() {
        let text = "b,a\n2,1\n";
        let mut rows = parse_csv(text);
        let header = rows.remove(0);
        let t = Table { cols: header.iter().enumerate().map(|(i, h)| (h.clone(), i)).collect(), rows };
        assert_eq!(t.get(&t.rows[0], "a"), Some("1"));
        assert_eq!(t.num(&t.rows[0], "b"), Some(2));
        assert_eq!(t.get(&t.rows[0], "missing"), None);
    }

    #[test]
    fn reanchoring_finds_a_moved_span_and_gives_up_honestly() {
        use crate::analysis::text::fixtures::page;
        let p = page(1, 0, 1, "", "الف باء تاء ثاء جيم حاء");
        // Exact offsets still hold.
        assert_eq!(reanchor(&p, "تاء ثاء", 2, 4), Some((2, 4)));
        // The span moved: found by its text.
        assert_eq!(reanchor(&p, "تاء ثاء", 0, 2), Some((2, 4)));
        // Not on this page at all.
        assert_eq!(reanchor(&p, "لا شيء هنا", 0, 3), None);
    }
}

/// The snapshot hash every anchored table stores (spec 6.1).
fn sha1_hex(s: &str) -> String {
    use sha1::{Digest, Sha1};
    hex::encode(Sha1::digest(s.as_bytes()))
}
