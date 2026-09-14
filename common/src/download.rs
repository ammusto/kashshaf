//! Streaming corpus download with progress, verification and cancellation.
//!
//! Moved verbatim out of the desktop app's `downloader` module (Lab spec §2.2).
//! Lab offers the same download; it never requires it (§2.4).

use crate::data_dir::{has_enough_space, FREE_SPACE_MARGIN};
use crate::manifest::{
    calculate_missing_files, save_local_manifest, verify_file_hash, LocalFile, LocalManifest,
    RemoteManifest,
};
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use tokio::sync::mpsc;

/// Download progress sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    /// Name of current file being downloaded
    pub current_file: String,
    /// Bytes downloaded for current file
    pub file_bytes_downloaded: u64,
    /// Total bytes for current file
    pub file_total_bytes: u64,
    /// Total bytes downloaded across all files
    pub overall_bytes_downloaded: u64,
    /// Total bytes to download
    pub overall_total_bytes: u64,
    /// Number of files completed
    pub files_completed: usize,
    /// Total number of files to download
    pub files_total: usize,
    /// Download state
    pub state: DownloadState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Starting,
    Downloading,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

/// Download a single file with progress updates
async fn download_file_with_progress(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    expected_size: u64,
    progress_tx: &mpsc::Sender<DownloadProgress>,
    current_progress: &mut DownloadProgress,
    cancel_rx: &tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    // Create parent directories
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let response = client
        .get(url)
        .send()
        .await
        .context("Failed to start download")?;

    if !response.status().is_success() {
        return Err(anyhow!("Download failed: HTTP {}", response.status()));
    }

    let mut file = fs::File::create(path)?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        // Check for cancellation during download
        if *cancel_rx.borrow() {
            // Clean up partial file
            drop(file);
            let _ = fs::remove_file(path);
            return Err(anyhow!("Download cancelled"));
        }

        let chunk = chunk.context("Error reading chunk")?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;

        current_progress.file_bytes_downloaded = downloaded;
        current_progress.overall_bytes_downloaded += chunk.len() as u64;

        // Send progress update (ignore send errors - channel might be closed)
        let _ = progress_tx.send(current_progress.clone()).await;
    }

    file.flush()?;

    // Verify size
    let metadata = fs::metadata(path)?;
    if metadata.len() != expected_size {
        return Err(anyhow!(
            "Downloaded file size mismatch: expected {}, got {}",
            expected_size,
            metadata.len()
        ));
    }

    Ok(())
}

/// Download corpus data
pub async fn download_corpus(
    data_dir: &Path,
    remote: &RemoteManifest,
    local: Option<&LocalManifest>,
    progress_tx: mpsc::Sender<DownloadProgress>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    skip_verify: bool,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?;

    // Calculate what needs downloading
    let (missing_files, total_size) = calculate_missing_files(data_dir, remote, local);

    // Refuse up front rather than failing at 90%: the volume must hold the
    // missing files plus a margin.
    let free = fs4::available_space(data_dir).unwrap_or(u64::MAX);
    if !has_enough_space(free, total_size, FREE_SPACE_MARGIN) {
        return Err(anyhow!(
            "Not enough free space in {}: the download needs {:.1} GB plus a {:.0} GB margin, {:.1} GB are free. \
             Free up space or move Kashshaf to a larger drive, then try again.",
            data_dir.display(),
            total_size as f64 / 1e9,
            FREE_SPACE_MARGIN as f64 / 1e9,
            free as f64 / 1e9
        ));
    }

    // Initialize progress
    let mut progress = DownloadProgress {
        current_file: String::new(),
        file_bytes_downloaded: 0,
        file_total_bytes: 0,
        overall_bytes_downloaded: 0,
        overall_total_bytes: total_size,
        files_completed: 0,
        files_total: missing_files.len(),
        state: DownloadState::Starting,
    };

    let _ = progress_tx.send(progress.clone()).await;

    // Create or load local manifest
    let mut local_manifest = local.cloned().unwrap_or_else(|| LocalManifest {
        corpus_version: remote.corpus_version.clone(),
        schema_version: remote.schema_version,
        downloaded_at: chrono::Utc::now().to_rfc3339(),
        files: HashMap::new(),
    });

    // Download each missing file
    for file in &remote.files {
        // Check for cancellation
        if *cancel_rx.borrow() {
            progress.state = DownloadState::Cancelled;
            let _ = progress_tx.send(progress).await;
            return Err(anyhow!("Download cancelled"));
        }

        if !missing_files.contains(&file.name) {
            continue;
        }

        let local_path = data_dir.join(&file.name);
        let url = remote.file_url(&file.name);

        progress.current_file = file.name.clone();
        progress.file_bytes_downloaded = 0;
        progress.file_total_bytes = file.size;
        progress.state = DownloadState::Downloading;
        let _ = progress_tx.send(progress.clone()).await;

        // Mark file as incomplete in manifest
        local_manifest.files.insert(
            file.name.clone(),
            LocalFile {
                hash: file.hash.clone(),
                size: file.size,
                complete: false,
            },
        );
        save_local_manifest(data_dir, &local_manifest)?;

        // Download file
        let bytes_before = progress.overall_bytes_downloaded;
        match download_file_with_progress(
            &client,
            &url,
            &local_path,
            file.size,
            &progress_tx,
            &mut progress,
            cancel_rx,
        )
        .await
        {
            Ok(()) => {}
            Err(e) => {
                // Check if this was a cancellation
                if *cancel_rx.borrow() {
                    progress.state = DownloadState::Cancelled;
                    let _ = progress_tx.send(progress).await;
                } else {
                    progress.state = DownloadState::Failed;
                    let _ = progress_tx.send(progress).await;
                }
                return Err(e);
            }
        }

        // Verify hash (unless skip_verify is set)
        if !skip_verify {
            progress.state = DownloadState::Verifying;
            let _ = progress_tx.send(progress.clone()).await;

            if !verify_file_hash(&local_path, &file.hash)? {
                // Delete corrupted file
                let _ = fs::remove_file(&local_path);
                progress.state = DownloadState::Failed;
                progress.overall_bytes_downloaded = bytes_before;
                let _ = progress_tx.send(progress).await;
                return Err(anyhow!("Hash verification failed for {}", file.name));
            }
        }

        // Mark file as complete
        if let Some(local_file) = local_manifest.files.get_mut(&file.name) {
            local_file.complete = true;
        }
        save_local_manifest(data_dir, &local_manifest)?;

        progress.files_completed += 1;
    }

    // Update manifest with final info
    local_manifest.corpus_version = remote.corpus_version.clone();
    local_manifest.schema_version = remote.schema_version;
    local_manifest.downloaded_at = chrono::Utc::now().to_rfc3339();
    save_local_manifest(data_dir, &local_manifest)?;

    // Delete files not in remote manifest
    if let Some(old_local) = local {
        for old_file_name in old_local.files.keys() {
            if !remote.files.iter().any(|f| &f.name == old_file_name) {
                let old_path = data_dir.join(old_file_name);
                if old_path.exists() {
                    let _ = fs::remove_file(old_path);
                }
            }
        }
    }

    progress.state = DownloadState::Completed;
    let _ = progress_tx.send(progress).await;

    Ok(())
}
