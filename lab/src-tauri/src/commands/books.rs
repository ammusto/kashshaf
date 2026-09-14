//! The book browser and the reader (spec §7.1, §7.2).

use crate::error::LabError;
use crate::source::{BookMetadata, Page, PageRef};
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
