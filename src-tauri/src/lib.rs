//! Kashshaf - Medieval Arabic Text Research Environment
//!
//! Backend library providing search and text retrieval functionality.

// Token types must be defined first as they're used by search
pub mod tokens;
pub mod search;
pub mod cache;
pub mod error;
pub mod state;
pub mod downloader;

pub use error::KashshafError;
pub use state::AppState;
pub use search::{SearchEngine, SearchMode, SearchFilters, SearchResult, SearchResults, PageWithMatches, SearchTerm, parse_wildcard_query, WildcardQueryInfo};
pub use cache::TokenCache;
pub use tokens::{Token, TokenField, PageKey};
pub use downloader::{
    CorpusStatus, DownloadProgress, DownloadState, LocalManifest, RemoteManifest,
    check_corpus_status, download_corpus, fetch_remote_manifest, load_local_manifest,
    get_data_dir, get_app_data_directory, get_corpus_data_directory, get_settings_db_path,
    archive_old_corpus, verify_file_hash,
};
