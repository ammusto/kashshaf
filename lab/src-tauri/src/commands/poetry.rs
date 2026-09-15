//! Poetry commands (Lab spec §4.6, §7 "Poetry (experimental)").
//!
//! A whole-book scan streams per page on `poetry-progress`; the verses are
//! returned to the panel (nothing is stored — §6 has no poetry table and
//! the scan is fast), with page coordinates for the reader layer, and can
//! be exported as CSV.

use crate::analysis::poetry::{self, Verse, EXTRACTOR_VERSION};
use crate::error::LabError;
use crate::state::{handles, ManagedLabState};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, State, Window};

const PROGRESS_EVENT: &str = "poetry-progress";

#[derive(Debug, Clone, Serialize)]
pub struct RunProgress {
    pub done: u64,
    pub total: u64,
    pub found: u64,
}

/// One verse with its page.
#[derive(Debug, Clone, Serialize)]
pub struct VerseRow {
    pub part_index: u32,
    pub page_id: u64,
    #[serde(flatten)]
    pub verse: Verse,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub book_id: u64,
    pub pages: usize,
    pub pages_done: usize,
    pub verses: Vec<VerseRow>,
    pub with_meter: usize,
    pub vowelled: usize,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub extractor_version: &'static str,
}

/// Scan the current book for verses (§4.6).
#[tauri::command]
pub async fn poetry_scan(window: Window, state: State<'_, ManagedLabState>, book_id: u64) -> Result<ScanResult, LabError> {
    let h = handles(&state)?;
    tokio::task::spawn_blocking(move || {
        let book = crate::commands::stats::load_book(&h, Some(&window), book_id)?;
        h.cancel.store(false, Ordering::SeqCst);
        let started = std::time::Instant::now();
        let total = book.pages.len() as u64;
        let mut verses = Vec::new();
        let mut pages_done = 0usize;
        let mut cancelled = false;
        for (i, page) in book.pages.iter().enumerate() {
            if h.should_stop() {
                cancelled = true;
                break;
            }
            for v in poetry::extract_page(&page.body) {
                verses.push(VerseRow { part_index: page.part_index, page_id: page.page_id, verse: v });
            }
            pages_done = i + 1;
            if pages_done % 20 == 0 || pages_done as u64 == total {
                let _ = window.emit(PROGRESS_EVENT, RunProgress { done: pages_done as u64, total, found: verses.len() as u64 });
            }
        }
        let with_meter = verses.iter().filter(|v| !v.verse.meters.is_empty()).count();
        let vowelled = verses.iter().filter(|v| v.verse.vowelled >= poetry::MIN_VOWELLED).count();
        Ok(ScanResult { book_id, pages: book.pages.len(), pages_done, verses, with_meter, vowelled, elapsed_ms: started.elapsed().as_millis() as u64, cancelled, extractor_version: EXTRACTOR_VERSION })
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}

/// Export the verses the panel holds as CSV (the panel sends them back:
/// nothing is stored).
#[tauri::command]
pub fn poetry_export(book_id: u64, rows: Vec<serde_json::Value>) -> Result<String, LabError> {
    let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut out = String::from("part_index,page_id,line,tok_start,tok_end,marker,vowelled,meters,pattern,hemistich_1,hemistich_2\n");
    for r in &rows {
        let g = |k: &str| r.get(k).cloned().unwrap_or(serde_json::Value::Null);
        let s = |k: &str| g(k).as_str().unwrap_or("").to_string();
        let meters = g("meters").as_array().map(|a| a.iter().filter_map(|m| m.as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{:.2},{},{},{},{}\n",
            g("part_index"),
            g("page_id"),
            g("line"),
            g("tok_start"),
            g("tok_end"),
            esc(&s("marker")),
            g("vowelled").as_f64().unwrap_or(0.0),
            esc(&meters),
            esc(&s("pattern")),
            esc(&s("h1_text")),
            esc(&s("h2_text")),
        ));
    }
    crate::commands::stats::save_export(format!("book{}-poetry.csv", book_id), out)
}
