//! kashshaf-engine — the search engine shared by the Tauri desktop backend
//! (`src-tauri`) and the API server (`api`).
//!
//! Both hosts open the same artifacts (`tantivy_index/`, `corpus.db`) through
//! this crate; the only per-host differences are in [`search::EngineConfig`].

pub mod bench_cases;
#[cfg(feature = "remote")]
pub mod bench_remote;
pub mod blob;
pub mod boundary;
pub mod cache;
pub mod collectors;
pub mod corpus_db;
pub mod forward;
pub mod glob;
pub mod memory;
pub mod names;
pub mod normalize;
pub mod positional;
pub mod search;
pub mod toc;
pub mod tokens;
pub mod triples;
pub mod triples_image;
pub mod variants;
pub mod walk;

pub use triples::{TripleMaps, TripleSource};
pub use triples_image::{Image as TripleImage, ImageParts as TripleImageParts, SIDECAR_NAME as TRIPLES_SIDECAR_NAME};

pub use blob::{decode_blob, BlobCodec, ENCODING_RANK_VARINT_ZSTD, ENCODING_RAW_U32};
pub use cache::TokenCache;
pub use boundary::{BoundaryIndex, BoundaryMeta, CrossHit, MAX_SPAN as BOUNDARY_MAX_SPAN};
pub use corpus_db::{
    check_corpus_schema_supported, ensure_corpus_indexes, read_db_info, verify_corpus_versions_match, DbInfo,
    MAX_SUPPORTED_DB_SCHEMA, MIN_SUPPORTED_DB_SCHEMA,
};
pub use normalize::{normalize_arabic, normalize_root_query};
pub use names::{expand_forms as expand_name_forms, expand_patterns as expand_name_patterns};
pub use cache::BatchStats;
pub use glob::GlobPattern;
pub use search::{
    parse_wildcard_query, validate_wildcard_query, EngineCapabilities, EngineConfig, IndexKind, PageEntry, PageMatches,
    PageWithMatches, ProximityImpl, ProximityQuery, ProximityStats, SearchEngine, SearchFilters, SearchMode, SearchResult, SearchResults,
    SearchTerm, SecondarySpan,
    WildcardGrammar, WildcardQueryInfo, WildcardType, PROXIMITY_MAX_VERIFY, WILDCARD_EXPANSION_THRESHOLD,
};
pub use memory::{process_memory, ProcessMemory};
pub use walk::{
    default_max_concurrent_walks, CrossRef, WalkCache, WalkHit, WalkLimits, WalkStats, WalkStatus, MAX_VERIFIED_HITS,
    PREFIX_CACHE_BYTES, PREFIX_CACHE_ENTRIES, WALK_BUDGET_MS, WALK_INLINE_MS, WALK_QUEUE_MS,
};
pub use tokens::{PageKey, Token, TokenClitic, TokenField};
pub use toc::{TocDb, TocNode, TocRow};
pub use variants::{compute_variants, Variant, VariantsResponse, MAX_SCANNED_HITS};
