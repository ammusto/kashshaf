//! Kashshaf - Medieval Arabic Text Research Environment
//!
//! Backend library for the Tauri desktop app. Search, token caching and
//! variants live in the shared `kashshaf-engine` crate (also used by the API
//! server); the data directory, corpus manifests, the download and the
//! settings-DB helpers live in `kashshaf-common` (also used by Kashshaf Lab).
//! This crate adds app state and the Tauri command surface.

pub use kashshaf_engine::{cache, search, tokens, variants};
pub use kashshaf_common::{data_dir, download, manifest, settings};

pub mod error;
pub mod state;

pub use cache::TokenCache;
pub use kashshaf_common::{
    archive_old_corpus, check_corpus_status, download_corpus, fetch_remote_manifest, get_app_data_directory,
    get_corpus_data_directory, get_data_dir, get_settings_db_path, load_local_manifest, verify_file_hash,
    CorpusStatus, DownloadProgress, DownloadState, LocalManifest, RemoteManifest,
};
pub use error::KashshafError;
pub use search::{
    parse_wildcard_query, PageWithMatches, SearchEngine, SearchFilters, SearchMode, SearchResult, SearchResults,
    SearchTerm, WildcardQueryInfo,
};
pub use state::AppState;
pub use tokens::{PageKey, Token, TokenField};
pub use variants::{compute_variants, Variant, VariantsResponse, MAX_SCANNED_HITS};
