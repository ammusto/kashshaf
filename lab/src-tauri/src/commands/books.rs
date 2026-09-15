//! The book browser and the reader (spec §7.1, §7.2).

use crate::error::LabError;
use crate::source::{BookMetadata, Page, PageEntry, PageRef};
use crate::state::{source_of, ManagedLabState};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Every book in the corpus, in the order the browser shows them (by death
/// year, then id — the same order Kashshaf uses).
#[tauri::command]
pub fn list_books(state: State<'_, ManagedLabState>) -> Result<Vec<BookMetadata>, LabError> {
    Ok(source_of(&state)?.books()?)
}

#[tauri::command]
pub fn get_book(state: State<'_, ManagedLabState>, id: u64) -> Result<Option<BookMetadata>, LabError> {
    Ok(source_of(&state)?.book(id)?)
}

/// The page coordinates of one book in reading order. The reader keeps this
/// list and moves through it; it is the cheap half of the book (no bodies, no
/// tokens), so opening a book stays inside the §8 budget.
#[tauri::command]
pub fn list_page_refs(state: State<'_, ManagedLabState>, id: u64) -> Result<Vec<PageRef>, LabError> {
    Ok(source_of(&state)?.page_refs(id)?)
}

/// The page list with the printed numbers every page label is built from
/// (spec 1.5 C1). The reader keeps this and moves through it.
#[tauri::command]
pub fn list_pages(state: State<'_, ManagedLabState>, id: u64) -> Result<Vec<PageEntry>, LabError> {
    Ok(source_of(&state)?.page_entries(id)?)
}

/// A run's scope as page coordinates, `end` exclusive and absent at the end
/// of the book (spec 1.5 G, H3). The frontend resolves a section or a range
/// of printed page numbers into these.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PageSpan {
    pub start: (u32, u64),
    pub end: Option<(u32, u64)>,
}

impl PageSpan {
    pub fn contains(&self, part_index: u32, page_id: u64) -> bool {
        let at = (part_index, page_id);
        at >= self.start && self.end.map(|e| at < e).unwrap_or(true)
    }
}

/// What a run is about to read (spec 1.5 F4): pages, and tokens estimated
/// from the book's own totals. Shown before anything heavy starts.
#[derive(Debug, Clone, Serialize)]
pub struct RunSize {
    pub book_id: u64,
    pub pages: usize,
    pub book_pages: usize,
    /// Estimated, not counted: the book's token total scaled by the share of
    /// its pages in scope. Counting exactly would cost the load it warns about.
    pub tokens: u64,
    pub book_tokens: u64,
}

#[tauri::command]
pub fn run_size(state: State<'_, ManagedLabState>, id: u64, span: Option<PageSpan>) -> Result<RunSize, LabError> {
    let source = source_of(&state)?;
    let refs = source.page_refs(id)?;
    let book_pages = refs.len();
    let pages = match span {
        Some(s) => refs.iter().filter(|r| s.contains(r.part_index, r.page_id)).count(),
        None => book_pages,
    };
    let book_tokens = source.book(id)?.and_then(|b| b.token_count).unwrap_or(0).max(0) as u64;
    let tokens = if book_pages == 0 { 0 } else { book_tokens * pages as u64 / book_pages as u64 };
    Ok(RunSize { book_id: id, pages, book_pages, tokens, book_tokens })
}

/// One page with its tokens: what the reader renders and overlays.
#[tauri::command]
pub fn get_page(
    state: State<'_, ManagedLabState>,
    id: u64,
    part_index: u32,
    page_id: u64,
) -> Result<Option<Page>, LabError> {
    Ok(source_of(&state)?.page(id, part_index, page_id)?)
}

/// What the reader needs to open a book: its metadata, its page list, and the
/// first page, in one round trip.
#[derive(Debug, Serialize, Deserialize)]
pub struct BookOpen {
    pub book: BookMetadata,
    pub pages: Vec<PageRef>,
    pub first: Option<Page>,
}

#[tauri::command]
pub fn open_book(state: State<'_, ManagedLabState>, id: u64) -> Result<BookOpen, LabError> {
    let source = source_of(&state)?;
    let book = source
        .book(id)?
        .ok_or_else(|| LabError::NotFound(format!("book {}", id)))?;
    let pages = source.page_refs(id)?;
    let first = match pages.first() {
        Some(r) => source.page(r.book_id, r.part_index, r.page_id)?,
        None => None,
    };
    Ok(BookOpen { book, pages, first })
}
