//! Corpus and app manifests: the types, the local/remote comparison that
//! drives the download dialog, hash verification, and archiving.
//!
//! Moved verbatim out of the desktop app's `downloader` module (Lab spec §2.2).

use crate::data_dir::get_data_dir;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    /// Where the files live, e.g. `https://cdn.kashshaf.com/corpus/4.0.0/`
    /// (versioned prefix; a rollback is one manifest upload). Absent in
    /// manifests up to 3.x, whose files sit flat under the CDN root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// What changed in this corpus version, shown by the update dialog.
    /// Optional; older manifests do not carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub files: Vec<RemoteFile>,
}

impl RemoteManifest {
    /// Download URL of one manifest entry: `base_url` + name when the
    /// manifest carries a base URL, else the flat layout under the CDN root.
    pub fn file_url(&self, name: &str) -> String {
        let base = self.base_url.as_deref().filter(|b| !b.is_empty()).unwrap_or(DATA_BASE_URL);
        if base.ends_with('/') {
            format!("{}{}", base, name)
        } else {
            format!("{}/{}", base, name)
        }
    }
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
    /// The local corpus can be opened by this app version. True while an
    /// optional update is available (the current corpus stays usable);
    /// false when files are missing or `update_required`.
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
    /// The remote manifest's `notes` (what changed), when it has one.
    pub remote_notes: Option<String>,
    /// Error message if check failed
    pub error: Option<String>,
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

/// [`fetch_remote_manifest`] for callers without an async runtime (Lab's
/// `ApiSource` is blocking).
pub fn fetch_remote_manifest_blocking() -> Result<RemoteManifest> {
    let response = reqwest::blocking::Client::new()
        .get(MANIFEST_URL)
        .send()
        .context("Failed to fetch remote manifest")?;
    if !response.status().is_success() {
        return Err(anyhow!("Failed to fetch manifest: HTTP {}", response.status()));
    }
    response.json().context("Failed to parse remote manifest")
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

/// Which compatibility rule the caller wants applied to a remote corpus.
///
/// `corpus_manifest.json`'s `min_app_version` is the minimum *Kashshaf* version
/// that can read a corpus. It says nothing about Kashshaf Lab, whose version is
/// independent (Lab spec §2.1) and whose `0.1.x` would read as too old against
/// every published manifest. So the floor is the caller's, not the manifest's
/// alone (Lab spec §2.4, amended in spec 1.2).
#[derive(Debug, Clone, Copy)]
pub enum CompatFloor<'a> {
    /// Kashshaf: refuse a corpus whose `min_app_version` exceeds this version.
    AppVersion(&'a str),
    /// Kashshaf Lab: ignore `min_app_version`; refuse a corpus older than this
    /// (`lab_manifest.json`'s `min_corpus_version`, §10). The engine's schema
    /// gate is the other half of Lab's rule and is applied when the corpus is
    /// opened, not here.
    MinCorpusVersion(&'a str),
}

impl CompatFloor<'_> {
    /// `None` when the remote corpus is acceptable, else why it is not.
    fn rejects(&self, remote: &RemoteManifest) -> Option<String> {
        match self {
            CompatFloor::AppVersion(v) => {
                (!version_meets_minimum(v, &remote.min_app_version)).then(|| {
                    format!(
                        "App version {} is too old. Please update to at least {}",
                        v, remote.min_app_version
                    )
                })
            }
            CompatFloor::MinCorpusVersion(min) => {
                (!version_meets_minimum(&remote.corpus_version, min)).then(|| {
                    format!(
                        "Corpus {} is older than this build supports (minimum {}).",
                        remote.corpus_version, min
                    )
                })
            }
        }
    }
}

/// Check if essential corpus files exist (for manual installations without manifest.local.json)
fn has_essential_files(data_dir: &Path) -> bool {
    let corpus_db = data_dir.join("corpus.db");
    let metadata_db = data_dir.join("metadata.db");
    let tantivy_index = data_dir.join("tantivy_index");
    corpus_db.exists()
        && metadata_db.exists()
        && tantivy_index.exists()
        && tantivy_index.is_dir()
}

/// Check corpus status by comparing local and remote manifests
pub async fn check_corpus_status(data_dir: &Path, floor: CompatFloor<'_>) -> CorpusStatus {
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
                        remote_notes: None,
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
                    remote_notes: None,
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
                remote_notes: None,
                error: Some(format!("Could not fetch manifest: {}", e)),
            };
        }
    };

    let remote = remote.unwrap();

    // Compatibility, by the caller's rule (Lab spec §2.4).
    if let Some(why) = floor.rejects(&remote) {
        return CorpusStatus {
            ready: false,
            local_version: local.as_ref().map(|l| l.corpus_version.clone()),
            remote_version: Some(remote.corpus_version),
            update_available: false,
            update_required: true,
            missing_files: vec![],
            total_download_size: 0,
            remote_notes: Some(remote.notes.clone()).flatten(),
            error: Some(why),
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

    let ready = corpus_ready(
        local.as_ref().map(|l| is_local_complete(data_dir, l)),
        missing_files.is_empty(),
        update_required,
        update_available,
        || has_essential_files(data_dir),
    );

    CorpusStatus {
        ready,
        local_version: local.as_ref().map(|l| l.corpus_version.clone()),
        remote_version: Some(remote.corpus_version),
        update_available,
        update_required,
        missing_files: if ready && local.is_none() { vec![] } else { missing_files },
        total_download_size: if ready && local.is_none() { 0 } else { total_size },
        remote_notes: remote.notes,
        error: None,
    }
}

/// Can the app open the corpus it has? `local_complete` is `Some(complete)`
/// when a local manifest exists. `missing_empty` says the remote manifest's
/// file list is fully present (false whenever a newer version is published,
/// because `calculate_missing_files` diffs against the remote list).
///
/// - required update (schema changed, or app too old): never ready;
/// - nothing to download: ready;
/// - optional update with a complete local corpus: ready — the current
///   version stays usable, the update is offered, not imposed;
/// - no local manifest (manual install): ready when the essential files exist.
fn corpus_ready(
    local_complete: Option<bool>,
    missing_empty: bool,
    update_required: bool,
    update_available: bool,
    has_essential: impl FnOnce() -> bool,
) -> bool {
    match local_complete {
        _ if update_required => false,
        Some(complete) => missing_empty || (update_available && complete),
        None => has_essential(),
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
pub(crate) fn calculate_missing_files(
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
    let data_dir = get_data_dir()?;
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

    /// The three dialog states plus the manual-install case.
    #[test]
    fn ready_states() {
        // no corpus: local manifest absent, essential files absent
        assert!(!corpus_ready(None, false, false, false, || false));
        // manual install without a manifest
        assert!(corpus_ready(None, false, false, false, || true));
        // up to date
        assert!(corpus_ready(Some(true), true, false, false, || false));
        // optional update: the remote diff lists every file, but the local
        // 4.0.0 is complete and readable -> ready, banner not modal
        assert!(corpus_ready(Some(true), false, false, true, || false));
        // optional update but the local corpus is itself incomplete
        assert!(!corpus_ready(Some(false), false, false, true, || false));
        // required update (schema change): never ready, whatever else holds
        assert!(!corpus_ready(Some(true), true, true, false, || true));
        assert!(!corpus_ready(None, true, true, false, || true));
        // interrupted first download: manifest present, files missing, same version
        assert!(!corpus_ready(Some(false), false, false, false, || false));
    }

    fn manifest(corpus: &str, min_app: &str) -> RemoteManifest {
        RemoteManifest {
            corpus_version: corpus.to_string(),
            schema_version: 4,
            min_app_version: min_app.to_string(),
            built_at: "x".to_string(),
            base_url: None,
            notes: None,
            files: vec![],
        }
    }

    /// Lab spec §2.4: the two products refuse different corpora, and Lab never
    /// consults `min_app_version` — its own `0.1.0` would fail every published
    /// manifest.
    #[test]
    fn each_product_applies_its_own_compatibility_floor() {
        let m = manifest("4.1.0", "0.5.0");

        // Kashshaf: the manifest's min_app_version against this build.
        assert!(CompatFloor::AppVersion("0.5.2").rejects(&m).is_none());
        assert!(CompatFloor::AppVersion("0.5.0").rejects(&m).is_none());
        let why = CompatFloor::AppVersion("0.4.9").rejects(&m).expect("too old");
        assert!(why.contains("0.4.9") && why.contains("0.5.0"), "{}", why);

        // Lab: min_app_version is ignored, whatever it says.
        assert!(CompatFloor::MinCorpusVersion("4.0.0").rejects(&m).is_none());
        assert!(
            CompatFloor::MinCorpusVersion("4.0.0")
                .rejects(&manifest("4.1.0", "99.0.0"))
                .is_none(),
            "Lab must ignore min_app_version entirely"
        );
        // ...but Lab does refuse a corpus below its own floor, and says which.
        let why = CompatFloor::MinCorpusVersion("4.0.0")
            .rejects(&manifest("3.2.0", "0.4.0"))
            .expect("corpus too old");
        assert!(why.contains("3.2.0") && why.contains("4.0.0"), "{}", why);
        assert!(!why.contains("App version"), "{}", why);
    }

    #[test]
    fn remote_manifest_notes_are_optional() {
        let without = r#"{"corpus_version":"4.0.0","schema_version":4,"min_app_version":"0.5.0","built_at":"x","files":[]}"#;
        let m: RemoteManifest = serde_json::from_str(without).unwrap();
        assert_eq!(m.notes, None);
        let with = r#"{"corpus_version":"4.1.0","schema_version":4,"min_app_version":"0.5.0","built_at":"x","notes":"23 texts added","files":[]}"#;
        let m: RemoteManifest = serde_json::from_str(with).unwrap();
        assert_eq!(m.notes.as_deref(), Some("23 texts added"));
    }
}
