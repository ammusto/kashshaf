//! The isnād workbench's commands (Lab spec §4.2, §6.2, §6.3, §7.4).
//!
//! Extraction runs whole-book, streaming per page into `analysis.db`. Every
//! change the workbench makes goes through one door, [`apply`], as a typed
//! [`Op`]: it runs in a transaction, is written to `equivalence_log`, and
//! returns the op that undoes it — which is what the session undo/redo stack
//! holds (§7.4). Undo is therefore just `apply(inverse)`, and redo the
//! inverse of that.
//!
//! Suggestions (§6.3) are computed, never written: an unlinked transmitter
//! whose `form_norm` matches a `name_form` is *shown* with the person; only
//! an explicit `Link` or `AcceptSuggestions` writes anything.

use crate::analysis::isnad::{self, Candidate, Class, Params, MATN_MAX_PAGES};
use crate::analysis::names::{self, NameParts};
use crate::error::LabError;
use crate::lexicon;
use crate::source::{Page, Token};
use crate::state::{handles, Handles, ManagedLabState};
use crate::store::now;
use kashshaf_engine::normalize_arabic;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tauri::{Emitter, State, Window};

// ------------------------------------------------------------------ rows ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransmitterRow {
    pub id: i64,
    pub isnad_id: i64,
    pub position: i64,
    /// Stream offsets from the isnād's start page (amendment 1.4).
    pub tok_start: usize,
    pub tok_end: usize,
    /// The page the span starts on; `None` = the isnād's start page.
    pub part_index: Option<u32>,
    pub page_id: Option<u64>,
    /// A place tag after the name (`بالكوفة`).
    pub place: Option<String>,
    pub raw: String,
    pub kunya: Option<String>,
    pub ism: Option<String>,
    pub nasab: Option<String>,
    pub nisba: Option<String>,
    pub laqab: Option<String>,
    pub verb_before: Option<String>,
    pub person_id: Option<i64>,
    /// `names::form_norm(raw)`, the key suggestions match on.
    pub form_norm: String,
    /// A person whose `name_form` matches, when unlinked (§6.3: suggested,
    /// dashed, never auto-linked).
    pub suggested_person_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IsnadRow {
    pub id: i64,
    pub book_id: u64,
    /// The start page; offsets are stream offsets from its token 0 and may
    /// run past its end (amendment 1.4).
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    /// The page `tok_end − 1` falls on; `None` = the start page.
    pub end_part_index: Option<u32>,
    pub end_page_id: Option<u64>,
    pub kind: String,
    pub matn_tok_start: Option<usize>,
    pub matn_tok_end: Option<usize>,
    pub matn_end_part_index: Option<u32>,
    pub matn_end_page_id: Option<u64>,
    pub links: i64,
    pub confidence: f64,
    pub confidence_json: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub overrides: HashMap<usize, Class>,
    pub transmitters: Vec<TransmitterRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameFormRow {
    pub id: i64,
    pub person_id: i64,
    pub form: String,
    pub form_norm: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonRow {
    pub id: i64,
    pub canonical_name: String,
    pub death_ah: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub forms: Vec<NameFormRow>,
    /// Linked transmitters, across every book.
    pub linked: i64,
}

pub(crate) fn db(h: &Handles) -> Result<Connection, LabError> {
    h.store
        .as_ref()
        .ok_or_else(|| LabError::Database("analysis.db is not available".into()))?
        .connect()
        .map_err(|e| LabError::Database(e.to_string()))
}

pub(crate) fn dberr(e: impl std::fmt::Display) -> LabError {
    LabError::Database(e.to_string())
}

fn read_transmitters(conn: &Connection, isnad_id: i64) -> Result<Vec<TransmitterRow>, LabError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, isnad_id, position, tok_start, tok_end, raw, kunya, ism, nasab, nisba, laqab, verb_before, person_id, \
             part_index, page_id, place FROM transmitter WHERE isnad_id = ?1 ORDER BY position",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([isnad_id], |r| {
            let raw: String = r.get(5)?;
            Ok(TransmitterRow {
                id: r.get(0)?,
                isnad_id: r.get(1)?,
                position: r.get(2)?,
                tok_start: r.get::<_, i64>(3)? as usize,
                tok_end: r.get::<_, i64>(4)? as usize,
                part_index: r.get::<_, Option<i64>>(13)?.map(|v| v as u32),
                page_id: r.get::<_, Option<i64>>(14)?.map(|v| v as u64),
                place: r.get(15)?,
                form_norm: names::form_norm(&raw),
                raw,
                kunya: r.get(6)?,
                ism: r.get(7)?,
                nasab: r.get(8)?,
                nisba: r.get(9)?,
                laqab: r.get(10)?,
                verb_before: r.get(11)?,
                person_id: r.get(12)?,
                suggested_person_id: None,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

/// Fill `suggested_person_id` for unlinked rows from `name_form`.
fn suggest(conn: &Connection, rows: &mut [TransmitterRow]) -> Result<(), LabError> {
    let mut stmt = conn.prepare("SELECT person_id FROM name_form WHERE form_norm = ?1 LIMIT 1").map_err(dberr)?;
    for t in rows.iter_mut().filter(|t| t.person_id.is_none()) {
        t.suggested_person_id = stmt.query_row([&t.form_norm], |r| r.get(0)).optional().map_err(dberr)?;
    }
    Ok(())
}

fn read_isnad(conn: &Connection, id: i64) -> Result<IsnadRow, LabError> {
    let mut row = conn
        .query_row(
            "SELECT id, book_id, part_index, page_id, tok_start, tok_end, kind, matn_tok_start, matn_tok_end, links, \
             confidence, confidence_json, status, created_at, updated_at, overrides_json, \
             end_part_index, end_page_id, matn_end_part_index, matn_end_page_id FROM isnad WHERE id = ?1",
            [id],
            |r| {
                let overrides_json: String = r.get(15)?;
                Ok(IsnadRow {
                    id: r.get(0)?,
                    book_id: r.get::<_, i64>(1)? as u64,
                    part_index: r.get::<_, i64>(2)? as u32,
                    page_id: r.get::<_, i64>(3)? as u64,
                    tok_start: r.get::<_, i64>(4)? as usize,
                    tok_end: r.get::<_, i64>(5)? as usize,
                    end_part_index: r.get::<_, Option<i64>>(16)?.map(|v| v as u32),
                    end_page_id: r.get::<_, Option<i64>>(17)?.map(|v| v as u64),
                    kind: r.get(6)?,
                    matn_tok_start: r.get::<_, Option<i64>>(7)?.map(|v| v as usize),
                    matn_tok_end: r.get::<_, Option<i64>>(8)?.map(|v| v as usize),
                    matn_end_part_index: r.get::<_, Option<i64>>(18)?.map(|v| v as u32),
                    matn_end_page_id: r.get::<_, Option<i64>>(19)?.map(|v| v as u64),
                    links: r.get(9)?,
                    confidence: r.get(10)?,
                    confidence_json: r.get(11)?,
                    status: r.get(12)?,
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                    overrides: serde_json::from_str(&overrides_json).unwrap_or_default(),
                    transmitters: vec![],
                })
            },
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| LabError::NotFound(format!("isnād {}", id)))?;
    row.transmitters = read_transmitters(conn, id)?;
    suggest(conn, &mut row.transmitters)?;
    Ok(row)
}

// ------------------------------------------------------------ extraction ---

pub(crate) fn snapshot(page: &Page, start: usize, end: usize) -> (String, String) {
    let text: Vec<String> = page.tokens[start.min(page.tokens.len())..end.min(page.tokens.len())]
        .iter()
        .map(|t| normalize_arabic(&t.surface))
        .collect();
    let s = text.join(" ");
    let hash = hex::encode(Sha1::digest(s.as_bytes()));
    (s, hash)
}

/// The pages a span runs over, as `(tokens, body)` for the extractor, and
/// their stream starts.
fn window_refs<'a>(pages: &[&'a Page]) -> Vec<(&'a [Token], &'a str)> {
    pages.iter().map(|p| (p.tokens.as_slice(), p.body.as_str())).collect()
}

/// The page of a stream offset in a window, as `(part_index, page_id)`.
fn page_of(window: &[&Page], starts: &[usize], offset: usize) -> (u32, u64) {
    let (k, _) = isnad::locate(starts, offset.min(starts[starts.len() - 1].saturating_sub(1)));
    let p = window[k.min(window.len() - 1)];
    (p.part_index, p.page_id)
}

/// Insert a candidate whose offsets are stream offsets over `window`
/// (the start page first). The snapshot covers the start page only.
fn insert_candidate(conn: &Connection, corpus_version: &str, window: &[&Page], c: &Candidate, lexicon_hash: &str, overrides: &HashMap<usize, Class>) -> Result<i64, LabError> {
    let page = window[0];
    let starts = isnad::page_starts(&window_refs(window));
    let (snap, hash) = snapshot(page, c.tok_start, c.tok_end);
    let (end_part, end_page) = page_of(window, &starts, c.tok_end.saturating_sub(1));
    let matn_end = c.matn.map(|(_, e)| page_of(window, &starts, e.saturating_sub(1)));
    let ts = now();
    conn.execute(
        "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
         kind, matn_tok_start, matn_tok_end, links, confidence, confidence_json, status, created_at, updated_at, \
         extractor_version, lexicon_hash, overrides_json, end_part_index, end_page_id, matn_end_part_index, matn_end_page_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'candidate', ?15, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            corpus_version,
            page.book_id as i64,
            page.part_index as i64,
            page.page_id as i64,
            c.tok_start as i64,
            c.tok_end as i64,
            snap,
            hash,
            match c.kind { isnad::Kind::Isnad => "isnad", isnad::Kind::Citation => "citation" },
            c.matn.map(|m| m.0 as i64),
            c.matn.map(|m| m.1 as i64),
            c.links as i64,
            c.confidence.total,
            serde_json::to_string(&c.confidence).unwrap_or_default(),
            ts,
            isnad::EXTRACTOR_VERSION,
            lexicon_hash,
            serde_json::to_string(overrides).unwrap_or_else(|_| "{}".into()),
            end_part as i64,
            end_page as i64,
            matn_end.map(|(p, _)| p as i64),
            matn_end.map(|(_, g)| g as i64),
        ],
    )
    .map_err(dberr)?;
    let id = conn.last_insert_rowid();
    for t in &c.transmitters {
        let (tp, tg) = page_of(window, &starts, t.tok_start);
        insert_transmitter(conn, id, t.position as i64, t.tok_start, t.tok_end, &t.raw, &t.parts, t.verb_before.as_deref(), Some((tp, tg)), t.place.as_deref())?;
    }
    Ok(id)
}

/// The pages an isnād runs over — start page through the later of its end
/// page and its matn's end page — and its tokens as one stream.
fn span_window(h: &Handles, row: &IsnadRow) -> Result<Vec<Page>, LabError> {
    let refs = h.source.page_refs(row.book_id)?;
    let start = refs.iter().position(|r| r.part_index == row.part_index && r.page_id == row.page_id).ok_or_else(|| LabError::NotFound(format!("page {}:{}", row.part_index, row.page_id)))?;
    let find = |p: Option<u32>, g: Option<u64>| p.zip(g).and_then(|(p, g)| refs.iter().position(|r| r.part_index == p && r.page_id == g));
    let end = [find(row.end_part_index, row.end_page_id), find(row.matn_end_part_index, row.matn_end_page_id)].into_iter().flatten().max().unwrap_or(start).max(start);
    let mut pages = Vec::with_capacity(end - start + 1);
    for r in &refs[start..=end.min(start + MATN_MAX_PAGES)] {
        pages.push(h.source.page(r.book_id, r.part_index, r.page_id)?.ok_or_else(|| LabError::NotFound(format!("page {}:{}", r.part_index, r.page_id)))?);
    }
    Ok(pages)
}

fn stream_tokens(pages: &[Page]) -> Vec<Token> {
    pages.iter().flat_map(|p| p.tokens.iter().cloned()).collect()
}

#[allow(clippy::too_many_arguments)]
fn insert_transmitter(conn: &Connection, isnad_id: i64, position: i64, start: usize, end: usize, raw: &str, parts: &NameParts, verb: Option<&str>, page: Option<(u32, u64)>, place: Option<&str>) -> Result<i64, LabError> {
    conn.execute(
        "INSERT INTO transmitter (isnad_id, position, tok_start, tok_end, raw, kunya, ism, nasab, nisba, laqab, verb_before, part_index, page_id, place) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![isnad_id, position, start as i64, end as i64, raw, parts.kunya, parts.ism, parts.nasab, parts.nisba, parts.laqab, verb, page.map(|p| p.0 as i64), page.map(|p| p.1 as i64), place],
    )
    .map_err(dberr)?;
    Ok(conn.last_insert_rowid())
}

#[derive(Debug, Clone, Serialize)]
struct RunProgress {
    done: u64,
    total: u64,
    found: u64,
    estimate_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub book_id: u64,
    pub pages: usize,
    pub candidates: usize,
    pub kept_confirmed: usize,
    pub elapsed_ms: u64,
    pub lexicon_hash: String,
}

/// Extract the whole current book (§4.2 "Whole-book run"), streaming: each
/// page's candidates are written as the page completes, and `isnad-progress`
/// fires per page, so a cancelled run keeps every finished page.
///
/// Rows with status `candidate` for this book are replaced; confirmed,
/// rejected and orphaned rows — the user's decisions — are kept, and a new
/// candidate overlapping a kept row is not inserted.
#[tauri::command]
pub async fn isnad_run(window: Window, state: State<'_, ManagedLabState>, book_id: u64, params: Option<Params>) -> Result<RunSummary, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let book = crate::commands::stats::load_book(&h, Some(&window), book_id)?;
        let conn = db(&h)?;
        let lex = lexicon::load(&conn).map_err(dberr)?;
        let params = params.unwrap_or_default();
        let corpus_version = h.source.corpus_version().to_string();
        h.cancel.store(false, Ordering::SeqCst);
        let started = std::time::Instant::now();

        conn.execute("DELETE FROM isnad WHERE book_id = ?1 AND status = 'candidate'", [book_id as i64]).map_err(dberr)?;
        let kept: Vec<(i64, i64, i64, i64)> = {
            let mut stmt = conn.prepare("SELECT part_index, page_id, tok_start, tok_end FROM isnad WHERE book_id = ?1").map_err(dberr)?;
            let v = stmt.query_map([book_id as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
            v
        };
        let kept_count = kept.len();

        let total = book.pages.len() as u64;
        let mut found = 0u64;
        let no_overrides = HashMap::new();
        for (i, page) in book.pages.iter().enumerate() {
            if h.cancel.load(Ordering::SeqCst) {
                break;
            }
            // The book as one stream (amendment 1.4): this page plus the
            // pages a chain or matn may run on to; only chains that start
            // here are kept, so nothing is emitted twice.
            let win_pages: Vec<&Page> = book.pages[i..(i + 1 + MATN_MAX_PAGES).min(book.pages.len())].iter().collect();
            let cands = isnad::extract_stream(&window_refs(&win_pages), &lex, &params, &no_overrides);
            conn.execute_batch("BEGIN").map_err(dberr)?;
            for c in cands.iter().filter(|c| c.tok_start < page.tokens.len()) {
                let overlaps_kept = kept.iter().any(|(p, g, s, e)| {
                    *p == page.part_index as i64 && *g == page.page_id as i64 && (c.tok_start as i64) < *e && *s < (c.tok_end as i64)
                });
                if overlaps_kept {
                    continue;
                }
                insert_candidate(&conn, &corpus_version, &win_pages, c, &lex.hash, &no_overrides)?;
                found += 1;
            }
            conn.execute_batch("COMMIT").map_err(dberr)?;
            let elapsed = started.elapsed().as_millis() as u64;
            let done = i as u64 + 1;
            let _ = window.emit(
                "isnad-progress",
                RunProgress { done, total, found, estimate_ms: if done >= 20 { Some(elapsed * total / done) } else { None } },
            );
        }
        Ok(RunSummary {
            book_id,
            pages: book.pages.len(),
            candidates: found as usize,
            kept_confirmed: kept_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            lexicon_hash: lex.hash,
        })
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// --------------------------------------------------------------- listing ---

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IsnadFilter {
    pub status: Option<String>,
    pub kind: Option<String>,
    pub min_confidence: Option<f64>,
    pub min_links: Option<i64>,
    /// `[first page index, last page index]` in reading order, inclusive.
    pub page_from: Option<u64>,
    pub page_to: Option<u64>,
}

#[tauri::command]
pub async fn isnad_list(state: State<'_, ManagedLabState>, book_id: u64, filter: Option<IsnadFilter>) -> Result<Vec<IsnadRow>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let f = filter.unwrap_or_default();
        let mut stmt = conn
            .prepare(
                "SELECT id FROM isnad WHERE book_id = ?1 \
                 AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR kind = ?3) \
                 AND (?4 IS NULL OR confidence >= ?4) AND (?5 IS NULL OR links >= ?5) \
                 AND (?6 IS NULL OR page_id >= ?6) AND (?7 IS NULL OR page_id <= ?7) \
                 ORDER BY part_index, page_id, tok_start",
            )
            .map_err(dberr)?;
        let ids: Vec<i64> = stmt
            .query_map(
                params![book_id as i64, f.status, f.kind, f.min_confidence, f.min_links, f.page_from.map(|v| v as i64), f.page_to.map(|v| v as i64)],
                |r| r.get(0),
            )
            .map_err(dberr)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr)?;
        ids.into_iter().map(|id| read_isnad(&conn, id)).collect()
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[tauri::command]
pub async fn isnad_get(state: State<'_, ManagedLabState>, id: i64) -> Result<IsnadRow, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || read_isnad(&db(&h)?, id)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

/// Token classes over an isnād's page, recomputed with its overrides — the
/// workbench's colours (§7.4): transmitters, verbs and matn each their own.
#[tauri::command]
pub async fn isnad_classes(state: State<'_, ManagedLabState>, id: i64) -> Result<Vec<(usize, Class)>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let row = read_isnad(&conn, id)?;
        let pages = span_window(&h, &row)?;
        let lex = lexicon::load(&conn).map_err(dberr)?;
        let refs: Vec<&Page> = pages.iter().collect();
        let starts = isnad::page_starts(&window_refs(&refs));
        let mut views: Vec<isnad::View> = Vec::new();
        let mut headings: Vec<(usize, usize)> = Vec::new();
        for (k, p) in pages.iter().enumerate() {
            views.extend(p.tokens.iter().map(isnad::View::of));
            headings.extend(crate::analysis::sections::headings(&p.body).into_iter().map(|x| (x.tok_start + starts[k], x.tok_end + starts[k])));
        }
        let (classes, _, _) = isnad::classify(&views, &lex, &Params::default(), &row.overrides, &headings);
        Ok(classes.into_iter().enumerate().collect())
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// ------------------------------------------------------------------ ops ---

/// Every mutation of the workbench (§7.4) and the authority file (§6.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    SetStatus { isnad_id: i64, status: String },
    SetMatn { isnad_id: i64, start: Option<usize>, end: Option<usize> },
    /// Split a transmitter span at `at` (a page token index inside it).
    SplitTransmitter { transmitter_id: i64, at: usize },
    /// Merge two adjacent transmitters of one isnād into the left one.
    MergeTransmitters { left_id: i64, right_id: i64 },
    /// Retag one token of an isnād's page for this span; `None` clears.
    Retag { isnad_id: i64, tok: usize, class: Option<Class> },
    Link { transmitter_id: i64, person_id: i64 },
    Unlink { transmitter_id: i64 },
    /// Link to a new person created from the transmitter's form.
    LinkNew { transmitter_id: i64, canonical_name: Option<String> },
    DeletePerson { person_id: i64 },
    /// Merge `from` into `into`: forms and transmitters move, `from` is deleted.
    MergePersons { into: i64, from: i64 },
    /// Split the given transmitters (and the forms only they use) off `person_id`
    /// into a new person.
    SplitPerson { person_id: i64, transmitter_ids: Vec<i64>, canonical_name: String },
    RenamePerson { person_id: i64, canonical_name: String },
    SetDeath { person_id: i64, death_ah: Option<i64> },
    SetNotes { person_id: i64, notes: Option<String> },
    /// Mark a manually selected range as an isnād (§7.2, §7.4).
    AddManual { book_id: u64, part_index: u32, page_id: u64, tok_start: usize, tok_end: usize },
    DeleteIsnad { isnad_id: i64 },
    /// Several ops as one undo step (accept-all-suggestions).
    Batch { ops: Vec<Op> },
    /// Remove one form from a person (the inverse half of a merge).
    SplitFormOff { person_id: i64, form_norm: String },
    /// Restore rows a delete removed (the inverse of DeletePerson / DeleteIsnad).
    RestorePerson { person: PersonRow, transmitter_ids: Vec<i64> },
    RestoreIsnad { row: IsnadRow, snapshot: String, snapshot_hash: String, corpus_version: String, extractor_version: String, lexicon_hash: String },
    RestoreTransmitter { row: TransmitterRow },
}

fn op_name(op: &Op) -> &'static str {
    match op {
        Op::SetStatus { .. } => "set_status",
        Op::SetMatn { .. } => "set_matn",
        Op::SplitTransmitter { .. } => "split_transmitter",
        Op::MergeTransmitters { .. } => "merge_transmitters",
        Op::Retag { .. } => "retag",
        Op::Link { .. } => "link",
        Op::Unlink { .. } => "unlink",
        Op::LinkNew { .. } => "link_new",
        Op::DeletePerson { .. } => "delete_person",
        Op::MergePersons { .. } => "merge",
        Op::SplitPerson { .. } => "split",
        Op::RenamePerson { .. } => "rename",
        Op::SetDeath { .. } => "set_death",
        Op::SetNotes { .. } => "set_notes",
        Op::AddManual { .. } => "add_manual",
        Op::DeleteIsnad { .. } => "delete_isnad",
        Op::Batch { .. } => "batch",
        Op::SplitFormOff { .. } => "split_form_off",
        Op::RestorePerson { .. } => "restore_person",
        Op::RestoreIsnad { .. } => "restore_isnad",
        Op::RestoreTransmitter { .. } => "restore_transmitter",
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Applied {
    pub log_id: i64,
    /// What undoes this.
    pub inverse: Op,
}

fn touch_isnad(conn: &Connection, id: i64) -> Result<(), LabError> {
    conn.execute("UPDATE isnad SET updated_at = ?2 WHERE id = ?1", params![id, now()]).map_err(dberr)?;
    Ok(())
}

fn read_person(conn: &Connection, id: i64) -> Result<PersonRow, LabError> {
    let mut p = conn
        .query_row(
            "SELECT id, canonical_name, death_ah, notes, created_at, updated_at FROM person WHERE id = ?1",
            [id],
            |r| Ok(PersonRow { id: r.get(0)?, canonical_name: r.get(1)?, death_ah: r.get(2)?, notes: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)?, forms: vec![], linked: 0 }),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| LabError::NotFound(format!("person {}", id)))?;
    let mut stmt = conn.prepare("SELECT id, person_id, form, form_norm, source FROM name_form WHERE person_id = ?1 ORDER BY id").map_err(dberr)?;
    p.forms = stmt
        .query_map([id], |r| Ok(NameFormRow { id: r.get(0)?, person_id: r.get(1)?, form: r.get(2)?, form_norm: r.get(3)?, source: r.get(4)? }))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    p.linked = conn.query_row("SELECT COUNT(*) FROM transmitter WHERE person_id = ?1", [id], |r| r.get(0)).map_err(dberr)?;
    Ok(p)
}

fn add_form(conn: &Connection, person_id: i64, raw: &str, source: &str) -> Result<(), LabError> {
    conn.execute(
        "INSERT OR IGNORE INTO name_form (person_id, form, form_norm, source) VALUES (?1, ?2, ?3, ?4)",
        params![person_id, normalize_arabic(raw), names::form_norm(raw), source],
    )
    .map_err(dberr)?;
    Ok(())
}

fn transmitter_of(conn: &Connection, id: i64) -> Result<TransmitterRow, LabError> {
    let isnad_id: i64 = conn
        .query_row("SELECT isnad_id FROM transmitter WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| LabError::NotFound(format!("transmitter {}", id)))?;
    read_transmitters(conn, isnad_id)?.into_iter().find(|t| t.id == id).ok_or_else(|| LabError::NotFound(format!("transmitter {}", id)))
}

/// Apply one op inside a transaction and log it; returns the inverse.
pub fn apply(conn: &Connection, h: &Handles, op: &Op) -> Result<Applied, LabError> {
    conn.execute_batch("BEGIN").map_err(dberr)?;
    let r = apply_inner(conn, h, op);
    match r {
        Ok(inverse) => {
            conn.execute(
                "INSERT INTO equivalence_log (at, action, detail_json) VALUES (?1, ?2, ?3)",
                params![now(), op_name(op), serde_json::to_string(op).unwrap_or_default()],
            )
            .map_err(dberr)?;
            let log_id = conn.last_insert_rowid();
            conn.execute_batch("COMMIT").map_err(dberr)?;
            Ok(Applied { log_id, inverse })
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn apply_inner(conn: &Connection, h: &Handles, op: &Op) -> Result<Op, LabError> {
    match op {
        Op::SetStatus { isnad_id, status } => {
            if !["candidate", "confirmed", "rejected", "orphaned"].contains(&status.as_str()) {
                return Err(LabError::Other(format!("not a status: {}", status)));
            }
            let prev: String = conn.query_row("SELECT status FROM isnad WHERE id = ?1", [isnad_id], |r| r.get(0)).map_err(dberr)?;
            conn.execute("UPDATE isnad SET status = ?2, updated_at = ?3 WHERE id = ?1", params![isnad_id, status, now()]).map_err(dberr)?;
            Ok(Op::SetStatus { isnad_id: *isnad_id, status: prev })
        }
        Op::SetMatn { isnad_id, start, end } => {
            let (ps, pe): (Option<i64>, Option<i64>) = conn
                .query_row("SELECT matn_tok_start, matn_tok_end FROM isnad WHERE id = ?1", [isnad_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(dberr)?;
            conn.execute(
                "UPDATE isnad SET matn_tok_start = ?2, matn_tok_end = ?3, updated_at = ?4 WHERE id = ?1",
                params![isnad_id, start.map(|v| v as i64), end.map(|v| v as i64), now()],
            )
            .map_err(dberr)?;
            // The chain ends where the matn begins.
            if let Some(s) = start {
                conn.execute("UPDATE isnad SET tok_end = ?2 WHERE id = ?1 AND tok_end > ?2", params![isnad_id, *s as i64]).map_err(dberr)?;
            }
            Ok(Op::SetMatn { isnad_id: *isnad_id, start: ps.map(|v| v as usize), end: pe.map(|v| v as usize) })
        }
        Op::SplitTransmitter { transmitter_id, at } => {
            let t = transmitter_of(conn, *transmitter_id)?;
            if *at <= t.tok_start || *at >= t.tok_end {
                return Err(LabError::Other("split point must be inside the transmitter".into()));
            }
            let row = read_isnad(conn, t.isnad_id)?;
            let pages = span_window(h, &row)?;
            let tokens = stream_tokens(&pages);
            let raw_of = |a: usize, b: usize| tokens[a..b].iter().map(|x| x.surface.clone()).collect::<Vec<_>>().join(" ");
            let parts_of = |a: usize, b: usize| names::parse(&tokens[a..b].iter().map(|x| normalize_arabic(&x.surface)).collect::<Vec<_>>());
            let (la, lb) = (t.tok_start, *at);
            let (ra, rb) = (*at, t.tok_end);
            let lp = parts_of(la, lb);
            conn.execute(
                "UPDATE transmitter SET tok_end = ?2, raw = ?3, kunya = ?4, ism = ?5, nasab = ?6, nisba = ?7, laqab = ?8 WHERE id = ?1",
                params![t.id, lb as i64, raw_of(la, lb), lp.kunya, lp.ism, lp.nasab, lp.nisba, lp.laqab],
            )
            .map_err(dberr)?;
            conn.execute("UPDATE transmitter SET position = position + 1 WHERE isnad_id = ?1 AND position > ?2", params![t.isnad_id, t.position]).map_err(dberr)?;
            let refs: Vec<&Page> = pages.iter().collect();
            let starts = isnad::page_starts(&window_refs(&refs));
            let right_id = insert_transmitter(conn, t.isnad_id, t.position + 1, ra, rb, &raw_of(ra, rb), &parts_of(ra, rb), None, Some(page_of(&refs, &starts, ra)), t.place.as_deref())?;
            conn.execute("UPDATE transmitter SET place = NULL WHERE id = ?1", [t.id]).map_err(dberr)?;
            conn.execute("UPDATE isnad SET links = (SELECT COUNT(*) FROM transmitter WHERE isnad_id = ?1) WHERE id = ?1", [t.isnad_id]).map_err(dberr)?;
            touch_isnad(conn, t.isnad_id)?;
            Ok(Op::MergeTransmitters { left_id: t.id, right_id })
        }
        Op::MergeTransmitters { left_id, right_id } => {
            let l = transmitter_of(conn, *left_id)?;
            let r = transmitter_of(conn, *right_id)?;
            if l.isnad_id != r.isnad_id || r.position != l.position + 1 {
                return Err(LabError::Other("only adjacent transmitters of one isnād can be merged".into()));
            }
            let row = read_isnad(conn, l.isnad_id)?;
            let tokens = stream_tokens(&span_window(h, &row)?);
            let raw = tokens[l.tok_start..r.tok_end].iter().map(|x| x.surface.clone()).collect::<Vec<_>>().join(" ");
            let parts = names::parse(&tokens[l.tok_start..r.tok_end].iter().map(|x| normalize_arabic(&x.surface)).collect::<Vec<_>>());
            conn.execute(
                "UPDATE transmitter SET tok_end = ?2, raw = ?3, kunya = ?4, ism = ?5, nasab = ?6, nisba = ?7, laqab = ?8, place = COALESCE(?9, place) WHERE id = ?1",
                params![l.id, r.tok_end as i64, raw, parts.kunya, parts.ism, parts.nasab, parts.nisba, parts.laqab, r.place],
            )
            .map_err(dberr)?;
            conn.execute("DELETE FROM transmitter WHERE id = ?1", [r.id]).map_err(dberr)?;
            conn.execute("UPDATE transmitter SET position = position - 1 WHERE isnad_id = ?1 AND position > ?2", params![l.isnad_id, l.position]).map_err(dberr)?;
            conn.execute("UPDATE isnad SET links = (SELECT COUNT(*) FROM transmitter WHERE isnad_id = ?1) WHERE id = ?1", [l.isnad_id]).map_err(dberr)?;
            touch_isnad(conn, l.isnad_id)?;
            Ok(Op::SplitTransmitter { transmitter_id: l.id, at: r.tok_start })
        }
        Op::Retag { isnad_id, tok, class } => {
            let row = read_isnad(conn, *isnad_id)?;
            let prev = row.overrides.get(tok).copied();
            let mut ov = row.overrides.clone();
            match class {
                Some(c) => {
                    ov.insert(*tok, *c);
                }
                None => {
                    ov.remove(tok);
                }
            }
            conn.execute(
                "UPDATE isnad SET overrides_json = ?2, updated_at = ?3 WHERE id = ?1",
                params![isnad_id, serde_json::to_string(&ov).unwrap_or_default(), now()],
            )
            .map_err(dberr)?;
            Ok(Op::Retag { isnad_id: *isnad_id, tok: *tok, class: prev })
        }
        Op::Link { transmitter_id, person_id } => {
            let t = transmitter_of(conn, *transmitter_id)?;
            read_person(conn, *person_id)?;
            conn.execute("UPDATE transmitter SET person_id = ?2 WHERE id = ?1", params![transmitter_id, person_id]).map_err(dberr)?;
            add_form(conn, *person_id, &t.raw, "user")?;
            conn.execute("UPDATE person SET updated_at = ?2 WHERE id = ?1", params![person_id, now()]).map_err(dberr)?;
            Ok(match t.person_id {
                Some(prev) => Op::Link { transmitter_id: *transmitter_id, person_id: prev },
                None => Op::Unlink { transmitter_id: *transmitter_id },
            })
        }
        Op::Unlink { transmitter_id } => {
            let t = transmitter_of(conn, *transmitter_id)?;
            let prev = t.person_id.ok_or_else(|| LabError::Other("transmitter is not linked".into()))?;
            conn.execute("UPDATE transmitter SET person_id = NULL WHERE id = ?1", [transmitter_id]).map_err(dberr)?;
            Ok(Op::Link { transmitter_id: *transmitter_id, person_id: prev })
        }
        Op::LinkNew { transmitter_id, canonical_name } => {
            let t = transmitter_of(conn, *transmitter_id)?;
            let name = canonical_name.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| t.raw.clone());
            let ts = now();
            conn.execute("INSERT INTO person (canonical_name, created_at, updated_at) VALUES (?1, ?2, ?2)", params![name, ts]).map_err(dberr)?;
            let pid = conn.last_insert_rowid();
            conn.execute("UPDATE transmitter SET person_id = ?2 WHERE id = ?1", params![transmitter_id, pid]).map_err(dberr)?;
            add_form(conn, pid, &t.raw, "user")?;
            Ok(Op::DeletePerson { person_id: pid })
        }
        Op::DeletePerson { person_id } => {
            let p = read_person(conn, *person_id)?;
            let mut stmt = conn.prepare("SELECT id FROM transmitter WHERE person_id = ?1").map_err(dberr)?;
            let tids: Vec<i64> = stmt.query_map([person_id], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
            conn.execute("UPDATE transmitter SET person_id = NULL WHERE person_id = ?1", [person_id]).map_err(dberr)?;
            conn.execute("DELETE FROM person WHERE id = ?1", [person_id]).map_err(dberr)?;
            Ok(Op::RestorePerson { person: p, transmitter_ids: tids })
        }
        Op::RestorePerson { person, transmitter_ids } => {
            conn.execute(
                "INSERT INTO person (id, canonical_name, death_ah, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![person.id, person.canonical_name, person.death_ah, person.notes, person.created_at, now()],
            )
            .map_err(dberr)?;
            for f in &person.forms {
                conn.execute(
                    "INSERT OR IGNORE INTO name_form (person_id, form, form_norm, source) VALUES (?1, ?2, ?3, ?4)",
                    params![person.id, f.form, f.form_norm, f.source],
                )
                .map_err(dberr)?;
            }
            for t in transmitter_ids {
                conn.execute("UPDATE transmitter SET person_id = ?2 WHERE id = ?1", params![t, person.id]).map_err(dberr)?;
            }
            Ok(Op::DeletePerson { person_id: person.id })
        }
        Op::MergePersons { into, from } => {
            if into == from {
                return Err(LabError::Other("cannot merge a person into itself".into()));
            }
            let src = read_person(conn, *from)?;
            read_person(conn, *into)?;
            let mut stmt = conn.prepare("SELECT id FROM transmitter WHERE person_id = ?1").map_err(dberr)?;
            let moved: Vec<i64> = stmt.query_map([from], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
            conn.execute("UPDATE transmitter SET person_id = ?2 WHERE person_id = ?1", params![from, into]).map_err(dberr)?;
            for f in &src.forms {
                conn.execute(
                    "INSERT OR IGNORE INTO name_form (person_id, form, form_norm, source) VALUES (?1, ?2, ?3, ?4)",
                    params![into, f.form, f.form_norm, f.source],
                )
                .map_err(dberr)?;
            }
            conn.execute("DELETE FROM person WHERE id = ?1", [from]).map_err(dberr)?;
            conn.execute("UPDATE person SET updated_at = ?2 WHERE id = ?1", params![into, now()]).map_err(dberr)?;
            // Undo: recreate `from` with its forms and take its transmitters back.
            Ok(Op::Batch {
                ops: vec![
                    Op::RestorePerson { person: src.clone(), transmitter_ids: moved },
                    // Forms that only `from` had must leave `into` again.
                    Op::Batch { ops: src.forms.iter().map(|f| Op::SplitFormOff { person_id: *into, form_norm: f.form_norm.clone() }).collect() },
                ],
            })
        }
        Op::SplitFormOff { person_id, form_norm } => {
            conn.execute("DELETE FROM name_form WHERE person_id = ?1 AND form_norm = ?2", params![person_id, form_norm]).map_err(dberr)?;
            Ok(Op::Batch { ops: vec![] })
        }
        Op::SplitPerson { person_id, transmitter_ids, canonical_name } => {
            read_person(conn, *person_id)?;
            let ts = now();
            conn.execute("INSERT INTO person (canonical_name, created_at, updated_at) VALUES (?1, ?2, ?2)", params![canonical_name, ts]).map_err(dberr)?;
            let new_id = conn.last_insert_rowid();
            for t in transmitter_ids {
                let row = transmitter_of(conn, *t)?;
                if row.person_id != Some(*person_id) {
                    return Err(LabError::Other(format!("transmitter {} is not linked to person {}", t, person_id)));
                }
                conn.execute("UPDATE transmitter SET person_id = ?2 WHERE id = ?1", params![t, new_id]).map_err(dberr)?;
                add_form(conn, new_id, &row.raw, "user")?;
            }
            Ok(Op::MergePersons { into: *person_id, from: new_id })
        }
        Op::RenamePerson { person_id, canonical_name } => {
            let prev: String = conn.query_row("SELECT canonical_name FROM person WHERE id = ?1", [person_id], |r| r.get(0)).map_err(dberr)?;
            conn.execute("UPDATE person SET canonical_name = ?2, updated_at = ?3 WHERE id = ?1", params![person_id, canonical_name, now()]).map_err(dberr)?;
            Ok(Op::RenamePerson { person_id: *person_id, canonical_name: prev })
        }
        Op::SetDeath { person_id, death_ah } => {
            let prev: Option<i64> = conn.query_row("SELECT death_ah FROM person WHERE id = ?1", [person_id], |r| r.get(0)).map_err(dberr)?;
            conn.execute("UPDATE person SET death_ah = ?2, updated_at = ?3 WHERE id = ?1", params![person_id, death_ah, now()]).map_err(dberr)?;
            Ok(Op::SetDeath { person_id: *person_id, death_ah: prev })
        }
        Op::SetNotes { person_id, notes } => {
            let prev: Option<String> = conn.query_row("SELECT notes FROM person WHERE id = ?1", [person_id], |r| r.get(0)).map_err(dberr)?;
            conn.execute("UPDATE person SET notes = ?2, updated_at = ?3 WHERE id = ?1", params![person_id, notes, now()]).map_err(dberr)?;
            Ok(Op::SetNotes { person_id: *person_id, notes: prev })
        }
        Op::AddManual { book_id, part_index, page_id, tok_start, tok_end } => {
            let page = h.source.page(*book_id, *part_index, *page_id)?.ok_or_else(|| LabError::NotFound("page".into()))?;
            if *tok_end <= *tok_start || *tok_end > page.tokens.len() {
                return Err(LabError::Other("the range is empty or beyond the page".into()));
            }
            let lex = lexicon::load(conn).map_err(dberr)?;
            let c = manual_candidate(&page, &lex, *tok_start, *tok_end);
            let id = insert_candidate(conn, h.source.corpus_version(), &[&page], &c, &lex.hash, &HashMap::new())?;
            conn.execute("UPDATE isnad SET status = 'confirmed' WHERE id = ?1", [id]).map_err(dberr)?;
            Ok(Op::DeleteIsnad { isnad_id: id })
        }
        Op::DeleteIsnad { isnad_id } => {
            let row = read_isnad(conn, *isnad_id)?;
            let (snapshot, snapshot_hash, corpus_version, extractor_version, lexicon_hash): (String, String, String, String, String) = conn
                .query_row("SELECT snapshot, snapshot_hash, corpus_version, extractor_version, lexicon_hash FROM isnad WHERE id = ?1", [isnad_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(dberr)?;
            conn.execute("DELETE FROM isnad WHERE id = ?1", [isnad_id]).map_err(dberr)?;
            Ok(Op::RestoreIsnad { row, snapshot, snapshot_hash, corpus_version, extractor_version, lexicon_hash })
        }
        Op::RestoreIsnad { row, snapshot, snapshot_hash, corpus_version, extractor_version, lexicon_hash } => {
            conn.execute(
                "INSERT INTO isnad (id, corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 kind, matn_tok_start, matn_tok_end, links, confidence, confidence_json, status, created_at, updated_at, \
                 extractor_version, lexicon_hash, overrides_json, end_part_index, end_page_id, matn_end_part_index, matn_end_page_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
                params![
                    row.id, corpus_version, row.book_id as i64, row.part_index as i64, row.page_id as i64, row.tok_start as i64, row.tok_end as i64,
                    snapshot, snapshot_hash, row.kind, row.matn_tok_start.map(|v| v as i64), row.matn_tok_end.map(|v| v as i64), row.links,
                    row.confidence, row.confidence_json, row.status, row.created_at, now(), extractor_version, lexicon_hash,
                    serde_json::to_string(&row.overrides).unwrap_or_default(),
                    row.end_part_index.map(|v| v as i64), row.end_page_id.map(|v| v as i64), row.matn_end_part_index.map(|v| v as i64), row.matn_end_page_id.map(|v| v as i64)
                ],
            )
            .map_err(dberr)?;
            for t in &row.transmitters {
                conn.execute(
                    "INSERT INTO transmitter (id, isnad_id, position, tok_start, tok_end, raw, kunya, ism, nasab, nisba, laqab, verb_before, person_id, part_index, page_id, place) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![t.id, row.id, t.position, t.tok_start as i64, t.tok_end as i64, t.raw, t.kunya, t.ism, t.nasab, t.nisba, t.laqab, t.verb_before, t.person_id, t.part_index.map(|v| v as i64), t.page_id.map(|v| v as i64), t.place],
                )
                .map_err(dberr)?;
            }
            Ok(Op::DeleteIsnad { isnad_id: row.id })
        }
        Op::RestoreTransmitter { row } => {
            conn.execute(
                "INSERT INTO transmitter (id, isnad_id, position, tok_start, tok_end, raw, kunya, ism, nasab, nisba, laqab, verb_before, person_id, part_index, page_id, place) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![row.id, row.isnad_id, row.position, row.tok_start as i64, row.tok_end as i64, row.raw, row.kunya, row.ism, row.nasab, row.nisba, row.laqab, row.verb_before, row.person_id, row.part_index.map(|v| v as i64), row.page_id.map(|v| v as i64), row.place],
            )
            .map_err(dberr)?;
            Ok(Op::Batch { ops: vec![] })
        }
        Op::Batch { ops } => {
            // Inverses in reverse order, as an undo of the whole step.
            let mut inv = Vec::with_capacity(ops.len());
            for o in ops {
                inv.push(apply_inner(conn, h, o)?);
            }
            inv.reverse();
            Ok(Op::Batch { ops: inv })
        }
    }
}

/// A user-marked range as a candidate: transmitters are the introduced name
/// spans the classifier finds inside it; links, confidence and matn follow.
fn manual_candidate(page: &Page, lex: &lexicon::Lexicon, start: usize, end: usize) -> Candidate {
    let views: Vec<isnad::View> = page.tokens.iter().map(isnad::View::of).collect();
    let (classes, _, _) = isnad::classify(&views, lex, &Params::default(), &HashMap::new(), &[]);
    let mut transmitters = Vec::new();
    let mut cur: Option<usize> = None;
    let mut last_verb: Option<String> = None;
    let flush = |cur: &mut Option<usize>, at: usize, transmitters: &mut Vec<isnad::TransmitterSpan>, verb: &Option<String>| {
        if let Some(a) = cur.take() {
            if at > a {
                transmitters.push(isnad::TransmitterSpan {
                    position: transmitters.len(),
                    tok_start: a,
                    tok_end: at,
                    raw: views[a..at].iter().map(|v| v.surface.clone()).collect::<Vec<_>>().join(" "),
                    parts: names::parse(&views[a..at].iter().map(|v| v.norm.clone()).collect::<Vec<_>>()),
                    place: None,
                    verb_before: verb.clone(),
                });
            }
        }
    };
    for x in start..end {
        match classes[x] {
            Class::Name | Class::Connect if views[x].norm != "عن" => {
                if cur.is_none() {
                    cur = Some(x);
                }
            }
            Class::Verb => {
                flush(&mut cur, x, &mut transmitters, &last_verb);
                last_verb = Some(views[x].norm.clone());
            }
            Class::Connect => {
                flush(&mut cur, x, &mut transmitters, &last_verb);
                last_verb = Some("عن".into());
            }
            Class::Formula => {}
            _ => flush(&mut cur, x, &mut transmitters, &last_verb),
        }
    }
    flush(&mut cur, end, &mut transmitters, &last_verb);
    let links = transmitters.len();
    Candidate {
        tok_start: start,
        tok_end: end,
        kind: isnad::Kind::Isnad,
        group: lexicon::Group::Core,
        links,
        matn: None,
        transmitters,
        confidence: isnad::confidence(links, 0.0, false, 1.0),
        classes: (start..end).map(|x| (x, classes[x])).collect(),
    }
}

#[tauri::command]
pub async fn isnad_apply(state: State<'_, ManagedLabState>, op: Op) -> Result<Applied, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || apply(&db(&h)?, &h, &op)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// -------------------------------------------------------- transmitters ---

#[derive(Debug, Clone, Serialize)]
pub struct TransmitterListRow {
    #[serde(flatten)]
    pub row: TransmitterRow,
    pub part_index: u32,
    pub page_id: u64,
    pub isnad_status: String,
    /// How many transmitter rows in this book share the form.
    pub form_count: i64,
    pub person_name: Option<String>,
    pub suggested_person_name: Option<String>,
}

/// The right pane (§7.4): every transmitter of the book (or of confirmed
/// isnāds only), with counts per form and suggestions.
#[tauri::command]
pub async fn transmitters_list(state: State<'_, ManagedLabState>, book_id: u64, confirmed_only: bool) -> Result<Vec<TransmitterListRow>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id, i.id, COALESCE(t.part_index, i.part_index), COALESCE(t.page_id, i.page_id), i.status FROM transmitter t JOIN isnad i ON i.id = t.isnad_id \
                 WHERE i.book_id = ?1 AND (?2 = 0 OR i.status = 'confirmed') AND i.status != 'rejected' \
                 ORDER BY i.part_index, i.page_id, t.tok_start",
            )
            .map_err(dberr)?;
        let heads: Vec<(i64, i64, i64, i64, String)> = stmt
            .query_map(params![book_id as i64, confirmed_only as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(dberr)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr)?;
        let mut cache: HashMap<i64, Vec<TransmitterRow>> = HashMap::new();
        let mut out = Vec::with_capacity(heads.len());
        let mut counts: HashMap<String, i64> = HashMap::new();
        for (tid, iid, part, page, status) in &heads {
            let rows = match cache.get(iid) {
                Some(r) => r,
                None => {
                    let mut r = read_transmitters(&conn, *iid)?;
                    suggest(&conn, &mut r)?;
                    cache.insert(*iid, r);
                    &cache[iid]
                }
            };
            if let Some(t) = rows.iter().find(|t| t.id == *tid) {
                *counts.entry(t.form_norm.clone()).or_insert(0) += 1;
                out.push(TransmitterListRow {
                    row: t.clone(),
                    part_index: *part as u32,
                    page_id: *page as u64,
                    isnad_status: status.clone(),
                    form_count: 0,
                    person_name: None,
                    suggested_person_name: None,
                });
            }
        }
        let mut name_stmt = conn.prepare("SELECT canonical_name FROM person WHERE id = ?1").map_err(dberr)?;
        for r in out.iter_mut() {
            r.form_count = counts.get(&r.row.form_norm).copied().unwrap_or(0);
            if let Some(p) = r.row.person_id {
                r.person_name = name_stmt.query_row([p], |x| x.get(0)).optional().map_err(dberr)?;
            }
            if let Some(p) = r.row.suggested_person_id {
                r.suggested_person_name = name_stmt.query_row([p], |x| x.get(0)).optional().map_err(dberr)?;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[tauri::command]
pub async fn persons_list(state: State<'_, ManagedLabState>) -> Result<Vec<PersonRow>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn.prepare("SELECT id FROM person ORDER BY canonical_name").map_err(dberr)?;
        let ids: Vec<i64> = stmt.query_map([], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
        ids.into_iter().map(|id| read_person(&conn, id)).collect()
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

/// The ops that would accept every suggestion on one page, as one batch the
/// caller applies (so it is reviewable first and one undo step after).
#[tauri::command]
pub async fn suggestions_for_page(state: State<'_, ManagedLabState>, book_id: u64, part_index: u32, page_id: u64) -> Result<Vec<Op>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn.prepare("SELECT id FROM isnad WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 AND status != 'rejected'").map_err(dberr)?;
        let ids: Vec<i64> = stmt.query_map(params![book_id as i64, part_index as i64, page_id as i64], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
        let mut ops = Vec::new();
        for id in ids {
            let mut rows = read_transmitters(&conn, id)?;
            suggest(&conn, &mut rows)?;
            for t in rows {
                if let (None, Some(p)) = (t.person_id, t.suggested_person_id) {
                    ops.push(Op::Link { transmitter_id: t.id, person_id: p });
                }
            }
        }
        Ok(ops)
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// ---------------------------------------------------------------- retags ---

/// How often each (token, class) retag has been made in this book, for the
/// "add to lexicon" offer at three (§7.4).
#[tauri::command]
pub async fn retag_counts(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<(String, Class, i64)>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn.prepare("SELECT id, overrides_json FROM isnad WHERE book_id = ?1 AND overrides_json != '{}'").map_err(dberr)?;
        let rows: Vec<(i64, String)> = stmt.query_map([book_id as i64], |r| Ok((r.get(0)?, r.get(1)?))).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
        let mut counts: HashMap<(String, Class), i64> = HashMap::new();
        for (id, json) in rows {
            let ov: HashMap<usize, Class> = serde_json::from_str(&json).unwrap_or_default();
            if ov.is_empty() {
                continue;
            }
            let row = read_isnad(&conn, id)?;
            let tokens = stream_tokens(&span_window(&h, &row)?);
            for (tok, class) in ov {
                if let Some(t) = tokens.get(tok) {
                    *counts.entry((normalize_arabic(&t.surface), class)).or_insert(0) += 1;
                }
            }
        }
        let mut v: Vec<(String, Class, i64)> = counts.into_iter().map(|((w, c), n)| (w, c, n)).collect();
        v.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        Ok(v)
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// --------------------------------------------------------------- lexicon ---

#[tauri::command]
pub async fn lexicon_list(state: State<'_, ManagedLabState>, kind: Option<String>) -> Result<Vec<lexicon::Entry>, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || lexicon::list(&db(&h)?, kind.as_deref()).map_err(dberr)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[tauri::command]
pub async fn lexicon_add(state: State<'_, ManagedLabState>, kind: String, grp: Option<String>, tokens: Vec<String>) -> Result<i64, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || lexicon::add_user_entry(&db(&h)?, &kind, grp.as_deref(), &tokens).map_err(dberr)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[tauri::command]
pub async fn lexicon_set_enabled(state: State<'_, ManagedLabState>, id: i64, enabled: bool) -> Result<(), LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || lexicon::set_enabled(&db(&h)?, id, enabled).map_err(dberr)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[tauri::command]
pub async fn lexicon_delete(state: State<'_, ManagedLabState>, id: i64) -> Result<bool, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || lexicon::delete_user_entry(&db(&h)?, id).map_err(dberr)).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

// ---------------------------------------------------------------- export ---

fn csv_cell(s: &str) -> String {
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn csv(rows: Vec<Vec<String>>) -> String {
    let mut out = String::from("\u{FEFF}");
    for r in rows {
        out.push_str(&r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

/// Isnāds of a book (§6.6): `flat` is one row per transmitter, `nested` is
/// JSON with transmitters inside each isnād; CSV or JSON.
#[tauri::command]
pub async fn isnad_export(state: State<'_, ManagedLabState>, book_id: u64, format: String, shape: String, status: Option<String>) -> Result<String, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn.prepare("SELECT id FROM isnad WHERE book_id = ?1 AND (?2 IS NULL OR status = ?2) ORDER BY part_index, page_id, tok_start").map_err(dberr)?;
        let ids: Vec<i64> = stmt.query_map(params![book_id as i64, status], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
        let rows: Vec<IsnadRow> = ids.into_iter().map(|id| read_isnad(&conn, id)).collect::<Result<_, _>>()?;
        let mut names: HashMap<i64, String> = HashMap::new();
        let mut name_stmt = conn.prepare("SELECT id, canonical_name FROM person").map_err(dberr)?;
        for r in name_stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(dberr)? {
            let (id, n) = r.map_err(dberr)?;
            names.insert(id, n);
        }
        Ok(match (format.as_str(), shape.as_str()) {
            ("json", "nested") => serde_json::to_string_pretty(&rows).unwrap_or_default(),
            ("json", _) => {
                let names = &names;
                let flat: Vec<serde_json::Value> = rows
                    .iter()
                    .flat_map(|i| {
                        i.transmitters.iter().map(move |t| {
                            serde_json::json!({
                                "isnad_id": i.id, "book_id": i.book_id, "part_index": i.part_index, "page_id": i.page_id,
                                "end_part_index": i.end_part_index, "end_page_id": i.end_page_id,
                                "isnad_tok_start": i.tok_start, "isnad_tok_end": i.tok_end, "kind": i.kind, "status": i.status,
                                "confidence": i.confidence, "links": i.links, "matn_tok_start": i.matn_tok_start, "matn_tok_end": i.matn_tok_end,
                                "position": t.position, "tok_start": t.tok_start, "tok_end": t.tok_end, "raw": t.raw,
                                "kunya": t.kunya, "ism": t.ism, "nasab": t.nasab, "nisba": t.nisba, "laqab": t.laqab,
                                "verb_before": t.verb_before, "place": t.place, "transmitter_part_index": t.part_index, "transmitter_page_id": t.page_id,
                                "person_id": t.person_id, "person": t.person_id.and_then(|p| names.get(&p).cloned()),
                            })
                        })
                    })
                    .collect();
                serde_json::to_string_pretty(&flat).unwrap_or_default()
            }
            (_, "nested") => {
                let mut out = vec![vec!["isnad_id", "book_id", "part_index", "page_id", "end_part_index", "end_page_id", "tok_start", "tok_end", "kind", "status", "confidence", "links", "matn_tok_start", "matn_tok_end", "chain"].into_iter().map(String::from).collect::<Vec<_>>()];
                for i in &rows {
                    let chain = i.transmitters.iter().map(|t| format!("[{}] {}{}", t.verb_before.clone().unwrap_or_default(), t.raw, t.place.as_ref().map(|p| format!(" ({})", p)).unwrap_or_default())).collect::<Vec<_>>().join(" → ");
                    out.push(vec![
                        i.id.to_string(), i.book_id.to_string(), i.part_index.to_string(), i.page_id.to_string(),
                        i.end_part_index.map(|v| v.to_string()).unwrap_or_default(), i.end_page_id.map(|v| v.to_string()).unwrap_or_default(),
                        i.tok_start.to_string(), i.tok_end.to_string(),
                        i.kind.clone(), i.status.clone(), format!("{:.3}", i.confidence), i.links.to_string(),
                        i.matn_tok_start.map(|v| v.to_string()).unwrap_or_default(), i.matn_tok_end.map(|v| v.to_string()).unwrap_or_default(), chain,
                    ]);
                }
                csv(out)
            }
            _ => {
                let mut out = vec![vec!["isnad_id", "book_id", "part_index", "page_id", "end_part_index", "end_page_id", "isnad_tok_start", "isnad_tok_end", "kind", "status", "confidence", "links", "position", "transmitter_part_index", "transmitter_page_id", "tok_start", "tok_end", "raw", "place", "kunya", "ism", "nasab", "nisba", "laqab", "verb_before", "person_id", "person"].into_iter().map(String::from).collect::<Vec<_>>()];
                for i in &rows {
                    for t in &i.transmitters {
                        out.push(vec![
                            i.id.to_string(), i.book_id.to_string(), i.part_index.to_string(), i.page_id.to_string(),
                            i.end_part_index.map(|v| v.to_string()).unwrap_or_default(), i.end_page_id.map(|v| v.to_string()).unwrap_or_default(),
                            i.tok_start.to_string(), i.tok_end.to_string(),
                            i.kind.clone(), i.status.clone(), format!("{:.3}", i.confidence), i.links.to_string(), t.position.to_string(),
                            t.part_index.map(|v| v.to_string()).unwrap_or_default(), t.page_id.map(|v| v.to_string()).unwrap_or_default(),
                            t.tok_start.to_string(), t.tok_end.to_string(),
                            t.raw.clone(), t.place.clone().unwrap_or_default(), t.kunya.clone().unwrap_or_default(), t.ism.clone().unwrap_or_default(), t.nasab.clone().unwrap_or_default(),
                            t.nisba.clone().unwrap_or_default(), t.laqab.clone().unwrap_or_default(), t.verb_before.clone().unwrap_or_default(),
                            t.person_id.map(|p| p.to_string()).unwrap_or_default(), t.person_id.and_then(|p| names.get(&p).cloned()).unwrap_or_default(),
                        ]);
                    }
                }
                csv(out)
            }
        })
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

/// The authority file (§6.3, §6.6): persons with their forms and link counts.
#[tauri::command]
pub async fn authority_export(state: State<'_, ManagedLabState>, format: String) -> Result<String, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn.prepare("SELECT id FROM person ORDER BY canonical_name").map_err(dberr)?;
        let ids: Vec<i64> = stmt.query_map([], |r| r.get(0)).map_err(dberr)?.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
        let persons: Vec<PersonRow> = ids.into_iter().map(|id| read_person(&conn, id)).collect::<Result<_, _>>()?;
        Ok(if format == "json" {
            serde_json::to_string_pretty(&persons).unwrap_or_default()
        } else {
            let mut out = vec![vec!["person_id", "canonical_name", "death_ah", "notes", "linked_transmitters", "form", "form_norm", "form_source"].into_iter().map(String::from).collect::<Vec<_>>()];
            for p in &persons {
                if p.forms.is_empty() {
                    out.push(vec![p.id.to_string(), p.canonical_name.clone(), p.death_ah.map(|d| d.to_string()).unwrap_or_default(), p.notes.clone().unwrap_or_default(), p.linked.to_string(), String::new(), String::new(), String::new()]);
                }
                for f in &p.forms {
                    out.push(vec![p.id.to_string(), p.canonical_name.clone(), p.death_ah.map(|d| d.to_string()).unwrap_or_default(), p.notes.clone().unwrap_or_default(), p.linked.to_string(), f.form.clone(), f.form_norm.clone(), f.source.clone()]);
                }
            }
            csv(out)
        })
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::page as fixture_page;
    use crate::source::{BookMetadata, BookSource, CandidateQuery, FreqLayer, FreqTable, PageRef};
    use std::sync::Arc;

    /// An in-memory source with one page, so the ops can be tested without a corpus.
    struct Fake(Vec<Page>);
    impl BookSource for Fake {
        fn corpus_version(&self) -> &str { "test" }
        fn books(&self) -> anyhow::Result<Vec<BookMetadata>> { Ok(vec![]) }
        fn book(&self, _: u64) -> anyhow::Result<Option<BookMetadata>> { Ok(None) }
        fn page_refs(&self, id: u64) -> anyhow::Result<Vec<PageRef>> { Ok(self.0.iter().filter(|p| p.book_id == id).map(|p| PageRef { book_id: p.book_id, part_index: p.part_index, page_id: p.page_id }).collect()) }
        fn book_pages(&self, id: u64, _: &dyn Fn(u64, u64)) -> anyhow::Result<Vec<Page>> { Ok(self.0.iter().filter(|p| p.book_id == id).cloned().collect()) }
        fn page(&self, id: u64, part: u32, page: u64) -> anyhow::Result<Option<Page>> { Ok(self.0.iter().find(|p| p.book_id == id && p.part_index == part && p.page_id == page).cloned()) }
        fn freq_table(&self, _: FreqLayer) -> anyhow::Result<Arc<FreqTable>> { anyhow::bail!("none") }
        fn find_pages(&self, _: &CandidateQuery) -> anyhow::Result<crate::source::Hits> { Ok(crate::source::Hits::default()) }
    }
    fn setup() -> (Handles, Connection, Page) {
        let dir = std::env::temp_dir().join(format!("kashshaf-lab-isnad-ops-{}-{}", std::process::id(), rand_suffix()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(crate::store::Store::open(&dir).unwrap());
        let page = fixture_page(1, 0, 1, "حدثنا ابو داود قال نا محمد بن سعيد قال سمعت عليا يقول الحمد لله",
            "حدثنا|حدث| ابو|ابو| داود|داود| قال|قول| نا|نا| محمد|محمد| بن|بن| سعيد|سعيد| قال|قول| سمعت|سمع| عليا|علي| يقول|قول| الحمد|حمد| لله|الله|");
        let mut page = page;
        for (i, t) in page.tokens.iter_mut().enumerate() {
            t.pos = if [0, 3, 4, 8, 9, 11].contains(&i) { "verb".into() } else { "noun".into() };
        }
        let h = Handles {
            source: Arc::new(Fake(vec![page.clone()])),
            loaded: Arc::new(std::sync::Mutex::new(None)),
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            store: Some(Arc::clone(&store)), quran: Arc::new(std::sync::OnceLock::new()) };
        let conn = store.connect().unwrap();
        (h, conn, page)
    }

    fn rand_suffix() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
    }

    fn extract_into(h: &Handles, conn: &Connection, page: &Page) -> i64 {
        let lex = lexicon::load(conn).unwrap();
        let c = isnad::extract_page(&page.tokens, &page.body, &lex, &Params::default(), &HashMap::new());
        assert_eq!(c.len(), 1, "{:?}", c.iter().map(|x| x.links).collect::<Vec<_>>());
        insert_candidate(conn, h.source.corpus_version(), &[page], &c[0], &lex.hash, &HashMap::new()).unwrap()
    }

    #[test]
    fn a_candidate_round_trips_with_its_transmitters_and_snapshot() {
        let (h, conn, page) = setup();
        let id = extract_into(&h, &conn, &page);
        let row = read_isnad(&conn, id).unwrap();
        assert_eq!(row.status, "candidate");
        assert_eq!(row.links, 3);
        assert_eq!(row.transmitters.iter().map(|t| t.raw.as_str()).collect::<Vec<_>>(), vec!["ابو داود", "محمد بن سعيد", "عليا"]);
        assert_eq!(row.transmitters[1].form_norm, "محمد بن سعيد");
        assert_eq!(row.transmitters[1].nasab.as_deref(), Some("بن سعيد"));
        let (snap, hash): (String, String) = conn.query_row("SELECT snapshot, snapshot_hash FROM isnad WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(snap.starts_with("حدثنا ابو داود"));
        assert_eq!(hash.len(), 40);
    }

    #[test]
    fn every_op_returns_an_inverse_that_restores_the_state_and_is_logged() {
        let (h, conn, page) = setup();
        let id = extract_into(&h, &conn, &page);

        // Confirm, then undo.
        let a = apply(&conn, &h, &Op::SetStatus { isnad_id: id, status: "confirmed".into() }).unwrap();
        assert_eq!(read_isnad(&conn, id).unwrap().status, "confirmed");
        apply(&conn, &h, &a.inverse).unwrap();
        assert_eq!(read_isnad(&conn, id).unwrap().status, "candidate");

        // Move the matn boundary and back.
        let before = read_isnad(&conn, id).unwrap();
        let a = apply(&conn, &h, &Op::SetMatn { isnad_id: id, start: Some(10), end: Some(14) }).unwrap();
        let mid = read_isnad(&conn, id).unwrap();
        assert_eq!((mid.matn_tok_start, mid.tok_end), (Some(10), 10), "the chain ends where the matn begins");
        apply(&conn, &h, &a.inverse).unwrap();
        assert_eq!(read_isnad(&conn, id).unwrap().matn_tok_start, before.matn_tok_start);

        // Split محمد بن سعيد at بن, then the inverse merges it back.
        let t1 = before.transmitters[1].id;
        let a = apply(&conn, &h, &Op::SplitTransmitter { transmitter_id: t1, at: 6 }).unwrap();
        let split = read_isnad(&conn, id).unwrap();
        assert_eq!(split.links, 4);
        assert_eq!(split.transmitters.iter().map(|t| t.raw.as_str()).collect::<Vec<_>>(), vec!["ابو داود", "محمد", "بن سعيد", "عليا"]);
        assert_eq!(split.transmitters.iter().map(|t| t.position).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        apply(&conn, &h, &a.inverse).unwrap();
        let merged = read_isnad(&conn, id).unwrap();
        assert_eq!(merged.links, 3);
        assert_eq!(merged.transmitters[1].raw, "محمد بن سعيد");

        // Retag and clear.
        let a = apply(&conn, &h, &Op::Retag { isnad_id: id, tok: 11, class: Some(Class::Verb) }).unwrap();
        assert_eq!(read_isnad(&conn, id).unwrap().overrides.get(&11), Some(&Class::Verb));
        apply(&conn, &h, &a.inverse).unwrap();
        assert!(read_isnad(&conn, id).unwrap().overrides.is_empty());

        let n: i64 = conn.query_row("SELECT COUNT(*) FROM equivalence_log", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 8, "every apply, undo included, is logged");
    }

    #[test]
    fn linking_creates_forms_suggestions_are_shown_not_applied_and_merges_undo() {
        let (h, conn, page) = setup();
        let id = extract_into(&h, &conn, &page);
        let row = read_isnad(&conn, id).unwrap();
        let t_abu = row.transmitters[0].id;

        // Link أبو داود to a new person: a form is added.
        let a = apply(&conn, &h, &Op::LinkNew { transmitter_id: t_abu, canonical_name: Some("أبو داود السجستاني".into()) }).unwrap();
        let pid = match a.inverse { Op::DeletePerson { person_id } => person_id, ref o => panic!("{:?}", o) };
        let p = read_person(&conn, pid).unwrap();
        assert_eq!(p.linked, 1);
        assert_eq!(p.forms.len(), 1);
        assert_eq!(p.forms[0].form_norm, "ابو داود");

        // A second, unlinked occurrence of the same form is *suggested*, not linked.
        let id2 = insert_candidate(&conn, "test", &[&page], &{
            let lex = lexicon::load(&conn).unwrap();
            isnad::extract_page(&page.tokens, &page.body, &lex, &Params::default(), &HashMap::new()).remove(0)
        }, "x", &HashMap::new()).unwrap();
        let row2 = read_isnad(&conn, id2).unwrap();
        assert_eq!(row2.transmitters[0].person_id, None);
        assert_eq!(row2.transmitters[0].suggested_person_id, Some(pid));

        // Accept it, then undo the batch.
        let ops = vec![Op::Link { transmitter_id: row2.transmitters[0].id, person_id: pid }];
        let a = apply(&conn, &h, &Op::Batch { ops }).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().linked, 2);
        apply(&conn, &h, &a.inverse).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().linked, 1);

        // Merge into another person and undo: forms and links come back.
        let a2 = apply(&conn, &h, &Op::LinkNew { transmitter_id: row2.transmitters[1].id, canonical_name: None }).unwrap();
        let pid2 = match a2.inverse { Op::DeletePerson { person_id } => person_id, _ => unreachable!() };
        let m = apply(&conn, &h, &Op::MergePersons { into: pid, from: pid2 }).unwrap();
        assert!(read_person(&conn, pid2).is_err(), "the merged person is gone");
        let merged = read_person(&conn, pid).unwrap();
        assert_eq!(merged.linked, 2);
        assert_eq!(merged.forms.len(), 2);
        apply(&conn, &h, &m.inverse).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().forms.len(), 1, "the other person's form left again");
        assert_eq!(read_person(&conn, pid2).unwrap().linked, 1, "the merged person is back with its transmitter");

        // Rename / death year / notes round-trip.
        let r = apply(&conn, &h, &Op::RenamePerson { person_id: pid, canonical_name: "أبو داود".into() }).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().canonical_name, "أبو داود");
        apply(&conn, &h, &r.inverse).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().canonical_name, "أبو داود السجستاني");
        let d = apply(&conn, &h, &Op::SetDeath { person_id: pid, death_ah: Some(275) }).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().death_ah, Some(275));
        apply(&conn, &h, &d.inverse).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().death_ah, None);

        // Split a transmitter off into a new person, and undo.
        let s = apply(&conn, &h, &Op::SplitPerson { person_id: pid2, transmitter_ids: vec![row2.transmitters[1].id], canonical_name: "آخر".into() }).unwrap();
        assert_eq!(read_person(&conn, pid2).unwrap().linked, 0);
        apply(&conn, &h, &s.inverse).unwrap();
        assert_eq!(read_person(&conn, pid2).unwrap().linked, 1);

        // Delete a person and restore it.
        let del = apply(&conn, &h, &Op::DeletePerson { person_id: pid }).unwrap();
        assert!(read_person(&conn, pid).is_err());
        assert_eq!(read_isnad(&conn, id).unwrap().transmitters[0].person_id, None);
        apply(&conn, &h, &del.inverse).unwrap();
        assert_eq!(read_person(&conn, pid).unwrap().linked, 1);
        assert_eq!(read_isnad(&conn, id).unwrap().transmitters[0].person_id, Some(pid));
    }

    #[test]
    fn a_manual_range_becomes_a_confirmed_isnad_and_can_be_deleted_and_restored() {
        let (h, conn, page) = setup();
        let a = apply(&conn, &h, &Op::AddManual { book_id: 1, part_index: 0, page_id: 1, tok_start: 4, tok_end: 11 }).unwrap();
        let id = match a.inverse { Op::DeleteIsnad { isnad_id } => isnad_id, _ => unreachable!() };
        let row = read_isnad(&conn, id).unwrap();
        assert_eq!(row.status, "confirmed");
        assert_eq!(row.transmitters.iter().map(|t| t.raw.as_str()).collect::<Vec<_>>(), vec!["محمد بن سعيد", "عليا"]);
        let d = apply(&conn, &h, &a.inverse).unwrap();
        assert!(read_isnad(&conn, id).is_err());
        apply(&conn, &h, &d.inverse).unwrap();
        let back = read_isnad(&conn, id).unwrap();
        assert_eq!(back.transmitters.len(), 2);
        assert_eq!(back.status, "confirmed");
        let _ = &page;
    }
}
