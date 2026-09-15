//! Workspace, table of contents and annotation commands (spec 1.5 §A, §B2, §C4).

use crate::commands::isnad::{db, dberr};
use crate::error::LabError;
use crate::source::{TocNode, TocRow};
use crate::state::{handles, source_of, Handles, ManagedLabState};
use crate::store::now;
use crate::workspace::{self, Entry, ExportReport, ImportReport, Note, Part, WorkspaceState};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LabError> + Send + 'static) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))? }
}

// ------------------------------------------------------------ workspace ---

/// The texts in the workspace, most recently opened first.
#[tauri::command]
pub async fn workspace_list() -> Result<Vec<Entry>, LabError> {
    blocking(workspace::list).await
}

/// What opening a text yields: its saved UI state, and what an import of a
/// folder carried in from elsewhere found.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub state: WorkspaceState,
    pub imported: Option<ImportReport>,
}

/// Add a text to the workspace (spec §A1's button): its folder, its
/// metadata, and everything the database already holds for it.
#[tauri::command]
pub async fn workspace_add(state: State<'_, ManagedLabState>, book_id: u64, author: Option<String>) -> Result<Entry, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let book = h.source.book(book_id)?.ok_or_else(|| LabError::NotFound(format!("book {}", book_id)))?;
        workspace::add(&conn, h.source.as_ref(), &book, author)
    })
    .await
}

/// Delete the folder; the database keeps its rows (spec §A2).
#[tauri::command]
pub async fn workspace_remove(book_id: u64) -> Result<(), LabError> {
    blocking(move || workspace::remove(book_id)).await
}

/// Mark a text as opened, and import anything its folder holds that the
/// database does not (spec §A2: a folder copied from another machine).
#[tauri::command]
pub async fn workspace_open(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Opened, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let ui = workspace::touch(book_id)?;
        let conn = db(&h)?;
        let rep = workspace::import(&conn, h.source.as_ref(), book_id)?;
        if !rep.is_empty() {
            // What was imported belongs in the files too, re-anchored.
            workspace::export(&conn, Some(h.source.as_ref()), book_id, Part::All)?;
        }
        Ok(Opened { state: ui, imported: if rep.is_empty() { None } else { Some(rep) } })
    })
    .await
}

/// Re-export everything for one text — what Ctrl+S does (spec §A2).
#[tauri::command]
pub async fn workspace_export(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Option<ExportReport>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        workspace::export(&conn, Some(h.source.as_ref()), book_id, Part::All)
    })
    .await
}

/// Save a text's per-tab UI state.
#[tauri::command]
pub async fn workspace_save_state(book_id: u64, state: WorkspaceState) -> Result<(), LabError> {
    blocking(move || workspace::save_state(book_id, &state)).await
}

/// Reveal `<lab dir>/workspace` in the file manager (spec §A2, Settings).
#[tauri::command]
pub fn workspace_open_folder() -> Result<String, LabError> {
    let dir = workspace::root().map_err(|e| LabError::Other(e.to_string()))?;
    crate::commands::corpus::reveal(&dir)?;
    Ok(dir.display().to_string())
}

/// Rewrite the files one change touched. Every command that records a
/// decision calls this; it is a no-op for a text not in the workspace.
pub(crate) fn mirror(h: &Handles, book_id: u64, part: Part) {
    let Ok(conn) = db(h) else { return };
    if let Err(e) = workspace::export(&conn, Some(h.source.as_ref()), book_id, part) {
        eprintln!("[lab] workspace export failed for book {}: {}", book_id, e);
    }
}

// ------------------------------------------------------------------ toc ---

/// The book's table of contents as a tree (spec §B2).
#[tauri::command]
pub async fn get_toc(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<TocNode>, LabError> {
    let source = source_of(&state)?;
    blocking(move || Ok(source.toc(book_id)?)).await
}

/// The same entries flat, in reading order — what "which section is this
/// page in" and the section scopes use.
#[tauri::command]
pub async fn get_toc_rows(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<TocRow>, LabError> {
    let source = source_of(&state)?;
    blocking(move || Ok(source.toc_rows(book_id)?)).await
}

/// A section's page range: `[start, end)` as page coordinates, `end` absent
/// at the end of the book (spec §G, §H3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionRange {
    pub id: i64,
    pub title: String,
    pub start: (u32, u64),
    pub end: Option<(u32, u64)>,
}

#[tauri::command]
pub async fn toc_section_range(state: State<'_, ManagedLabState>, book_id: u64, id: i64) -> Result<Option<SectionRange>, LabError> {
    let source = source_of(&state)?;
    blocking(move || {
        let rows = source.toc_rows(book_id)?;
        Ok(kashshaf_engine::toc::section_range(&rows, id).map(|(start, end)| SectionRange {
            id,
            title: rows.iter().find(|r| r.id == id).map(|r| r.title.clone()).unwrap_or_default(),
            start,
            end,
        }))
    })
    .await
}

// ---------------------------------------------------------------- notes ---

#[derive(Debug, Clone, Deserialize)]
pub struct NoteArgs {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub text: String,
}

/// Every note on one book, in reading order.
#[tauri::command]
pub async fn notes_list(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<Note>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        crate::workspace::notes(&conn, book_id)
    })
    .await
}

/// Write a note on a token range (spec §C4). The snapshot is the tokens it
/// covers, so re-anchoring can move it.
#[tauri::command]
pub async fn note_save(state: State<'_, ManagedLabState>, args: NoteArgs) -> Result<Note, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let page = h
            .source
            .page(args.book_id, args.part_index, args.page_id)?
            .ok_or_else(|| LabError::NotFound(format!("page {}:{}", args.part_index, args.page_id)))?;
        let (snapshot, hash) = crate::commands::isnad::snapshot(&page, args.tok_start, args.tok_end);
        let ts = now();
        conn.execute(
            "INSERT INTO note (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
             text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                h.source.corpus_version(),
                args.book_id as i64,
                args.part_index as i64,
                args.page_id as i64,
                args.tok_start as i64,
                args.tok_end as i64,
                snapshot,
                hash,
                args.text,
                ts,
            ],
        )
        .map_err(dberr)?;
        let id = conn.last_insert_rowid();
        mirror(&h, args.book_id, Part::Notes);
        crate::workspace::note(&conn, id)
    })
    .await
}

/// Edit a note's text.
#[tauri::command]
pub async fn note_update(state: State<'_, ManagedLabState>, id: i64, text: String) -> Result<Note, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        conn.execute("UPDATE note SET text = ?2, updated_at = ?3 WHERE id = ?1", params![id, text, now()]).map_err(dberr)?;
        let note = crate::workspace::note(&conn, id)?;
        mirror(&h, note.book_id, Part::Notes);
        Ok(note)
    })
    .await
}

#[tauri::command]
pub async fn note_delete(state: State<'_, ManagedLabState>, id: i64) -> Result<(), LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let book_id: Option<i64> = conn
            .query_row("SELECT book_id FROM note WHERE id = ?1", [id], |r| r.get(0))
            .ok();
        conn.execute("DELETE FROM note WHERE id = ?1", [id]).map_err(dberr)?;
        if let Some(b) = book_id {
            mirror(&h, b as u64, Part::Notes);
        }
        Ok(())
    })
    .await
}
