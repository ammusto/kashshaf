//! Debug commands (spec §3.3).

use crate::analysis::verify::{verify_alignment as run_verify, AlignmentReport};
use crate::error::LabError;
use crate::state::{source_of, ManagedLabState};
use tauri::{Emitter, State};

/// Check the alignment contract over every page of one book, emitting
/// `verify-progress` as it goes.
///
/// Runs on the blocking pool: a 1,000-page book is a thousand index lookups
/// and the UI must stay responsive.
#[tauri::command]
pub async fn verify_alignment(
    window: tauri::Window,
    state: State<'_, ManagedLabState>,
    book_id: u64,
) -> Result<AlignmentReport, LabError> {
    let source = source_of(&state)?;
    tokio::task::spawn_blocking(move || {
        let progress = |done: u64, total: u64| {
            let _ = window.emit("verify-progress", (book_id, done, total));
        };
        run_verify(source.as_ref(), book_id, &progress).map_err(LabError::from)
    })
    .await
    .map_err(|e| LabError::Other(format!("verify task failed: {}", e)))?
}
