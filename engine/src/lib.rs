//! kashshaf-engine — the search engine shared by the Tauri desktop backend
//! (`src-tauri`) and the API server (`api`).
//!
//! Both hosts open the same artifacts (`tantivy_index/`, `corpus.db`) through
//! this crate; the only per-host differences are in [`search::EngineConfig`].

pub mod blob;
pub mod cache;
pub mod collectors;
pub mod corpus_db;
pub mod forward;
pub mod glob;
pub mod memory;
pub mod normalize;
pub mod positional;
pub mod search;
pub mod tokens;
pub mod triples;
pub mod variants;
pub mod walk;

pub use triples::TripleMaps;

pub use blob::{decode_blob, BlobCodec, ENCODING_RANK_VARINT_ZSTD, ENCODING_RAW_U32};
pub use cache::TokenCache;
pub use corpus_db::{
    check_corpus_schema_supported, ensure_corpus_indexes, read_db_info, verify_corpus_versions_match, DbInfo,
    MAX_SUPPORTED_DB_SCHEMA, MIN_SUPPORTED_DB_SCHEMA,
};
pub use normalize::{normalize_arabic, normalize_root_query};
pub use cache::BatchStats;
pub use glob::GlobPattern;
pub use search::{
    parse_wildcard_query, validate_wildcard_query, EngineCapabilities, EngineConfig, IndexKind, PageWithMatches,
    ProximityImpl, ProximityStats, SearchEngine, SearchFilters, SearchMode, SearchResult, SearchResults, SearchTerm,
    WildcardGrammar, WildcardQueryInfo, WildcardType, PROXIMITY_MAX_VERIFY, WILDCARD_EXPANSION_THRESHOLD,
};
pub use memory::{process_memory, ProcessMemory};
pub use walk::{
    default_max_concurrent_walks, WalkCache, WalkHit, WalkLimits, WalkStats, WalkStatus, MAX_VERIFIED_HITS,
    PREFIX_CACHE_BYTES, PREFIX_CACHE_ENTRIES, WALK_BUDGET_MS, WALK_INLINE_MS, WALK_QUEUE_MS,
};
pub use tokens::{PageKey, Token, TokenClitic, TokenField};
pub use variants::{compute_variants, Variant, VariantsResponse, MAX_SCANNED_HITS};
