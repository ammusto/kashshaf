//! Corpus data download and update system
//!
//! Handles downloading corpus data from R2 storage, verifying file integrity,
//! and managing local/remote manifest synchronization.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

/// R2 public bucket URLs
const CORPUS_MANIFEST_URL: &str = "https://cdn.kashshaf.com/corpus_manifest.json";
const APP_MANIFEST_URL: &str = "https://cdn.kashshaf.com/app_manifest.json";
const DATA_BASE_URL: &str = "https://cdn.kashshaf.com/";

// Alias for backwards compatibility
const MANIFEST_URL: &str = CORPUS_MANIFEST_URL;

/// Remote manifest structure (stored on R2)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteManifest {
    pub corpus_version: String,
    pub schema_version: i64,
    pub min_app_version: String,
    pub built_at: String,
    pub files: Vec<RemoteFile>,
}

/// Remote file entry in manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFile {
    pub name: String,
    pub hash: String,
    pub size: u64,
}

/// Local manifest structure (stored in data directory)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalManifest {
    pub corpus_version: String,
    pub schema_version: i64,
    pub downloaded_at: String,
    pub files: HashMap<String, LocalFile>,
}

/// Local file entry in manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalFile {
    pub hash: String,
    pub size: u64,
    pub complete: bool,
}

/// Corpus status returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusStatus {
    /// Whether the corpus is ready to use
    pub ready: bool,
    /// Local corpus version (if available)
    pub local_version: Option<String>,
    /// Remote corpus version (if fetched)
    pub remote_version: Option<String>,
    /// Whether an optional update is available
    pub update_available: bool,
    /// Whether update is required (schema changed)
    pub update_required: bool,
    /// List of missing or incomplete files
    pub missing_files: Vec<String>,
    /// Total bytes to download
    pub total_download_size: u64,
    /// Error message if check failed
    pub error: Option<String>,
}

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

// ============ App Manifest Types ============

/// App manifest structure (for app version updates)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppManifest {
    pub latest_version: String,
    pub min_supported_version: String,
    pub releases: Vec<AppRelease>,
}

/// Platform-specific download URLs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformDownloads {
    pub windows: String,
    pub macos: String,
    pub linux: String,
}

/// App release entry in manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRelease {
    pub version: String,
    pub released_at: String,
    pub required: bool,
    pub notes: String,
    pub downloads: PlatformDownloads,
}

impl AppRelease {
    /// Get the download URL for the current platform
    pub fn download_url_for_current_platform(&self) -> &str {
        #[cfg(target_os = "windows")]
        { &self.downloads.windows }
        #[cfg(target_os = "macos")]
        { &self.downloads.macos }
        #[cfg(target_os = "linux")]
        { &self.downloads.linux }
    }
}

/// App update status returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub min_supported_version: String,
    pub update_required: bool,
    pub update_available: bool,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
}

/// Get the data directory
///
/// - macOS: ~/Library/Application Support/Kashshaf/
/// - Windows/Linux: data folder next to executable (portable)
/// - Development: project root or relative dev paths
pub fn get_data_dir() -> PathBuf {
    // Dev mode: check for data in common development locations
    #[cfg(debug_assertions)]
    {
        let dev_paths = [
            PathBuf::from("data"),
            PathBuf::from("../../data"),       // app/src-tauri -> project root
            PathBuf::from("../../../data"),    // app/src-tauri/target/debug -> project root
        ];
        for path in &dev_paths {
            if path.join("corpus.db").exists() || path.join("tantivy_index").exists() {
                return path.canonicalize().unwrap_or_else(|_| path.clone());
            }
        }

        // Also check relative to executable in dev mode
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // Walk up from target/debug to find project root
                let mut current = exe_dir;
                for _ in 0..5 {
                    let data_path = current.join("data");
                    if data_path.join("corpus.db").exists() || data_path.join("tantivy_index").exists() {
                        return data_path;
                    }
                    if let Some(parent) = current.parent() {
                        current = parent;
                    } else {
                        break;
                    }
                }
            }
        }

        // Dev mode fallback: next to executable for download testing
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir.join("data");
            }
        }
    }

    // Production macOS: use Application Support
    #[cfg(target_os = "macos")]
    {
        if let Some(data_dir) = dirs::data_dir() {
            return data_dir.join("Kashshaf");
        }
    }

    // Production Windows/Linux: data folder next to executable (portable)
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir.join("data");
            }
        }
    }

    // Fallback to current working directory
    PathBuf::from("data")
}

/// Get the application data directory (for backwards compatibility)
/// Now returns the portable data directory's parent (or creates structure next to exe)
pub fn get_app_data_directory() -> Result<PathBuf> {
    let data_dir = get_data_dir();
    // Return parent of data dir (where settings.db will live alongside data/)
    if let Some(parent) = data_dir.parent() {
        Ok(parent.to_path_buf())
    } else {
        Ok(PathBuf::from("."))
    }
}

/// Get the corpus data directory (where corpus.db and tantivy_index live)
pub fn get_corpus_data_directory() -> Result<PathBuf> {
    Ok(get_data_dir())
}

/// Get the settings database path (in data folder alongside corpus.db)
pub fn get_settings_db_path() -> Result<PathBuf> {
    Ok(get_data_dir().join("settings.db"))
}

/// Fetch remote manifest from R2
pub async fn fetch_remote_manifest() -> Result<RemoteManifest> {
    let client = reqwest::Client::new();
    let response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .context("Failed to fetch remote manifest")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Failed to fetch manifest: HTTP {}",
            response.status()
        ));
    }

    let manifest: RemoteManifest = response
        .json()
        .await
        .context("Failed to parse remote manifest")?;

    Ok(manifest)
}

/// Load local manifest from disk
pub fn load_local_manifest(data_dir: &Path) -> Option<LocalManifest> {
    let manifest_path = data_dir.join("manifest.local.json");
    if !manifest_path.exists() {
        return None;
    }

    let content = fs::read_to_string(&manifest_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save local manifest to disk
pub fn save_local_manifest(data_dir: &Path, manifest: &LocalManifest) -> Result<()> {
    let manifest_path = data_dir.join("manifest.local.json");
    let content = serde_json::to_string_pretty(manifest)?;
    fs::write(&manifest_path, content)?;
    Ok(())
}

/// Parse semantic version string
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = version.split('-').next()?.split('.').collect();
    if parts.len() >= 3 {
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    } else {
        None
    }
}

/// Check if app version meets minimum requirement
fn version_meets_minimum(app_version: &str, min_version: &str) -> bool {
    match (parse_version(app_version), parse_version(min_version)) {
        (Some((a1, a2, a3)), Some((m1, m2, m3))) => {
            (a1, a2, a3) >= (m1, m2, m3)
        }
        _ => true, // If parsing fails, assume compatible
    }
}

/// Check if essential corpus files exist (for manual installations without manifest.local.json)
fn has_essential_files(data_dir: &Path) -> bool {
    let corpus_db = data_dir.join("corpus.db");
    let tantivy_index = data_dir.join("tantivy_index");
    corpus_db.exists() && tantivy_index.exists() && tantivy_index.is_dir()
}

/// Check corpus status by comparing local and remote manifests
pub async fn check_corpus_status(data_dir: &Path, app_version: &str) -> CorpusStatus {
    // Load local manifest
    let local = load_local_manifest(data_dir);

    // Try to fetch remote manifest
    let remote = match fetch_remote_manifest().await {
        Ok(m) => Some(m),
        Err(e) => {
            // If we can't fetch remote, check if local is usable
            if let Some(ref local_manifest) = local {
                if is_local_complete(data_dir, local_manifest) {
                    return CorpusStatus {
                        ready: true,
                        local_version: Some(local_manifest.corpus_version.clone()),
                        remote_version: None,
                        update_available: false,
                        update_required: false,
                        missing_files: vec![],
                        total_download_size: 0,
                        error: Some(format!("Could not check for updates: {}", e)),
                    };
                }
            }
            // No local manifest but essential files exist - consider ready (manual install)
            if has_essential_files(data_dir) {
                return CorpusStatus {
                    ready: true,
                    local_version: None,
                    remote_version: None,
                    update_available: false,
                    update_required: false,
                    missing_files: vec![],
                    total_download_size: 0,
                    error: Some(format!("Could not check for updates: {}", e)),
                };
            }
            return CorpusStatus {
                ready: false,
                local_version: local.as_ref().map(|l| l.corpus_version.clone()),
                remote_version: None,
                update_available: false,
                update_required: false,
                missing_files: vec!["Unable to determine (offline)".to_string()],
                total_download_size: 0,
                error: Some(format!("Could not fetch manifest: {}", e)),
            };
        }
    };

    let remote = remote.unwrap();

    // Check app version compatibility
    if !version_meets_minimum(app_version, &remote.min_app_version) {
        return CorpusStatus {
            ready: false,
            local_version: local.as_ref().map(|l| l.corpus_version.clone()),
            remote_version: Some(remote.corpus_version),
            update_available: false,
            update_required: true,
            missing_files: vec![],
            total_download_size: 0,
            error: Some(format!(
                "App version {} is too old. Please update to at least {}",
                app_version, remote.min_app_version
            )),
        };
    }

    // Determine which files need downloading
    let (missing_files, total_size) = calculate_missing_files(data_dir, &remote, local.as_ref());

    // Check if update is required (schema changed) or optional (new version)
    let (update_required, update_available) = if let Some(ref local_manifest) = local {
        let schema_changed = remote.schema_version != local_manifest.schema_version;
        let version_changed = remote.corpus_version != local_manifest.corpus_version;
        (schema_changed, !schema_changed && version_changed)
    } else {
        (false, false)
    };

    // Determine if ready:
    // - If we have a local manifest and no missing files, ready
    // - If no local manifest but essential files exist (manual install), ready
    let ready = if local.is_some() {
        missing_files.is_empty() && !update_required
    } else {
        // No local manifest - check if essential files exist (manual installation)
        has_essential_files(data_dir)
    };

    CorpusStatus {
        ready,
        local_version: local.as_ref().map(|l| l.corpus_version.clone()),
        remote_version: Some(remote.corpus_version),
        update_available,
        update_required,
        missing_files: if ready && local.is_none() { vec![] } else { missing_files },
        total_download_size: if ready && local.is_none() { 0 } else { total_size },
        error: None,
    }
}

/// Check if local installation is complete
fn is_local_complete(data_dir: &Path, local: &LocalManifest) -> bool {
    for (name, file) in &local.files {
        if !file.complete {
            return false;
        }
        let path = data_dir.join(name);
        if !path.exists() {
            return false;
        }
    }
    true
}

/// Calculate which files need to be downloaded
fn calculate_missing_files(
    data_dir: &Path,
    remote: &RemoteManifest,
    local: Option<&LocalManifest>,
) -> (Vec<String>, u64) {
    let mut missing = Vec::new();
    let mut total_size = 0u64;

    for file in &remote.files {
        let local_path = data_dir.join(&file.name);
        let needs_download = if let Some(local_manifest) = local {
            if let Some(local_file) = local_manifest.files.get(&file.name) {
                // File exists in manifest - check if complete and hash matches
                !local_file.complete || local_file.hash != file.hash || !local_path.exists()
            } else {
                // File not in local manifest
                true
            }
        } else {
            // No local manifest - need all files
            true
        };

        if needs_download {
            missing.push(file.name.clone());
            total_size += file.size;
        }
    }

    (missing, total_size)
}

/// Verify file hash matches expected
pub fn verify_file_hash(path: &Path, expected_hash: &str) -> Result<bool> {
    let expected = expected_hash.strip_prefix("sha256:").unwrap_or(expected_hash);

    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    let result = hasher.finalize();
    let actual = hex::encode(result);

    Ok(actual == expected)
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
        let url = format!("{}{}", DATA_BASE_URL, file.name);

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

// ============ App Manifest Functions ============

/// Fetch app manifest from R2
pub async fn fetch_app_manifest() -> Result<AppManifest> {
    let client = reqwest::Client::new();
    let response = client
        .get(APP_MANIFEST_URL)
        .send()
        .await
        .context("Failed to fetch app manifest")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Failed to fetch app manifest: HTTP {}",
            response.status()
        ));
    }

    let manifest: AppManifest = response
        .json()
        .await
        .context("Failed to parse app manifest")?;

    Ok(manifest)
}

/// Check app update status by comparing current version with manifest
pub fn check_app_update(current_version: &str, manifest: &AppManifest) -> AppUpdateStatus {
    let current = parse_version(current_version);
    let latest = parse_version(&manifest.latest_version);
    let min = parse_version(&manifest.min_supported_version);

    // Check if update is required:
    // 1. Current version is below minimum supported, OR
    // 2. Any release between current and latest is marked as required
    let update_required = match (current, min) {
        (Some(c), Some(m)) => c < m,
        _ => false,
    } || manifest.releases.iter()
        .filter(|r| {
            if let (Some(c), Some(rv)) = (current, parse_version(&r.version)) {
                rv > c
            } else {
                false
            }
        })
        .any(|r| r.required);

    // Check if any update is available
    let update_available = match (current, latest) {
        (Some(c), Some(l)) => c < l,
        _ => false,
    };

    // Get the latest release info
    let latest_release = manifest.releases.first();

    AppUpdateStatus {
        current_version: current_version.to_string(),
        latest_version: manifest.latest_version.clone(),
        min_supported_version: manifest.min_supported_version.clone(),
        update_required,
        update_available,
        release_notes: latest_release.map(|r| r.notes.clone()),
        download_url: latest_release.map(|r| r.download_url_for_current_platform().to_string()),
    }
}

/// Archive old corpus version before update
pub fn archive_old_corpus(_app_data_dir: &Path, version: &str) -> Result<PathBuf> {
    let data_dir = get_data_dir();
    // Archive directory lives next to data directory
    let archive_dir = data_dir.parent()
        .map(|p| p.join("data-archive"))
        .unwrap_or_else(|| PathBuf::from("data-archive"));

    if !data_dir.exists() {
        return Err(anyhow!("No data directory to archive"));
    }

    fs::create_dir_all(&archive_dir)?;

    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let archive_name = format!("{}_{}", version, timestamp);
    let archive_path = archive_dir.join(&archive_name);

    fs::rename(&data_dir, &archive_path)?;

    Ok(archive_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_parsing() {
        assert_eq!(parse_version("1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_version("0.1.0-alpha"), Some((0, 1, 0)));
        assert_eq!(parse_version("2.3.4-beta.1"), Some((2, 3, 4)));
    }

    #[test]
    fn test_version_comparison() {
        assert!(version_meets_minimum("1.0.0", "1.0.0"));
        assert!(version_meets_minimum("1.1.0", "1.0.0"));
        assert!(version_meets_minimum("2.0.0", "1.9.9"));
        assert!(!version_meets_minimum("0.9.9", "1.0.0"));
    }
}
