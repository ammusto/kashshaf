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
    ProximityQuery, SearchEngine, SearchFilters, SearchMode, SearchResult, SearchResults, SearchTerm, Token, TokenCache,
    VariantsResponse, WalkStatus, WildcardGrammar, MAX_SUPPORTED_DB_SCHEMA,
};
use kashshaf_engine::memory::process_memory;
use axum::response::IntoResponse;
use std::net::SocketAddr;
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorError, GovernorLayer};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
    /// `toc.db` beside the corpus, when the published corpus has one (Lab
    /// spec 1.5 B2). `None` on a corpus that predates it; the route then
    /// answers 404 with the reason and `/health.toc` is false.
    toc: Option<kashshaf_engine::TocDb>,
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
/// Since 0.7.0 a chain: `terms` (two or three), `distances` (one per
/// link), `ordered`, and `and_terms` (up to two, each with its mode) that
/// must be on the page. The two-term form `term1`/`term2`/`distance` is
/// still read, as the pair it always was.
struct ProximitySearchRequest {
    #[serde(default)]
    terms: Vec<SearchTerm>,
    #[serde(default)]
    distances: Vec<usize>,
    #[serde(default)]
    ordered: bool,
    #[serde(default)]
    and_terms: Vec<SearchTerm>,
    term1: Option<SearchTerm>,
    term2: Option<SearchTerm>,
    distance: Option<usize>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
}

impl ProximitySearchRequest {
    fn query(self) -> Result<(ProximityQuery, Option<SearchFilters>, Option<usize>, Option<usize>), ApiError> {
        let q = if !self.terms.is_empty() {
            ProximityQuery { terms: self.terms, distances: self.distances, ordered: self.ordered, and_terms: self.and_terms }
        } else {
            match (self.term1, self.term2, self.distance) {
                (Some(a), Some(b), Some(d)) => ProximityQuery::pair(&a, &b, d),
                _ => return Err(bad_request("a proximity search needs terms and distances, or term1, term2 and distance")),
            }
        };
        q.validate().map_err(bad_request)?;
        Ok((q, self.filters, self.limit, self.offset))
    }
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
    /// The patterns are the form's displayed ones (a kunya as `اب* …`, no
    /// proclitics) and the server expands them (0.7.0). A client from
    /// before sends the expanded list and leaves this off.
    #[serde(default)]
    expand: bool,
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
    /// As for `/search/name`: displayed patterns, expanded here.
    #[serde(default)]
    expand: bool,
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
    /// This server has `toc.db`, so `GET /book/{id}/toc` answers (Lab spec 1.5 B2).
    toc: bool,
    /// Matches across page breaks are found: the corpus ships `boundary_index/` (4.3.0).
    boundary_index: bool,
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

#[derive(Debug, Serialize)]
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
        toc: state.toc.is_some(),
        boundary_index: state.search_engine.has_boundary_index(),
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
    let (q, filters, limit, offset) = req.query()?;
    let filters = filters.unwrap_or_default();
    state
        .search_engine
        .proximity_chain_search(&q, &filters, clamp_limit(limit), offset.unwrap_or(0))
        .map(Json)
        .map_err(internal)
}

async fn name_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NameSearchRequest>,
) -> Result<Json<SearchResults>, ApiError> {
    let filters = req.filters.unwrap_or_default();
    let patterns_by_form: Vec<Vec<String>> = req
        .forms
        .into_iter()
        .map(|f| if f.expand { kashshaf_engine::expand_name_patterns(&f.patterns) } else { f.patterns })
        .collect();
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

/// `/page` with `include=tokens` and/or highlight terms: the page, its
/// tokens and its highlights in one response, so the reader makes one
/// request per page rather than three (0.6.0). Without those parameters
/// the route answers as it always has, a bare page.
#[derive(Serialize)]
struct PageBundle {
    page: SearchResult,
    /// Present when `include=tokens` was asked for.
    tokens: Option<Vec<Token>>,
    /// Present when `q`/`mode` pairs or `name` patterns were given: the
    /// token indices to highlight, or none of them.
    matches: Option<Vec<u32>>,
    /// A match runs in from the page before / out onto the page after
    /// (corpus 4.3.0's boundary index; false without it).
    continues_prev: bool,
    continues_next: bool,
    /// Present when `and_q`/`and_mode` pairs were given (a proximity
    /// search's page-level terms): their positions, for a second colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    and_matches: Option<Vec<u32>>,
}

/// The reader's page parameters, read by hand because `q`, `mode` and
/// `name` repeat: one `q`/`mode` pair per search term of a combined search,
/// one `name` per *displayed* pattern of a name search — the form's short
/// list, which the server expands with the search's own rule
/// (`expand_name_patterns`), so the request stays under 2 KB. A client
/// that sends the expanded list instead gets a superset that matches the
/// same tokens.
struct PageParams {
    id: u64,
    part_index: u64,
    page_id: u64,
    tokens: bool,
    terms: Vec<SearchTerm>,
    /// A proximity search's page-level terms, highlighted apart.
    and_terms: Vec<SearchTerm>,
    names: Vec<String>,
}

fn page_params(pairs: &[(String, String)]) -> Result<PageParams, ApiError> {
    let mut id = None;
    let mut part_index = 0;
    let mut page_id = None;
    let mut tokens = false;
    let mut queries: Vec<String> = Vec::new();
    let mut modes: Vec<SearchMode> = Vec::new();
    let mut and_queries: Vec<String> = Vec::new();
    let mut and_modes: Vec<SearchMode> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let bad = |what: &str, v: &str| bad_request(format!("{what}: {v:?}"));
    let mode_of = |v: &str| -> Result<SearchMode, ApiError> {
        Ok(match v {
            "surface" => SearchMode::Surface,
            "lemma" => SearchMode::Lemma,
            "root" => SearchMode::Root,
            _ => return Err(bad("mode", v)),
        })
    };
    for (k, v) in pairs {
        match k.as_str() {
            "id" => id = Some(v.parse::<u64>().map_err(|_| bad("id", v))?),
            "part_index" => part_index = v.parse::<u64>().map_err(|_| bad("part_index", v))?,
            "page_id" => page_id = Some(v.parse::<u64>().map_err(|_| bad("page_id", v))?),
            "include" => tokens |= v.split(',').any(|x| x.trim() == "tokens"),
            "q" => queries.push(v.clone()),
            "mode" => modes.push(mode_of(v)?),
            "and_q" => and_queries.push(v.clone()),
            "and_mode" => and_modes.push(mode_of(v)?),
            "name" => names.push(v.clone()),
            _ => {}
        }
    }
    let pair_up = |qs: Vec<String>, ms: &[SearchMode]| -> Vec<SearchTerm> {
        qs.into_iter()
            .enumerate()
            .filter(|(_, q)| !q.trim().is_empty())
            .map(|(i, query)| SearchTerm { query, mode: ms.get(i).copied().unwrap_or(SearchMode::Lemma) })
            .collect()
    };
    let terms = pair_up(queries, &modes);
    let and_terms = pair_up(and_queries, &and_modes);
    Ok(PageParams {
        id: id.ok_or_else(|| bad_request("id is required"))?,
        part_index,
        page_id: page_id.ok_or_else(|| bad_request("page_id is required"))?,
        tokens,
        terms,
        and_terms,
        names,
    })
}

async fn get_page(
    State(state): State<Arc<AppState>>,
    Query(pairs): Query<Vec<(String, String)>>,
) -> Result<axum::response::Response, ApiError> {
    let p = page_params(&pairs)?;
    page_response(&state, p)
}

/// `POST /page` with the same parameters as a JSON body: the client's guard
/// for a request that would not fit a URL (over 2 KB). With the displayed
/// name patterns it never should; the route is there so that it cannot fail.
#[derive(Deserialize)]
struct PageBody {
    id: u64,
    #[serde(default)]
    part_index: u64,
    page_id: u64,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    terms: Vec<SearchTerm>,
    #[serde(default)]
    and_terms: Vec<SearchTerm>,
    #[serde(default)]
    names: Vec<String>,
}

async fn post_page(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PageBody>,
) -> Result<axum::response::Response, ApiError> {
    let p = PageParams {
        id: body.id,
        part_index: body.part_index,
        page_id: body.page_id,
        tokens: body.include.iter().any(|x| x == "tokens"),
        terms: body.terms.into_iter().filter(|t| !t.query.trim().is_empty()).collect(),
        and_terms: body.and_terms.into_iter().filter(|t| !t.query.trim().is_empty()).collect(),
        names: body.names,
    };
    page_response(&state, p)
}

fn page_response(state: &AppState, p: PageParams) -> Result<axum::response::Response, ApiError> {
    let page = state.search_engine.get_page(p.id, p.part_index, p.page_id).map_err(internal)?;
    let bundled = p.tokens || !p.terms.is_empty() || !p.and_terms.is_empty() || !p.names.is_empty();
    if !bundled {
        return Ok(Json(page).into_response());
    }
    let Some(page) = page else {
        return Ok(Json(None::<PageBundle>).into_response());
    };
    let key = PageKey::new(p.id, p.part_index, p.page_id);
    let tokens = if p.tokens {
        Some(state.token_cache.get(&key).map(|t| (*t).clone()).map_err(internal)?)
    } else {
        None
    };
    let (matches, continues_prev, continues_next) = if !p.names.is_empty() {
        let names = kashshaf_engine::expand_name_patterns(&p.names);
        (Some(state.search_engine.get_name_match_positions(p.id, p.part_index, p.page_id, &names).map_err(internal)?), false, false)
    } else if !p.terms.is_empty() {
        let m = state.search_engine.get_page_matches(p.id, p.part_index, p.page_id, &p.terms).map_err(internal)?;
        (Some(m.indices), m.continues_prev, m.continues_next)
    } else {
        (None, false, false)
    };
    let and_matches = if p.and_terms.is_empty() {
        None
    } else {
        Some(state.search_engine.get_match_positions_combined(p.id, p.part_index, p.page_id, &p.and_terms).map_err(internal)?)
    };
    Ok(Json(Some(PageBundle { page, tokens, matches, continues_prev, continues_next, and_matches })).into_response())
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

/// A bare array, as it has always been: a 0.6.0 client reads this route on
/// its fallback path and would break on anything else. Whether a match runs
/// off the page's edge (corpus 4.3.0's boundary index) is on the `/page`
/// bundle only.
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
    let patterns = if req.expand { kashshaf_engine::expand_name_patterns(&req.patterns) } else { req.patterns };
    state
        .search_engine
        .get_name_match_positions(req.id, req.part_index, req.page_id, &patterns)
        .map(Json)
        .map_err(internal)
}

/// `GET /book/{id}/pages` - the book's spine in reading order: one entry per
/// page with its coordinates and printed labels. The reader's continuous
/// scroll pages through it, so it is fetched once per book rather than a
/// neighbour lookup per page. A few thousand small entries at most.
async fn get_book_pages(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<u64>,
) -> Result<Json<Vec<kashshaf_engine::PageEntry>>, ApiError> {
    state.search_engine.book_pages(id).map(Json).map_err(internal)
}

/// `GET /book/{id}/toc` - the book's table of contents as a tree (Lab spec
/// 1.5 B2). Tiny JSON: a few hundred entries at most, so it is neither
/// compressed nor rate-limited beyond the per-request layer.
async fn get_book_toc(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<u64>,
) -> Result<Json<Vec<kashshaf_engine::TocNode>>, ApiError> {
    let toc = state.toc.as_ref().ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "this server's corpus has no toc.db".to_string() }),
        )
    })?;
    Ok(Json(toc.tree(id).map_err(internal)?))
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
    let toc = match kashshaf_engine::TocDb::open_in(&data_dir) {
        Ok(t) => {
            println!("toc.db: {} books with a table of contents", t.book_count().unwrap_or(0));
            Some(t)
        }
        Err(e) => {
            println!("toc.db unavailable: {e}");
            None
        }
    };

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
        toc,
    });

    // Optional page-cache warm-up: read the index and corpus.db once so the
    // first queries do not pay for cold disk reads. Never blocks readiness.
    if warm_enabled {
        // The main index, the boundary index beside it (4.3.0; absent on an
        // older corpus), and corpus.db: every file a query reads.
        let files_in = |dir: &Path| -> Vec<PathBuf> {
            std::fs::read_dir(dir)
                .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect::<Vec<PathBuf>>())
                .unwrap_or_default()
        };
        let paths: Vec<PathBuf> = files_in(&index_path)
            .into_iter()
            .chain(files_in(&data_dir.join(kashshaf_engine::boundary::DIR_NAME)))
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

    // CORS is the outermost layer, below at the end of the chain: a 429 from
    // either limiter passes back through it and carries the CORS headers,
    // so a browser can read the status and Retry-After instead of reporting
    // a CORS failure it cannot act on.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([axum::http::header::RETRY_AFTER]);

    // Two per-IP buckets. Searches are the expensive calls and keep the
    // strict limit (KASHSHAF_RATE_LIMIT, 10 req/s burst 30). The reader's
    // calls — a page, the spine, the contents — are cheap and come in
    // runs as a book is scrolled, so they have a bucket of their own
    // (KASHSHAF_RATE_LIMIT_READER, 60 req/s burst 120); before 0.6.0 a
    // scroll through a few pages emptied the strict bucket. /health is on
    // neither: the deploy (switch_release.sh) polls it every 2-5 s for up
    // to 12 minutes, an uptime monitor polls it too, and a 429 there would
    // read as "not ready" and trigger a false rollback. nginx exempts it for
    // the same reason (no limit_req in location = /health).
    let searches = Router::new()
        .route("/search/status", get(walk_status))
        .route("/search", get(simple_search))
        .route("/search/combined", post(combined_search))
        .route("/search/proximity", post(proximity_search))
        .route("/search/name", post(name_search))
        .route("/search/variants", post(search_variants))
        .route("/search/wildcard", get(wildcard_search))
        .route("/books", get(get_all_books))
        .route("/authors", get(get_all_authors))
        .route("/genres", get(get_all_genres));
    let reader = Router::new()
        .route("/page", get(get_page).post(post_page))
        .route("/page/by-label", get(get_page_by_label))
        .route("/page/tokens", get(get_page_tokens))
        .route("/page/matches", get(get_match_positions))
        .route("/page/with-matches", get(get_page_with_matches))
        .route("/page/matches/combined", post(get_match_positions_combined))
        .route("/page/matches/name", post(get_name_match_positions))
        .route("/book/:id/pages", get(get_book_pages))
        .route("/book/:id/toc", get(get_book_toc));

    // One per-IP bucket. A 429 says how long to wait in `Retry-After` (whole
    // seconds, at least 1) as well as in the body, since that header is what a
    // browser client backs off by. A closure, as the config's type names
    // private middleware types and cannot be written out.
    let governor = |per_second: u32, burst: u32| {
    GovernorConfigBuilder::default()
        .per_millisecond((1000 / per_second.max(1)) as u64)
        .burst_size(burst)
        .key_extractor(SmartIpKeyExtractor)
        .error_handler(|e: GovernorError| -> axum::response::Response {
            match e {
                GovernorError::TooManyRequests { wait_time, .. } => {
                    let wait = wait_time.max(1);
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(axum::http::header::RETRY_AFTER, wait.to_string())],
                        Json(ErrorResponse { error: format!("rate limit exceeded; retry in {} s", wait) }),
                    )
                        .into_response()
                }
                GovernorError::UnableToExtractKey => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse { error: "rate limiter could not read the client address".to_string() }),
                )
                    .into_response(),
                GovernorError::Other { msg, .. } => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse { error: msg.unwrap_or_else(|| "rate limiter error".to_string()) }),
                )
                    .into_response(),
            }
        })
        .finish()
        .expect("rate limit configuration")
    };

    let (searches, reader) = match rate_limit_from_env() {
        Some((per_second, burst)) => {
            let (reader_per_second, reader_burst) = reader_rate_limit_from_env();
            tracing::info!(
                "rate limit per client IP: searches {} req/s burst {}; reader {} req/s burst {} (/health exempt)",
                per_second,
                burst,
                reader_per_second,
                reader_burst
            );
            (
                searches.layer(GovernorLayer { config: Arc::new(governor(per_second, burst)) }),
                reader.layer(GovernorLayer { config: Arc::new(governor(reader_per_second, reader_burst)) }),
            )
        }
        None => (searches, reader),
    };

    // /book/{id}/tokens is exempt from the per-request limiter (Lab spec
    // §5.1): one legitimate call transfers a whole book and would otherwise
    // burn a client's entire burst. It carries its own per-client caps —
    // 4 concurrent, 30 per hour — inside the handler.
    let app = Router::new()
        .route("/health", get(health))
        .route("/book/:id/tokens", get(bulk::get_book_tokens))
        .merge(searches)
        .merge(reader)
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("Listening on http://{}", bind);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

/// `KASHSHAF_RATE_LIMIT_READER` → the reader bucket, "<per_second>[,<burst>]";
/// 60 req/s, burst 120 when unset. Only consulted while the limiter is on.
fn reader_rate_limit_from_env() -> (u32, u32) {
    let raw = std::env::var("KASHSHAF_RATE_LIMIT_READER").unwrap_or_default();
    let mut it = raw.split(',').map(|s| s.trim().parse::<u32>().ok());
    match (it.next().flatten(), it.next().flatten()) {
        (Some(p), Some(b)) if p > 0 => (p, b.max(1)),
        (Some(p), None) if p > 0 => (p, p * 2),
        _ => (60, 120),
    }
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

#[cfg(test)]
mod proximity_request_tests {
    use super::*;

    fn term(q: &str) -> SearchTerm {
        SearchTerm { query: q.to_string(), mode: SearchMode::Surface }
    }

    #[test]
    fn the_old_two_term_body_is_the_pair_it_always_was() {
        let req: ProximitySearchRequest =
            serde_json::from_str(r#"{"term1":{"query":"قال","mode":"surface"},"term2":{"query":"الله","mode":"lemma"},"distance":5}"#).unwrap();
        let (q, _, _, _) = req.query().unwrap();
        assert!(q.is_plain_pair());
        assert_eq!(q.terms.len(), 2);
        assert_eq!(q.distances, vec![5]);
        assert_eq!(q.terms[1].mode, SearchMode::Lemma);
    }

    #[test]
    fn a_chain_body_is_read_with_its_ordering_and_page_terms() {
        let req: ProximitySearchRequest = serde_json::from_str(
            r#"{"terms":[{"query":"a","mode":"surface"},{"query":"b","mode":"surface"},{"query":"c","mode":"root"}],
                "distances":[3,4],"ordered":true,"and_terms":[{"query":"x","mode":"lemma"}],"limit":10}"#,
        )
        .unwrap();
        let (q, _, limit, _) = req.query().unwrap();
        assert_eq!(q.terms.len(), 3);
        assert_eq!(q.distances, vec![3, 4]);
        assert!(q.ordered);
        assert_eq!(q.and_terms, vec![SearchTerm { mode: SearchMode::Lemma, ..term("x") }]);
        assert_eq!(limit, Some(10));
    }

    #[test]
    fn a_bad_chain_is_a_bad_request() {
        for body in [
            r#"{"terms":[{"query":"a","mode":"surface"}],"distances":[]}"#,
            r#"{"terms":[{"query":"a","mode":"surface"},{"query":"b","mode":"surface"}],"distances":[1,2]}"#,
            r#"{"terms":[{"query":"a","mode":"surface"},{"query":"b","mode":"surface"},{"query":"c","mode":"surface"},{"query":"d","mode":"surface"}],"distances":[1,2,3]}"#,
            r#"{"terms":[{"query":"a","mode":"surface"},{"query":"b","mode":"surface"}],"distances":[1],"and_terms":[{"query":"x","mode":"surface"},{"query":"y","mode":"surface"},{"query":"z","mode":"surface"}]}"#,
            r#"{"term1":{"query":"a","mode":"surface"},"distance":1}"#,
        ] {
            let req: ProximitySearchRequest = serde_json::from_str(body).unwrap();
            let (status, _) = req.query().err().expect(body);
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[test]
    fn the_page_bundle_reads_page_terms_apart_from_the_chain() {
        let pairs: Vec<(String, String)> = [
            ("id", "1"), ("page_id", "7"), ("q", "a"), ("mode", "surface"), ("q", "b"), ("mode", "root"),
            ("and_q", "x"), ("and_mode", "lemma"), ("and_q", " "), ("and_mode", "surface"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let p = page_params(&pairs).unwrap();
        assert_eq!(p.terms.len(), 2);
        assert_eq!(p.terms[1].mode, SearchMode::Root);
        assert_eq!(p.and_terms, vec![SearchTerm { query: "x".into(), mode: SearchMode::Lemma }]);
    }
}
