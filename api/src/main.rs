//! Kashshaf API server (axum). Thin HTTP layer over `kashshaf-engine`, the
//! same engine the desktop app embeds.

mod bulk;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use kashshaf_engine::{
    check_corpus_schema_supported, compute_variants, ensure_corpus_indexes, EngineConfig, PageKey, PageWithMatches,
    SearchEngine, SearchFilters, SearchMode, SearchResult, SearchResults, SearchTerm, Token, TokenCache,
    VariantsResponse, WalkStatus, WildcardGrammar, MAX_SUPPORTED_DB_SCHEMA,
};
use kashshaf_engine::memory::process_memory;
use axum::response::IntoResponse;
use std::net::SocketAddr;
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorError, GovernorLayer};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

/// Upper bound on `limit` for every search endpoint. Matches the desktop
/// client's page size (`PAGE_SIZE = 250`) so online load-more never skips rows.
const MAX_LIMIT: usize = 250;
const DEFAULT_LIMIT: usize = 50;

struct AppState {
    search_engine: SearchEngine,
    token_cache: Arc<TokenCache>,
    metadata_db_path: PathBuf,
    corpus_version: Option<String>,
    db_schema_version: Option<i64>,
    /// Page-cache warm-up: 0 disabled, 1 pending, 2 complete (`/health.warm_cache`).
    warm_cache: Arc<std::sync::atomic::AtomicU8>,
    /// Per-client caps for `GET /book/{id}/tokens` (Lab spec §5.1), which is
    /// exempt from the per-request limiter.
    bulk_limiter: Arc<bulk::BulkLimiter>,
}

const WARM_DISABLED: u8 = 0;
const WARM_PENDING: u8 = 1;
const WARM_COMPLETE: u8 = 2;

type ApiError = (StatusCode, Json<ErrorResponse>);

fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() }))
}

fn bad_request(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e.to_string() }))
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn parse_book_ids(s: Option<String>) -> Option<Vec<u64>> {
    s.map(|s| s.split(',').filter_map(|id| id.trim().parse().ok()).collect())
}

// === Request/Response types ===

#[derive(Deserialize)]
struct SimpleSearchQuery {
    q: String,
    mode: Option<SearchMode>,
    limit: Option<usize>,
    offset: Option<usize>,
    book_ids: Option<String>,
}

#[derive(Deserialize)]
struct CombinedSearchRequest {
    and_terms: Vec<SearchTerm>,
    or_terms: Vec<SearchTerm>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct ProximitySearchRequest {
    term1: SearchTerm,
    term2: SearchTerm,
    distance: usize,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct NameSearchRequest {
    forms: Vec<NameSearchForm>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct NameSearchForm {
    patterns: Vec<String>,
}

#[derive(Deserialize)]
struct WildcardSearchQuery {
    q: String,
    limit: Option<usize>,
    offset: Option<usize>,
    book_ids: Option<String>,
}

#[derive(Deserialize)]
struct VariantsRequest {
    query: String,
    mode: Option<SearchMode>,
    filters: Option<SearchFilters>,
}

#[derive(Deserialize)]
struct PageQuery {
    id: u64,
    /// Optional for clients built before 0.5.0 (they addressed pages by
    /// `(id, page_id)` only); defaults to the first part.
    #[serde(default)]
    part_index: u64,
    page_id: u64,
}

#[derive(Deserialize)]
struct PageByLabelQuery {
    id: u64,
    part_label: String,
    page_number: String,
}

#[derive(Deserialize)]
struct TokensQuery {
    id: u64,
    /// Optional for clients built before 0.5.0 (they addressed pages by
    /// `(id, page_id)` only); defaults to the first part.
    #[serde(default)]
    part_index: u64,
    page_id: u64,
}

#[derive(Deserialize)]
struct MatchPositionsQuery {
    id: u64,
    /// Optional for clients built before 0.5.0 (they addressed pages by
    /// `(id, page_id)` only); defaults to the first part.
    #[serde(default)]
    part_index: u64,
    page_id: u64,
    q: String,
    mode: Option<SearchMode>,
}

#[derive(Deserialize)]
struct MatchPositionsCombinedRequest {
    id: u64,
    /// Optional for clients built before 0.5.0 (they addressed pages by
    /// `(id, page_id)` only); defaults to the first part.
    #[serde(default)]
    part_index: u64,
    page_id: u64,
    terms: Vec<SearchTerm>,
}

#[derive(Deserialize)]
struct NameMatchPositionsRequest {
    id: u64,
    /// Optional for clients built before 0.5.0 (they addressed pages by
    /// `(id, page_id)` only); defaults to the first part.
    #[serde(default)]
    part_index: u64,
    page_id: u64,
    patterns: Vec<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
    index_docs: u64,
    segments: usize,
    reading_order: bool,
    corpus_version: Option<String>,
    db_schema_version: Option<i64>,
    max_supported_db_schema: i64,
    max_limit: usize,
    /// `glob` (compound index) or `legacy` (three-field index); the client
    /// validates wildcard input with the matching rules.
    wildcard_grammar: WildcardGrammar,
    /// Always false on the server: walks stop at `max_verified_hits`.
    exact_counts: bool,
    max_verified_hits: usize,
    /// Walk threads running / waiting for a permit, and the prefix cache.
    walks_active: usize,
    walks_queued: usize,
    max_concurrent_walks: usize,
    prefix_cache_entries: usize,
    prefix_cache_bytes: usize,
    /// Page-cache warm-up state: `pending`, `complete` or `disabled`
    /// (`KASHSHAF_WARM_CACHE`). Deploys wait for `complete` before the smoke test.
    warm_cache: String,
    /// This server implements `GET /book/{id}/tokens` (Lab spec §5.1).
    /// Kashshaf Lab reads it to tell "unsupported" from "failed".
    bulk_tokens: bool,
    /// Process memory, MiB (working set includes mmapped index pages).
    rss_mb: f64,
    peak_rss_mb: f64,
    private_mb: f64,
}

#[derive(Deserialize)]
struct WalkStatusQuery {
    key: String,
}

#[derive(Serialize)]
struct BookMetadata {
    id: i64,
    corpus: Option<String>,
    title: String,
    author_id: Option<i64>,
    death_ah: Option<i64>,
    century_ah: Option<i64>,
    genre_id: Option<i64>,
    page_count: Option<i64>,
    token_count: Option<i64>,
    original_id: Option<String>,
    paginated: Option<bool>,
    tags: Option<String>,
    book_meta: Option<String>,
    author_meta: Option<String>,
    in_corpus: Option<bool>,
    parts: Option<i64>,
    metadata_json: Option<String>,
    citation_json: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

// === Handlers ===

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let ws = state.search_engine.walk_stats();
    let mem = process_memory();
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        index_docs: state.search_engine.doc_count().unwrap_or(0),
        segments: state.search_engine.segment_count(),
        reading_order: state.search_engine.reading_order(),
        corpus_version: state.corpus_version.clone(),
        db_schema_version: state.db_schema_version,
        max_supported_db_schema: MAX_SUPPORTED_DB_SCHEMA,
        max_limit: MAX_LIMIT,
        wildcard_grammar: state.search_engine.wildcard_grammar(),
        exact_counts: false,
        max_verified_hits: state.search_engine.config().max_verified_hits,
        walks_active: ws.walks_active,
        walks_queued: ws.walks_queued,
        max_concurrent_walks: ws.max_concurrent_walks,
        prefix_cache_entries: ws.prefix_cache_entries,
        prefix_cache_bytes: ws.prefix_cache_bytes,
        warm_cache: match state.warm_cache.load(std::sync::atomic::Ordering::SeqCst) {
            WARM_PENDING => "pending",
            WARM_COMPLETE => "complete",
            _ => "disabled",
        }
        .to_string(),
        bulk_tokens: true,
        rss_mb: mem.rss_mb(),
        peak_rss_mb: mem.peak_rss_mb(),
        private_mb: mem.private_mb(),
    })
}

/// Progress of a walk-backed search: poll with `SearchResults.walk_key`
/// while `complete` is false. 404 once the walk has left the cache.
async fn walk_status(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WalkStatusQuery>,
) -> Result<Json<WalkStatus>, ApiError> {
    match state.search_engine.walk_status(&params.key) {
        Some(s) => Ok(Json(s)),
        None => Err((StatusCode::NOT_FOUND, Json(ErrorResponse { error: "unknown walk key".to_string() }))),
    }
}

async fn simple_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SimpleSearchQuery>,
) -> Result<Json<SearchResults>, ApiError> {
    let mode = params.mode.unwrap_or(SearchMode::Lemma);
    let limit = clamp_limit(params.limit);
    let offset = params.offset.unwrap_or(0);
    let filters = SearchFilters { book_ids: parse_book_ids(params.book_ids), ..Default::default() };
    state
        .search_engine
        .search(&params.q, mode, &filters, limit, offset)
        .map(Json)
        .map_err(internal)
}

async fn combined_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CombinedSearchRequest>,
) -> Result<Json<SearchResults>, ApiError> {
    let filters = req.filters.unwrap_or_default();
    state
        .search_engine
        .combined_search(&req.and_terms, &req.or_terms, &filters, clamp_limit(req.limit), req.offset.unwrap_or(0))
        .map(Json)
        .map_err(internal)
}

async fn search_variants(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VariantsRequest>,
) -> Result<Json<VariantsResponse>, ApiError> {
    let mode = req.mode.unwrap_or_default();
    if mode == SearchMode::Surface {
        return Err(bad_request("variants are only available for lemma and root searches"));
    }
    let filters = req.filters.unwrap_or_default();
    compute_variants(&state.search_engine, &state.token_cache, &req.query, mode, &filters)
        .map(Json)
        .map_err(internal)
}

async fn proximity_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProximitySearchRequest>,
) -> Result<Json<SearchResults>, ApiError> {
    let filters = req.filters.unwrap_or_default();
    state
        .search_engine
        .proximity_search(&req.term1, &req.term2, req.distance, &filters, clamp_limit(req.limit), req.offset.unwrap_or(0))
        .map(Json)
        .map_err(internal)
}

async fn name_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NameSearchRequest>,
) -> Result<Json<SearchResults>, ApiError> {
    let filters = req.filters.unwrap_or_default();
    let patterns_by_form: Vec<Vec<String>> = req.forms.into_iter().map(|f| f.patterns).collect();
    state
        .search_engine
        .name_search(&patterns_by_form, &filters, clamp_limit(req.limit), req.offset.unwrap_or(0))
        .map(Json)
        .map_err(internal)
}

async fn wildcard_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WildcardSearchQuery>,
) -> Result<Json<SearchResults>, ApiError> {
    if let Err(e) = kashshaf_engine::validate_wildcard_query(&params.q, SearchMode::Surface, state.search_engine.wildcard_grammar()) {
        return Err(bad_request(e.message));
    }
    let filters = SearchFilters { book_ids: parse_book_ids(params.book_ids), ..Default::default() };
    state
        .search_engine
        .wildcard_search_with_cache(
            &params.q,
            &filters,
            clamp_limit(params.limit),
            params.offset.unwrap_or(0),
            Some(state.token_cache.as_ref()),
        )
        .map(Json)
        .map_err(internal)
}

async fn get_page(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageQuery>,
) -> Result<Json<Option<SearchResult>>, ApiError> {
    state
        .search_engine
        .get_page(params.id, params.part_index, params.page_id)
        .map(Json)
        .map_err(internal)
}

async fn get_page_by_label(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageByLabelQuery>,
) -> Result<Json<Option<SearchResult>>, ApiError> {
    state
        .search_engine
        .get_page_by_label(params.id, &params.part_label, &params.page_number)
        .map(Json)
        .map_err(internal)
}

async fn get_page_tokens(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokensQuery>,
) -> Result<Json<Vec<Token>>, ApiError> {
    let key = PageKey::new(params.id, params.part_index, params.page_id);
    state
        .token_cache
        .get(&key)
        .map(|tokens| Json((*tokens).clone()))
        .map_err(internal)
}

async fn get_match_positions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MatchPositionsQuery>,
) -> Result<Json<Vec<u32>>, ApiError> {
    let mode = params.mode.unwrap_or(SearchMode::Lemma);
    state
        .search_engine
        .get_match_positions(params.id, params.part_index, params.page_id, &params.q, mode)
        .map(Json)
        .map_err(internal)
}

async fn get_page_with_matches(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MatchPositionsQuery>,
) -> Result<Json<Option<PageWithMatches>>, ApiError> {
    let mode = params.mode.unwrap_or(SearchMode::Lemma);
    state
        .search_engine
        .get_page_with_matches(params.id, params.part_index, params.page_id, &params.q, mode)
        .map(Json)
        .map_err(internal)
}

async fn get_match_positions_combined(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MatchPositionsCombinedRequest>,
) -> Result<Json<Vec<u32>>, ApiError> {
    state
        .search_engine
        .get_match_positions_combined(req.id, req.part_index, req.page_id, &req.terms)
        .map(Json)
        .map_err(internal)
}

async fn get_name_match_positions(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NameMatchPositionsRequest>,
) -> Result<Json<Vec<u32>>, ApiError> {
    state
        .search_engine
        .get_name_match_positions(req.id, req.part_index, req.page_id, &req.patterns)
        .map(Json)
        .map_err(internal)
}

async fn get_all_books(State(state): State<Arc<AppState>>) -> Result<Json<Vec<BookMetadata>>, ApiError> {
    let conn = rusqlite::Connection::open(&state.metadata_db_path).map_err(internal)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, corpus, title, author_id, death_ah, century_ah, genre_id, page_count, token_count,
                    original_id, paginated, tags, book_meta, author_meta, in_corpus, parts, metadata_json, citation_json
             FROM books ORDER BY death_ah ASC NULLS LAST, id ASC",
        )
        .map_err(internal)?;
    let books = stmt
        .query_map([], |row| {
            Ok(BookMetadata {
                id: row.get(0)?,
                corpus: row.get(1)?,
                title: row.get(2)?,
                author_id: row.get(3)?,
                death_ah: row.get(4)?,
                century_ah: row.get(5)?,
                genre_id: row.get(6)?,
                page_count: row.get(7)?,
                token_count: row.get(8)?,
                original_id: row.get(9)?,
                paginated: row.get::<_, Option<i64>>(10)?.map(|v| v != 0),
                tags: row.get(11)?,
                book_meta: row.get(12)?,
                author_meta: row.get(13)?,
                in_corpus: row.get::<_, Option<i64>>(14)?.map(|v| v != 0),
                parts: row.get(15)?,
                metadata_json: row.get(16)?,
                citation_json: row.get(17)?,
            })
        })
        .map_err(internal)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(books))
}

async fn get_all_authors(State(state): State<Arc<AppState>>) -> Result<Json<Vec<(i64, String)>>, ApiError> {
    let conn = rusqlite::Connection::open(&state.metadata_db_path).map_err(internal)?;
    let mut stmt = conn.prepare("SELECT id, author FROM authors ORDER BY id").map_err(internal)?;
    let authors = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(internal)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(authors))
}

async fn get_all_genres(State(state): State<Arc<AppState>>) -> Result<Json<Vec<(i64, String)>>, ApiError> {
    let conn = rusqlite::Connection::open(&state.metadata_db_path).map_err(internal)?;
    let mut stmt = conn.prepare("SELECT id, genre FROM genres ORDER BY id").map_err(internal)?;
    let genres = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(internal)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(genres))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let data_dir = PathBuf::from(std::env::var("KASHSHAF_DATA_DIR").unwrap_or_else(|_| "/opt/kashshaf/data".to_string()));
    let bind = std::env::var("KASHSHAF_BIND").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let index_path = data_dir.join("tantivy_index");
    let db_path = data_dir.join("corpus.db");
    let metadata_db_path = data_dir.join("metadata.db");

    // Refuse schemas newer than this build understands; make sure the lookup
    // indexes exist on older schemas (schema 3 ships with both).
    let info = check_corpus_schema_supported(&db_path)?;
    let db_schema_version = info.as_ref().map(|i| i.schema_version);
    let corpus_version = info.as_ref().map(|i| i.corpus_version.clone());
    if db_schema_version.unwrap_or(0) < 3 {
        let conn = rusqlite::Connection::open(&db_path)?;
        let created = ensure_corpus_indexes(&conn)?;
        if !created.is_empty() {
            tracing::info!("created corpus.db indexes: {:?}", created);
        }
    }

    // Exact counts are a desktop-only setting; the server always caps walks.
    let mut config = EngineConfig { exact_counts: false, ..EngineConfig::api_server() };
    // KASHSHAF_MAX_CONCURRENT_WALKS is the documented name (api/deploy/); the
    // shorter KASHSHAF_MAX_WALKS is accepted as an alias.
    let max_walks_env = std::env::var("KASHSHAF_MAX_CONCURRENT_WALKS").or_else(|_| std::env::var("KASHSHAF_MAX_WALKS"));
    if let Some(n) = max_walks_env.ok().and_then(|v| v.parse::<usize>().ok()) {
        config.max_concurrent_walks = n.max(1);
    }
    tracing::info!(
        "walks: max_concurrent={} cap={} budget={}ms prefix_cache={} entries / {} MiB",
        config.max_concurrent_walks,
        config.max_verified_hits,
        config.walk_budget_ms,
        config.prefix_cache_entries,
        config.prefix_cache_bytes / (1024 * 1024)
    );
    let mut search_engine = SearchEngine::open_with_corpus(&index_path, Some(&db_path), config)?;
    let token_cache = Arc::new(TokenCache::new(db_path.clone(), 1000)?);
    search_engine.set_token_cache(token_cache.clone());
    tracing::info!(
        "engine ready: {:?} index, {} docs, {} segments, reading_order={}, codec={}, corpus={:?} schema={:?}",
        search_engine.kind(),
        search_engine.doc_count()?,
        search_engine.segment_count(),
        search_engine.reading_order(),
        token_cache.has_codec(),
        corpus_version,
        db_schema_version
    );

    let warm_enabled = std::env::var("KASHSHAF_WARM_CACHE").map(|v| v == "1").unwrap_or(false);
    let warm_cache = Arc::new(std::sync::atomic::AtomicU8::new(if warm_enabled { WARM_PENDING } else { WARM_DISABLED }));
    let state = Arc::new(AppState {
        search_engine,
        token_cache,
        metadata_db_path,
        corpus_version,
        db_schema_version,
        warm_cache: warm_cache.clone(),
        bulk_limiter: Arc::new(bulk::BulkLimiter::default()),
    });

    // Optional page-cache warm-up: read the index and corpus.db once so the
    // first queries do not pay for cold disk reads. Never blocks readiness.
    if warm_enabled {
        let paths: Vec<PathBuf> = std::fs::read_dir(&index_path)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect::<Vec<PathBuf>>())
            .unwrap_or_default()
            .into_iter()
            .chain(std::iter::once(db_path.clone()))
            .collect();
        let flag = warm_cache.clone();
        std::thread::Builder::new()
            .name("kashshaf-warm".into())
            .spawn(move || {
                warm_page_cache(&paths);
                flag.store(WARM_COMPLETE, std::sync::atomic::Ordering::SeqCst);
            })
            .ok();
    }

    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    // Everything except /health goes through the per-IP rate limiter below.
    // /health is registered on its own router and merged in after the
    // limiter is applied: the deploy (switch_release.sh) polls it every
    // 2-5 s for up to 12 minutes, an uptime monitor polls it too, and a
    // 429 there would read as "not ready" and trigger a false rollback.
    // nginx exempts it for the same reason (no limit_req in location = /health).
    let limited = Router::new()
        .route("/search/status", get(walk_status))
        .route("/search", get(simple_search))
        .route("/search/combined", post(combined_search))
        .route("/search/proximity", post(proximity_search))
        .route("/search/name", post(name_search))
        .route("/search/variants", post(search_variants))
        .route("/search/wildcard", get(wildcard_search))
        .route("/page", get(get_page))
        .route("/page/by-label", get(get_page_by_label))
        .route("/page/tokens", get(get_page_tokens))
        .route("/page/matches", get(get_match_positions))
        .route("/page/with-matches", get(get_page_with_matches))
        .route("/page/matches/combined", post(get_match_positions_combined))
        .route("/page/matches/name", post(get_name_match_positions))
        .route("/books", get(get_all_books))
        .route("/authors", get(get_all_authors))
        .route("/genres", get(get_all_genres));

    // Per-client-IP rate limit, enabled by KASHSHAF_RATE_LIMIT ("1" for the
    // defaults 10 req/s, burst 30; or "<per_second>[,<burst>]"). Off when
    // unset so local runs are unaffected; production sits behind a proxy
    // that limits as well. Applied to `limited` only, never to /health.
    let limited = match rate_limit_from_env() {
        Some((per_second, burst)) => {
            let conf = GovernorConfigBuilder::default()
                .per_millisecond((1000 / per_second.max(1)) as u64)
                .burst_size(burst)
                .key_extractor(SmartIpKeyExtractor)
                .error_handler(|e: GovernorError| -> axum::response::Response {
                    let (status, msg) = match e {
                        GovernorError::TooManyRequests { wait_time, .. } => {
                            (StatusCode::TOO_MANY_REQUESTS, format!("rate limit exceeded; retry in {} s", wait_time))
                        }
                        GovernorError::UnableToExtractKey => {
                            (StatusCode::INTERNAL_SERVER_ERROR, "rate limiter could not read the client address".to_string())
                        }
                        GovernorError::Other { msg, .. } => {
                            (StatusCode::INTERNAL_SERVER_ERROR, msg.unwrap_or_else(|| "rate limiter error".to_string()))
                        }
                    };
                    (status, Json(ErrorResponse { error: msg })).into_response()
                })
                .finish()
                .expect("rate limit configuration");
            tracing::info!("rate limit: {} req/s, burst {}, per client IP (/health exempt)", per_second, burst);
            limited.layer(GovernorLayer { config: Arc::new(conf) })
        }
        None => limited,
    };

    // /book/{id}/tokens is exempt from the per-request limiter (Lab spec
    // §5.1): one legitimate call transfers a whole book and would otherwise
    // burn a client's entire burst. It carries its own per-client caps —
    // 4 concurrent, 30 per hour — inside the handler.
    let app = Router::new()
        .route("/health", get(health))
        .route("/book/:id/tokens", get(bulk::get_book_tokens))
        .merge(limited)
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("Listening on http://{}", bind);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

/// `KASHSHAF_RATE_LIMIT` → (requests per second, burst). Unset, empty, "0" or
/// "off" disables the limiter; "1"/"true"/"on" selects the defaults.
fn rate_limit_from_env() -> Option<(u32, u32)> {
    let raw = std::env::var("KASHSHAF_RATE_LIMIT").ok()?;
    let v = raw.trim().to_ascii_lowercase();
    if v.is_empty() || v == "0" || v == "off" || v == "false" {
        return None;
    }
    if v == "1" || v == "true" || v == "on" {
        return Some((10, 30));
    }
    let nums: Vec<u32> = v.split(|c: char| !c.is_ascii_digit()).filter(|t| !t.is_empty()).filter_map(|t| t.parse().ok()).collect();
    match nums.as_slice() {
        [r] => Some(((*r).max(1), (*r * 3).max(1))),
        [r, b, ..] => Some(((*r).max(1), (*b).max(1))),
        _ => Some((10, 30)),
    }
}

/// Sequentially read every file once (8 MiB chunks) so the OS page cache
/// holds it; logs the volume and the time.
fn warm_page_cache(paths: &[PathBuf]) {
    use std::io::Read;
    let start = std::time::Instant::now();
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    for p in paths {
        let Ok(mut f) = std::fs::File::open(p) else { continue };
        loop {
            match f.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n as u64,
            }
        }
    }
    tracing::info!(
        "page-cache warm-up: read {:.1} GiB from {} files in {:.1} s",
        total as f64 / (1024.0 * 1024.0 * 1024.0),
        paths.len(),
        start.elapsed().as_secs_f64()
    );
}
