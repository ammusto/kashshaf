//! Code shared by the Kashshaf desktop app (`src-tauri`) and Kashshaf Lab
//! (`lab/src-tauri`): where the data lives, what the corpus manifests mean,
//! how the corpus is downloaded, and how a settings database is opened.
//!
//! See `dev-docs/KASHSHAF_LAB_SPEC.md` §2.2. Nothing here knows about Tauri,
//! so both backends and the tests can use it directly.

pub mod data_dir;
pub mod download;
pub mod manifest;
pub mod settings;

pub use data_dir::{
    data_dir_info, get_app_data_directory, get_corpus_data_directory, get_data_dir,
    get_settings_db_path, has_enough_space, lab_data_dir, resolve_data_dir, resolve_with,
    write_probe, DataDirInfo, DataDirSource, FREE_SPACE_MARGIN,
};
pub use download::{download_corpus, DownloadProgress, DownloadState};
pub use manifest::{
    archive_old_corpus, check_app_update, check_corpus_status, fetch_app_manifest,
    fetch_remote_manifest, fetch_remote_manifest_blocking, load_local_manifest, save_local_manifest, verify_file_hash, AppManifest,
    AppRelease, AppUpdateStatus, CompatFloor, CorpusStatus, LocalFile, LocalManifest,
    PlatformDownloads, RemoteFile, RemoteManifest,
};
pub use settings::{ensure_kv_table, get_kv, open_settings_db, set_kv};
