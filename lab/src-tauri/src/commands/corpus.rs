//! Mode, corpus status, and the offer to download (spec §2.4, §2.5, §7.8).
//!
//! Lab offers the download through the shared `kashshaf-common` downloader, so
//! a corpus fetched here is the one Kashshaf finds next time and vice versa.
//! It never requires it: api mode stays available throughout.

use crate::error::LabError;
use crate::mode::LabStatus;
use crate::state::{LabState, ManagedLabState};
use kashshaf_common::{CorpusStatus, DownloadProgress};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, State};

/// The mode badge's contents (spec §7.1).
#[tauri::command]
pub fn lab_status(state: State<'_, ManagedLabState>) -> Result<LabStatus, LabError> {
    let guard = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    Ok(guard.status.clone())
}

/// Re-run mode detection: after a download, or when the user retries a server
/// that was down. Returns the new status.
#[tauri::command]
pub fn reload_source(state: State<'_, ManagedLabState>) -> Result<LabStatus, LabError> {
    let fresh = LabState::resolve();
    let status = fresh.status.clone();
    let mut guard = state.write().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    *guard = fresh;
    Ok(status)
}

/// Where Lab keeps its own data, and how big `analysis.db` is (spec §2.5).
#[derive(Debug, Serialize, Deserialize)]
pub struct LabDirs {
    pub lab_dir: Option<String>,
    pub analysis_db: Option<String>,
    pub analysis_db_bytes: u64,
    pub schema_version: Option<i64>,
}

#[tauri::command]
pub fn lab_dirs(state: State<'_, ManagedLabState>) -> Result<LabDirs, LabError> {
    let guard = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    let store = guard.store.clone();
    Ok(LabDirs {
        lab_dir: guard.status.lab_dir.clone(),
        analysis_db: store.as_ref().map(|s| s.path().display().to_string()),
        analysis_db_bytes: store
            .as_ref()
            .and_then(|s| std::fs::metadata(s.path()).ok())
            .map(|m| m.len())
            .unwrap_or(0),
        schema_version: store.as_ref().and_then(|s| s.schema_version().ok()),
    })
}

/// The same corpus check Kashshaf runs, against the same directory.
#[tauri::command]
pub async fn check_corpus_status() -> Result<CorpusStatus, LabError> {
    let data_dir =
        kashshaf_common::get_corpus_data_directory().map_err(|e| LabError::Other(e.to_string()))?;
    // `min_app_version` gates Kashshaf's version, not Lab's (spec §2.4): Lab's
    // floor is the oldest corpus this build supports. The engine's schema gate
    // is the other half, applied when LocalSource opens the corpus.
    let floor = kashshaf_common::CompatFloor::MinCorpusVersion(crate::MIN_CORPUS_VERSION);
    Ok(kashshaf_common::check_corpus_status(&data_dir, floor).await)
}

static DOWNLOAD_CANCEL_TX: Mutex<Option<tokio::sync::watch::Sender<bool>>> = Mutex::new(None);

/// Download the corpus into Kashshaf's data directory, emitting
/// `download-progress`. Identical to Kashshaf's flow because it is the same
/// code (spec §2.2).
#[tauri::command]
pub async fn start_corpus_download(
    window: tauri::Window,
    skip_verify: Option<bool>,
) -> Result<(), LabError> {
    let data_dir =
        kashshaf_common::get_corpus_data_directory().map_err(|e| LabError::Other(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| LabError::Other(e.to_string()))?;

    let remote = kashshaf_common::fetch_remote_manifest()
        .await
        .map_err(|e| LabError::Other(e.to_string()))?;
    let local = kashshaf_common::load_local_manifest(&data_dir);

    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<DownloadProgress>(100);
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    *DOWNLOAD_CANCEL_TX.lock().unwrap() = Some(cancel_tx);

    let w = window.clone();
    tokio::spawn(async move {
        while let Some(p) = progress_rx.recv().await {
            let _ = w.emit("download-progress", &p);
        }
    });

    let result = kashshaf_common::download_corpus(
        &data_dir,
        &remote,
        local.as_ref(),
        progress_tx,
        &mut cancel_rx,
        skip_verify.unwrap_or(false),
    )
    .await;

    // Let the forwarder drain the final message before the channel drops.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    *DOWNLOAD_CANCEL_TX.lock().unwrap() = None;

    result.map_err(|e| LabError::Other(e.to_string()))
}

#[tauri::command]
pub fn cancel_corpus_download() -> Result<(), LabError> {
    let guard = DOWNLOAD_CANCEL_TX.lock().unwrap();
    match *guard {
        Some(ref tx) => {
            let _ = tx.send(true);
            Ok(())
        }
        None => Err(LabError::Other("No download in progress".into())),
    }
}

/// Open Lab's own directory in the system file manager (spec §7.8).
#[tauri::command]
pub fn open_lab_directory() -> Result<(), LabError> {
    let dir = kashshaf_common::lab_data_dir().map_err(|e| LabError::Other(e.to_string()))?;
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("explorer").arg(&dir).status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&dir).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(&dir).status();
    match status {
        // explorer.exe returns 1 even when it opens the folder; only a spawn
        // failure is an error.
        Ok(_) => Ok(()),
        Err(e) => Err(LabError::Other(format!("Could not open {}: {}", dir.display(), e))),
    }
}
