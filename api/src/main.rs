mod cache;
mod error;
mod search;
mod tokens;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use cache::TokenCache;
use search::{SearchEngine, SearchFilters, SearchMode, SearchResults, SearchTerm};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokens::{PageKey, Token};
use tower_http::cors::{Any, CorsLayer};

struct AppState {
    search_engine: SearchEngine,
    token_cache: TokenCache,
    db_path: PathBuf,
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
struct PageQuery {
    id: u64,
    part_index: u64,
    page_id: u64,
}

#[derive(Deserialize)]
struct TokensQuery {
    id: u64,
    part_index: u64,
    page_id: u64,
}

#[derive(Deserialize)]
struct MatchPositionsQuery {
    id: u64,
    part_index: u64,
    page_id: u64,
    q: String,
    mode: Option<SearchMode>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    index_docs: u64,
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
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

// === Handlers ===

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let doc_count = state.search_engine.doc_count().unwrap_or(0);
    Json(HealthResponse {
        status: "ok".to_string(),
        index_docs: doc_count,
    })
}

async fn simple_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SimpleSearchQuery>,
) -> Result<Json<SearchResults>, (StatusCode, Json<ErrorResponse>)> {
    let mode = params.mode.unwrap_or(SearchMode::Lemma);
    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let filters = SearchFilters {
        book_ids: params.book_ids.map(|s| {
            s.split(',').filter_map(|id| id.trim().parse().ok()).collect()
        }),
    };

    state.search_engine.search(&params.q, mode, &filters, limit, offset)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn combined_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CombinedSearchRequest>,
) -> Result<Json<SearchResults>, (StatusCode, Json<ErrorResponse>)> {
    let filters = req.filters.unwrap_or_default();
    let limit = req.limit.unwrap_or(50).min(100);
    let offset = req.offset.unwrap_or(0);

    state.search_engine.combined_search(&req.and_terms, &req.or_terms, &filters, limit, offset)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn proximity_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProximitySearchRequest>,
) -> Result<Json<SearchResults>, (StatusCode, Json<ErrorResponse>)> {
    let filters = req.filters.unwrap_or_default();
    let limit = req.limit.unwrap_or(50).min(100);
    let offset = req.offset.unwrap_or(0);

    state.search_engine.proximity_search(&req.term1, &req.term2, req.distance, &filters, limit, offset)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn name_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NameSearchRequest>,
) -> Result<Json<SearchResults>, (StatusCode, Json<ErrorResponse>)> {
    let filters = req.filters.unwrap_or_default();
    let limit = req.limit.unwrap_or(50).min(100);
    let offset = req.offset.unwrap_or(0);

    let patterns_by_form: Vec<Vec<String>> = req.forms.into_iter().map(|f| f.patterns).collect();

    state.search_engine.name_search(&patterns_by_form, &filters, limit, offset)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn wildcard_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WildcardSearchQuery>,
) -> Result<Json<SearchResults>, (StatusCode, Json<ErrorResponse>)> {
    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let filters = SearchFilters {
        book_ids: params.book_ids.map(|s| {
            s.split(',').filter_map(|id| id.trim().parse().ok()).collect()
        }),
    };

    state.search_engine.wildcard_search(&params.q, &filters, limit, offset)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn get_page(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageQuery>,
) -> Result<Json<Option<search::SearchResult>>, (StatusCode, Json<ErrorResponse>)> {
    state.search_engine.get_page(params.id, params.part_index, params.page_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn get_page_tokens(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokensQuery>,
) -> Result<Json<Vec<Token>>, (StatusCode, Json<ErrorResponse>)> {
    let key = PageKey::new(params.id, params.part_index, params.page_id);
    state.token_cache.get(&key)
        .map(|tokens| Json((*tokens).clone()))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn get_match_positions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MatchPositionsQuery>,
) -> Result<Json<Vec<u32>>, (StatusCode, Json<ErrorResponse>)> {
    let mode = params.mode.unwrap_or(SearchMode::Lemma);
    state.search_engine.get_match_positions(params.id, params.part_index, params.page_id, &params.q, mode)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))
}

async fn get_all_books(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<BookMetadata>>, (StatusCode, Json<ErrorResponse>)> {
    let conn = rusqlite::Connection::open(&state.db_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let mut stmt = conn.prepare(
        "SELECT id, corpus, title, author_id, death_ah, century_ah, genre_id, page_count, token_count,
                original_id, paginated, tags, book_meta, author_meta
         FROM books ORDER BY death_ah ASC NULLS LAST, id ASC"
    ).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let books = stmt.query_map([], |row| {
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
        })
    }).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(books))
}

async fn get_all_authors(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<(i64, String)>>, (StatusCode, Json<ErrorResponse>)> {
    let conn = rusqlite::Connection::open(&state.db_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let mut stmt = conn.prepare("SELECT id, author FROM authors ORDER BY id")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let authors = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(authors))
}

async fn get_all_genres(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<(i64, String)>>, (StatusCode, Json<ErrorResponse>)> {
    let conn = rusqlite::Connection::open(&state.db_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let mut stmt = conn.prepare("SELECT id, genre FROM genres ORDER BY id")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?;

    let genres = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() })))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(genres))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let index_path = PathBuf::from("/opt/kashshaf/data/tantivy_index");
    let db_path = PathBuf::from("/opt/kashshaf/data/corpus.db");

    let search_engine = SearchEngine::open(&index_path)?;
    let token_cache = TokenCache::new(db_path.clone(), 1000);

    let state = Arc::new(AppState {
        search_engine,
        token_cache,
        db_path,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/search", get(simple_search))
        .route("/search/combined", post(combined_search))
        .route("/search/proximity", post(proximity_search))
        .route("/search/name", post(name_search))
        .route("/search/wildcard", get(wildcard_search))
        .route("/page", get(get_page))
        .route("/page/tokens", get(get_page_tokens))
        .route("/page/matches", get(get_match_positions))
        .route("/books", get(get_all_books))
        .route("/authors", get(get_all_authors))
        .route("/genres", get(get_all_genres))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    tracing::info!("Listening on http://127.0.0.1:3000");
    axum::serve(listener, app).await?;

    Ok(())
}
