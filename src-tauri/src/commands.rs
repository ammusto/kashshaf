//! Tauri commands for frontend communication

use anyhow;
use kashshaf_lib::error::KashshafError;
use kashshaf_lib::search::{
    validate_wildcard_query, PageWithMatches, SearchFilters, SearchMode, SearchResult,
    SearchResults, SearchTerm,
};
use kashshaf_lib::state::AppState;
use kashshaf_lib::tokens::{Token, TokenField};
use rusqlite::{OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Manager, State};

/// Type alias for managed app state (allows hot-reloading after corpus download)
pub type ManagedAppState = Arc<RwLock<Option<Arc<AppState>>>>;

/// Helper to get AppState or return error if not ready
fn require_state(state: &ManagedAppState) -> Result<Arc<AppState>, KashshafError> {
    let guard = state
        .read()
        .map_err(|_| KashshafError::Other("Failed to acquire state lock".to_string()))?;
    guard.clone().ok_or_else(|| {
        KashshafError::CorpusNotReady(
            "Corpus data not downloaded. Please download the corpus first.".to_string(),
        )
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub id: i64,
    pub corpus: Option<String>,
    pub title: String,
    pub author_id: Option<i64>,
    pub death_ah: Option<i64>,
    pub century_ah: Option<i64>,
    pub genre_id: Option<i64>,
    pub page_count: Option<i64>,
    pub token_count: Option<i64>,
    pub original_id: Option<String>,
    pub paginated: Option<bool>,
    pub tags: Option<String>,        // JSON array as string
    pub book_meta: Option<String>,   // JSON array as string
    pub author_meta: Option<String>, // JSON array as string
}

const BOOK_COLUMNS: &str = "id, corpus, title, author_id, death_ah, century_ah, genre_id, page_count, token_count, original_id, paginated, tags, book_meta, author_meta";

fn row_to_book(row: &Row) -> rusqlite::Result<BookMetadata> {
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
}

#[tauri::command]
pub async fn search(
    state: State<'_, ManagedAppState>,
    query: String,
    mode: Option<SearchMode>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResults, KashshafError> {
    let app_state = require_state(&state)?;
    let mode = mode.unwrap_or_default();
    let filters = filters.unwrap_or_default();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    // Clone what we need for the blocking task
    let search_engine = app_state.search_engine.clone();

    // Run CPU-intensive search on blocking thread pool to keep UI responsive
    tokio::task::spawn_blocking(move || {
        search_engine
            .search(&query, mode, &filters, limit, offset)
            .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
    })
    .await
    .map_err(|e| KashshafError::Search(format!("Task join error: {}", e)))?
}

#[tauri::command]
pub fn get_page(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
) -> Result<Option<SearchResult>, KashshafError> {
    let app_state = require_state(&state)?;
    app_state
        .search_engine
        .get_page(id, part_index, page_id)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

fn normalize_arabic_for_search(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0671}' => None,
            'أ' | 'إ' | 'آ' => Some('ا'),
            'ؤ' => Some('و'),
            'ئ' | 'ى' => Some('ي'),
            'ک' | 'گ' | 'ڭ' => Some('ك'),
            'ی' | 'ے' => Some('ي'),
            'ۀ' | 'ە' => Some('ه'),
            'ۃ' => Some('ة'),
            'ٹ' => Some('ت'),
            'پ' => Some('ب'),
            'چ' => Some('ج'),
            'ژ' => Some('ز'),
            'ڤ' => Some('ف'),
            'ڨ' => Some('ق'),
            _ => Some(c),
        })
        .collect()
}

/// Load all book metadata at once - for caching in frontend
/// Returns ~850KB for 4,336 books (~200 bytes each)
#[tauri::command]
pub fn get_all_books(
    state: State<'_, ManagedAppState>,
) -> Result<Vec<BookMetadata>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM books ORDER BY death_ah ASC NULLS LAST, id ASC",
            BOOK_COLUMNS
        ))
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let books = stmt
        .query_map([], row_to_book)
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(books)
}

#[tauri::command]
pub fn list_books(
    state: State<'_, ManagedAppState>,
    genre_id: Option<i64>,
    corpus: Option<String>,
    century_ah: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<BookMetadata>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    let mut sql = format!("SELECT {} FROM books WHERE 1=1", BOOK_COLUMNS);

    if genre_id.is_some() {
        sql.push_str(" AND genre_id = ?1");
    }
    if corpus.is_some() {
        sql.push_str(" AND corpus = ?2");
    }
    if century_ah.is_some() {
        sql.push_str(" AND century_ah = ?3");
    }

    sql.push_str(" ORDER BY id LIMIT ?4 OFFSET ?5");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let books = stmt
        .query_map(
            rusqlite::params![
                genre_id,
                corpus.as_deref(),
                century_ah,
                limit,
                offset
            ],
            row_to_book,
        )
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(books)
}

#[tauri::command]
pub fn list_books_filtered(
    state: State<'_, ManagedAppState>,
    death_ah_min: Option<i64>,
    death_ah_max: Option<i64>,
    genre_ids: Option<Vec<i64>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<BookMetadata>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;
    let limit = limit.unwrap_or(10000);
    let offset = offset.unwrap_or(0);

    // Build query dynamically
    let mut sql = format!("SELECT {} FROM books WHERE 1=1", BOOK_COLUMNS);
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut param_idx = 1;

    // Date range filter
    if let Some(min) = death_ah_min {
        sql.push_str(&format!(" AND death_ah >= ?{}", param_idx));
        params.push(Box::new(min));
        param_idx += 1;
    }
    if let Some(max) = death_ah_max {
        sql.push_str(&format!(" AND death_ah <= ?{}", param_idx));
        params.push(Box::new(max));
        param_idx += 1;
    }

    // Genre filter (multiple genre IDs with OR)
    if let Some(ref genre_id_list) = genre_ids {
        if !genre_id_list.is_empty() {
            let placeholders: Vec<String> = genre_id_list
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", param_idx + i))
                .collect();
            sql.push_str(&format!(" AND genre_id IN ({})", placeholders.join(",")));
            for g in genre_id_list {
                params.push(Box::new(*g));
            }
            param_idx += genre_id_list.len();
        }
    }

    sql.push_str(&format!(
        " ORDER BY death_ah ASC NULLS LAST, id ASC LIMIT ?{} OFFSET ?{}",
        param_idx,
        param_idx + 1
    ));
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let books = stmt
        .query_map(param_refs.as_slice(), row_to_book)
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(books)
}

#[tauri::command]
pub fn search_authors(
    state: State<'_, ManagedAppState>,
    query: String,
) -> Result<Vec<(i64, String, i64, i64)>, KashshafError> {
    let app_state = require_state(&state)?;
    if query.len() < 3 {
        return Ok(Vec::new());
    }

    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    // Join authors with books to get death_ah and book_count
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.author, MIN(b.death_ah) as earliest_death, COUNT(b.id) as book_count
             FROM authors a
             LEFT JOIN books b ON b.author_id = a.id
             GROUP BY a.id, a.author
             ORDER BY earliest_death ASC NULLS LAST"
        )
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let normalized_query = normalize_arabic_for_search(&query).to_lowercase();

    let authors: Vec<(i64, String, i64, i64)> = stmt
        .query_map([], |row: &Row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .filter_map(|r| r.ok())
        .filter(|(_, author, _, _)| {
            let normalized_author = normalize_arabic_for_search(author).to_lowercase();
            normalized_author.contains(&normalized_query)
        })
        .take(50)
        .collect();

    Ok(authors)
}

#[tauri::command]
pub fn get_book(
    state: State<'_, ManagedAppState>,
    id: i64,
) -> Result<Option<BookMetadata>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM books WHERE id = ?", BOOK_COLUMNS))
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let book = stmt
        .query_row([id], row_to_book)
        .optional()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(book)
}

#[tauri::command]
pub fn get_genres(state: State<'_, ManagedAppState>) -> Result<Vec<(i64, String)>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT id, genre FROM genres ORDER BY id")
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let genres = stmt
        .query_map([], |row: &Row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(genres)
}

#[tauri::command]
pub fn get_authors(state: State<'_, ManagedAppState>) -> Result<Vec<(i64, String)>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT id, author FROM authors ORDER BY id")
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let authors = stmt
        .query_map([], |row: &Row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(authors)
}

#[tauri::command]
pub fn get_centuries(state: State<'_, ManagedAppState>) -> Result<Vec<(i64, i64)>, KashshafError> {
    let app_state = require_state(&state)?;
    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT century_ah, COUNT(*) as count FROM books WHERE century_ah IS NOT NULL GROUP BY century_ah ORDER BY century_ah")
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let centuries = stmt
        .query_map([], |row: &Row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(centuries)
}

#[tauri::command]
pub fn get_stats(state: State<'_, ManagedAppState>) -> Result<serde_json::Value, KashshafError> {
    let app_state = require_state(&state)?;
    let doc_count = app_state
        .search_engine
        .doc_count()
        .map_err(|e: anyhow::Error| KashshafError::Index(e.to_string()))?;

    let conn = app_state
        .get_db_connection()
        .map_err(|e: anyhow::Error| KashshafError::Database(e.to_string()))?;
    let book_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books", [], |row: &Row| row.get(0))
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let (cache_size, cache_capacity) = app_state.token_cache.stats();

    Ok(serde_json::json!({
        "indexed_pages": doc_count,
        "total_books": book_count,
        "token_cache_size": cache_size,
        "token_cache_capacity": cache_capacity,
    }))
}

fn token_field_to_search_mode(field: TokenField) -> SearchMode {
    match field {
        TokenField::Surface => SearchMode::Surface,
        TokenField::Lemma => SearchMode::Lemma,
        TokenField::Root => SearchMode::Root,
    }
}

#[tauri::command]
pub async fn proximity_search(
    state: State<'_, ManagedAppState>,
    term1: String,
    field1: TokenField,
    term2: String,
    field2: TokenField,
    distance: usize,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResults, KashshafError> {
    let app_state = require_state(&state)?;
    let search_term1 = SearchTerm {
        query: term1,
        mode: token_field_to_search_mode(field1),
    };
    let search_term2 = SearchTerm {
        query: term2,
        mode: token_field_to_search_mode(field2),
    };

    let filters = filters.unwrap_or_default();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    let search_engine = app_state.search_engine.clone();

    tokio::task::spawn_blocking(move || {
        search_engine
            .proximity_search(
                &search_term1,
                &search_term2,
                distance,
                &filters,
                limit,
                offset,
            )
            .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
    })
    .await
    .map_err(|e| KashshafError::Search(format!("Task join error: {}", e)))?
}

#[tauri::command]
pub fn get_page_tokens(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
) -> Result<Vec<Token>, KashshafError> {
    use kashshaf_lib::tokens::PageKey;
    let app_state = require_state(&state)?;
    let key = PageKey::new(id, part_index, page_id);
    let tokens = app_state
        .token_cache
        .get(&key)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))?;
    Ok((*tokens).clone())
}

#[tauri::command]
pub fn get_token_at(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
    idx: usize,
) -> Result<Option<Token>, KashshafError> {
    use kashshaf_lib::tokens::PageKey;
    let app_state = require_state(&state)?;
    let key = PageKey::new(id, part_index, page_id);
    app_state
        .token_cache
        .get_token_at(&key, idx)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

#[tauri::command]
pub fn get_cache_stats(state: State<'_, ManagedAppState>) -> Result<(usize, usize), KashshafError> {
    let app_state = require_state(&state)?;
    Ok(app_state.token_cache.stats())
}

#[tauri::command]
pub fn clear_token_cache(state: State<'_, ManagedAppState>) -> Result<(), KashshafError> {
    let app_state = require_state(&state)?;
    app_state.token_cache.clear();
    Ok(())
}

#[tauri::command]
pub fn get_match_positions(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
    query: String,
    mode: SearchMode,
) -> Result<Vec<u32>, KashshafError> {
    let app_state = require_state(&state)?;
    app_state
        .search_engine
        .get_match_positions(id, part_index, page_id, &query, mode)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

#[tauri::command]
pub fn get_match_positions_combined(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
    terms: Vec<SearchTerm>,
) -> Result<Vec<u32>, KashshafError> {
    let app_state = require_state(&state)?;
    app_state
        .search_engine
        .get_match_positions_combined(id, part_index, page_id, &terms)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

#[tauri::command]
pub fn get_page_with_matches(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
    query: String,
    mode: SearchMode,
) -> Result<Option<PageWithMatches>, KashshafError> {
    let app_state = require_state(&state)?;
    app_state
        .search_engine
        .get_page_with_matches(id, part_index, page_id, &query, mode)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

#[tauri::command]
pub async fn combined_search(
    state: State<'_, ManagedAppState>,
    and_terms: Vec<SearchTerm>,
    or_terms: Vec<SearchTerm>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResults, KashshafError> {
    let app_state = require_state(&state)?;
    let filters = filters.unwrap_or_default();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    let search_engine = app_state.search_engine.clone();

    tokio::task::spawn_blocking(move || {
        search_engine
            .combined_search(&and_terms, &or_terms, &filters, limit, offset)
            .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
    })
    .await
    .map_err(|e| KashshafError::Search(format!("Task join error: {}", e)))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameSearchForm {
    pub patterns: Vec<String>,
}

#[tauri::command]
pub async fn name_search(
    state: State<'_, ManagedAppState>,
    forms: Vec<NameSearchForm>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResults, KashshafError> {
    let app_state = require_state(&state)?;
    let filters = filters.unwrap_or_default();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    // Convert forms to the format expected by the search engine
    let patterns_by_form: Vec<Vec<String>> = forms.into_iter().map(|f| f.patterns).collect();

    let search_engine = app_state.search_engine.clone();

    tokio::task::spawn_blocking(move || {
        search_engine
            .name_search(&patterns_by_form, &filters, limit, offset)
            .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
    })
    .await
    .map_err(|e| KashshafError::Search(format!("Task join error: {}", e)))?
}

#[tauri::command]
pub fn get_name_match_positions(
    state: State<'_, ManagedAppState>,
    id: u64,
    part_index: u64,
    page_id: u64,
    patterns: Vec<String>,
) -> Result<Vec<u32>, KashshafError> {
    let app_state = require_state(&state)?;
    app_state
        .search_engine
        .get_name_match_positions(id, part_index, page_id, &patterns)
        .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))
}

/// Wildcard search - searches for Arabic text with * wildcards
/// Only works in Surface mode
/// Rules:
/// - One * per search input
/// - * cannot be at start of word
/// - Internal * requires 2+ chars before it
#[tauri::command]
pub async fn wildcard_search(
    state: State<'_, ManagedAppState>,
    query: String,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResults, KashshafError> {
    use kashshaf_lib::search::parse_wildcard_query;
    use kashshaf_lib::tokens::PageKey;

    let app_state = require_state(&state)?;
    let filters = filters.unwrap_or_default();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    // Validate the query first
    if let Err(e) = validate_wildcard_query(&query, SearchMode::Surface) {
        return Err(KashshafError::Search(e.message));
    }

    let search_engine = app_state.search_engine.clone();
    let token_cache = app_state.token_cache.clone();
    let query_clone = query.clone();

    tokio::task::spawn_blocking(move || {
        let mut results = search_engine
            .wildcard_search(&query_clone, &filters, limit, offset)
            .map_err(|e: anyhow::Error| KashshafError::Search(e.to_string()))?;

        // For multi-word wildcard phrases, recalculate matched_token_indices
        // using the token cache to ensure only complete phrase matches are highlighted
        let query_info = parse_wildcard_query(&query_clone);
        if query_info.terms.len() > 1 {
            for result in &mut results.results {
                let page_key = PageKey::new(result.id, result.part_index, result.page_id);
                if let Ok(positions) = token_cache.find_wildcard_phrase_positions(
                    &page_key,
                    &query_info.prefix,
                    query_info.suffix.as_deref(),
                    query_info.wildcard_term_index,
                    &query_info.terms,
                ) {
                    result.matched_token_indices = positions;
                }
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| KashshafError::Search(format!("Task join error: {}", e)))?
}


#[tauri::command]
pub async fn show_app_menu(app: AppHandle, x: f64, y: f64) -> Result<String, KashshafError> {
    // Check if local data exists to determine if delete option should be enabled
    let data_dir = get_corpus_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;
    let has_local_data = data_dir.join("corpus.db").exists()
        || data_dir.join("tantivy_index").exists()
        || data_dir.join("manifest.local.json").exists();

    let settings_item = MenuItemBuilder::with_id("settings", "Settings")
        .build(&app)
        .map_err(|e| KashshafError::Other(format!("Failed to create settings menu item: {}", e)))?;

    let check_updates_item = MenuItemBuilder::with_id("check_for_updates", "Check for Updates")
        .build(&app)
        .map_err(|e| {
            KashshafError::Other(format!(
                "Failed to create check for updates menu item: {}",
                e
            ))
        })?;

    let delete_data_item = MenuItemBuilder::with_id("delete_local_data", "Delete Local Data")
        .enabled(has_local_data)
        .build(&app)
        .map_err(|e| {
            KashshafError::Other(format!(
                "Failed to create delete local data menu item: {}",
                e
            ))
        })?;

    let quit_item = MenuItemBuilder::with_id("quit", "Quit")
        .build(&app)
        .map_err(|e| KashshafError::Other(format!("Failed to create quit menu item: {}", e)))?;

    let menu = MenuBuilder::new(&app)
        .item(&settings_item)
        .item(&check_updates_item)
        .item(&delete_data_item)
        .item(&quit_item)
        .build()
        .map_err(|e| KashshafError::Other(format!("Failed to build menu: {}", e)))?;

    let webview_window = app
        .get_webview_window("main")
        .ok_or_else(|| KashshafError::Other("Main window not found".to_string()))?;

    // Get the underlying Window from WebviewWindow for the popup
    let window = webview_window.as_ref().window();

    // Position is relative to the window's top-left corner
    let position = tauri::PhysicalPosition::new(x as i32, y as i32);
    menu.popup_at(window.clone(), position)
        .map_err(|e| KashshafError::Other(format!("Failed to show menu: {}", e)))?;

    Ok("Menu shown".to_string())
}

// ============ Search History & Saved Searches ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHistoryEntry {
    pub id: i64,
    pub search_type: String,
    pub query_data: String,
    pub display_label: String,
    pub book_filter_count: i64,
    pub book_ids: Option<String>,
    pub created_at: String,
    pub is_saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSearchEntry {
    pub id: i64,
    pub history_id: Option<i64>,
    pub search_type: String,
    pub query_data: String,
    pub display_label: String,
    pub book_filter_count: i64,
    pub book_ids: Option<String>,
    pub created_at: String,
}

// Re-export AppUpdateStatus from downloader
pub use kashshaf_lib::downloader::AppUpdateStatus;

/// Helper to get settings DB connection with table initialization
/// Works independently of AppState (before corpus is downloaded)
fn get_settings_connection() -> Result<rusqlite::Connection, KashshafError> {
    use kashshaf_lib::downloader::get_settings_db_path;

    let settings_path = get_settings_db_path().map_err(|e| KashshafError::Other(e.to_string()))?;

    // Ensure parent directory exists
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            KashshafError::Database(format!("Failed to create data directory: {}", e))
        })?;
    }

    let conn = rusqlite::Connection::open(&settings_path)
        .map_err(|e| KashshafError::Database(format!("unable to open database file: {}", e)))?;

    // Ensure tables exist
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            search_type TEXT NOT NULL,
            query_data TEXT NOT NULL,
            display_label TEXT NOT NULL,
            book_filter_count INTEGER DEFAULT 0,
            book_ids TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS saved_searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            history_id INTEGER,
            search_type TEXT NOT NULL,
            query_data TEXT NOT NULL,
            display_label TEXT NOT NULL,
            book_filter_count INTEGER DEFAULT 0,
            book_ids TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(query_data)
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_search_history_created
        ON search_history(created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_saved_searches_created
        ON saved_searches(created_at DESC);
        "#,
    )
    .map_err(|e| KashshafError::Database(e.to_string()))?;

    Ok(conn)
}

// ============ Search History Commands ============

#[tauri::command]
pub fn add_to_history(
    search_type: String,
    query_data: String,
    display_label: String,
    book_filter_count: i64,
    book_ids: Option<String>,
) -> Result<i64, KashshafError> {
    let conn = get_settings_connection()?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO search_history (search_type, query_data, display_label, book_filter_count, book_ids, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![search_type, query_data, display_label, book_filter_count, book_ids, now],
    ).map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let id = conn.last_insert_rowid();

    // Rotate history - keep only the last 100 entries
    conn.execute(
        "DELETE FROM search_history WHERE id NOT IN (
            SELECT id FROM search_history ORDER BY created_at DESC LIMIT 100
        )",
        [],
    )
    .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(id)
}

#[tauri::command]
pub fn get_search_history(limit: Option<i64>) -> Result<Vec<SearchHistoryEntry>, KashshafError> {
    let conn = get_settings_connection()?;
    let limit = limit.unwrap_or(100);

    let mut stmt = conn.prepare(
        "SELECT h.id, h.search_type, h.query_data, h.display_label, h.book_filter_count, h.book_ids, h.created_at,
                CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_saved
         FROM search_history h
         LEFT JOIN saved_searches s ON h.query_data = s.query_data
         ORDER BY h.created_at DESC
         LIMIT ?1"
    ).map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let entries = stmt
        .query_map([limit], |row: &Row| {
            Ok(SearchHistoryEntry {
                id: row.get(0)?,
                search_type: row.get(1)?,
                query_data: row.get(2)?,
                display_label: row.get(3)?,
                book_filter_count: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                book_ids: row.get(5)?,
                created_at: row.get(6)?,
                is_saved: row.get::<_, i64>(7)? == 1,
            })
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(entries)
}

#[tauri::command]
pub fn clear_history() -> Result<(), KashshafError> {
    let conn = get_settings_connection()?;
    conn.execute("DELETE FROM search_history", [])
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;
    Ok(())
}

// ============ Saved Searches Commands ============

#[tauri::command]
pub fn save_search(
    history_id: Option<i64>,
    search_type: String,
    query_data: String,
    display_label: String,
    book_filter_count: i64,
    book_ids: Option<String>,
) -> Result<i64, KashshafError> {
    let conn = get_settings_connection()?;
    let now = chrono::Utc::now().to_rfc3339();

    // Use INSERT OR IGNORE to prevent duplicates (based on UNIQUE query_data)
    conn.execute(
        "INSERT OR IGNORE INTO saved_searches (history_id, search_type, query_data, display_label, book_filter_count, book_ids, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![history_id, search_type, query_data, display_label, book_filter_count, book_ids, now],
    ).map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    // Get the ID (either newly inserted or existing)
    let id: i64 = conn
        .query_row(
            "SELECT id FROM saved_searches WHERE query_data = ?1",
            [&query_data],
            |row| row.get(0),
        )
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(id)
}

#[tauri::command]
pub fn unsave_search(id: i64) -> Result<(), KashshafError> {
    let conn = get_settings_connection()?;
    conn.execute("DELETE FROM saved_searches WHERE id = ?1", [id])
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn unsave_search_by_query(query_data: String) -> Result<(), KashshafError> {
    let conn = get_settings_connection()?;
    conn.execute(
        "DELETE FROM saved_searches WHERE query_data = ?1",
        [query_data],
    )
    .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn is_search_saved(query_data: String) -> Result<bool, KashshafError> {
    let conn = get_settings_connection()?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM saved_searches WHERE query_data = ?1",
            [&query_data],
            |row| row.get(0),
        )
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;
    Ok(count > 0)
}

#[tauri::command]
pub fn get_saved_searches(limit: Option<i64>) -> Result<Vec<SavedSearchEntry>, KashshafError> {
    let conn = get_settings_connection()?;
    let limit = limit.unwrap_or(100);

    let mut stmt = conn.prepare(
        "SELECT id, history_id, search_type, query_data, display_label, book_filter_count, book_ids, created_at
         FROM saved_searches
         ORDER BY created_at DESC
         LIMIT ?1"
    ).map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    let entries = stmt
        .query_map([limit], |row: &Row| {
            Ok(SavedSearchEntry {
                id: row.get(0)?,
                history_id: row.get(1)?,
                search_type: row.get(2)?,
                query_data: row.get(3)?,
                display_label: row.get(4)?,
                book_filter_count: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                book_ids: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e: rusqlite::Error| KashshafError::Database(e.to_string()))?;

    Ok(entries)
}

// ============ App Settings Commands ============

#[tauri::command]
pub fn get_app_setting(key: String) -> Result<Option<String>, KashshafError> {
    let conn = get_settings_connection()?;

    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| KashshafError::Database(e.to_string()))?;

    Ok(result)
}

#[tauri::command]
pub fn set_app_setting(key: String, value: String) -> Result<(), KashshafError> {
    let conn = get_settings_connection()?;

    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| KashshafError::Database(e.to_string()))?;

    Ok(())
}

// ============ App Update Check Command ============

#[tauri::command]
pub async fn check_app_update() -> Result<AppUpdateStatus, KashshafError> {
    use kashshaf_lib::downloader::{check_app_update as check_update, fetch_app_manifest};

    let current_version = env!("CARGO_PKG_VERSION");

    match fetch_app_manifest().await {
        Ok(manifest) => Ok(check_update(current_version, &manifest)),
        Err(_e) => {
            // Return status indicating we couldn't check
            Ok(AppUpdateStatus {
                current_version: current_version.to_string(),
                latest_version: current_version.to_string(),
                min_supported_version: current_version.to_string(),
                update_required: false,
                update_available: false,
                release_notes: None,
                download_url: None,
            })
        }
    }
}

// ============ Corpus Download Commands ============

use kashshaf_lib::downloader::{
    get_app_data_directory, get_corpus_data_directory, CorpusStatus, DownloadProgress,
};
use std::sync::Mutex;
use tauri::Emitter;

/// Global state for download cancellation
static DOWNLOAD_CANCEL_TX: Mutex<Option<tokio::sync::watch::Sender<bool>>> = Mutex::new(None);

/// Check corpus status - can be called before AppState is initialized
#[tauri::command]
pub async fn check_corpus_status() -> Result<CorpusStatus, KashshafError> {
    let data_dir = get_corpus_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;

    // Get app version from Cargo.toml
    let app_version = env!("CARGO_PKG_VERSION");

    Ok(kashshaf_lib::check_corpus_status(&data_dir, app_version).await)
}

/// Start corpus download - emits "download-progress" events
#[tauri::command]
pub async fn start_corpus_download(
    window: tauri::Window,
    skip_verify: Option<bool>,
) -> Result<(), KashshafError> {
    let skip_verify = skip_verify.unwrap_or(false);
    let data_dir =
        get_corpus_data_directory().map_err(|e| KashshafError::Download(e.to_string()))?;

    // Create data directory if it doesn't exist
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| KashshafError::Download(format!("Failed to create data directory: {}", e)))?;

    // Fetch remote manifest
    let remote = kashshaf_lib::fetch_remote_manifest()
        .await
        .map_err(|e| KashshafError::Download(e.to_string()))?;

    // Load local manifest if exists
    let local = kashshaf_lib::load_local_manifest(&data_dir);

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<DownloadProgress>(100);

    // Create cancellation channel
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);

    // Store cancel sender globally
    {
        let mut guard = DOWNLOAD_CANCEL_TX.lock().unwrap();
        *guard = Some(cancel_tx);
    }

    // Spawn task to forward progress to window events
    let window_clone = window.clone();
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = window_clone.emit("download-progress", &progress);
        }
    });

    // Start download
    let result = kashshaf_lib::download_corpus(
        &data_dir,
        &remote,
        local.as_ref(),
        progress_tx,
        &mut cancel_rx,
        skip_verify,
    )
    .await;

    // Give the progress receiver task time to process the final message
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Clear cancel sender
    {
        let mut guard = DOWNLOAD_CANCEL_TX.lock().unwrap();
        *guard = None;
    }

    result.map_err(|e| KashshafError::Download(e.to_string()))
}

/// Cancel ongoing download
#[tauri::command]
pub fn cancel_corpus_download() -> Result<(), KashshafError> {
    let guard = DOWNLOAD_CANCEL_TX.lock().unwrap();
    if let Some(ref tx) = *guard {
        let _ = tx.send(true);
        Ok(())
    } else {
        Err(KashshafError::Download(
            "No download in progress".to_string(),
        ))
    }
}

/// Get the application data directory
#[tauri::command]
pub fn get_data_directory() -> Result<String, KashshafError> {
    let dir = get_app_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Archive old corpus before update
#[tauri::command]
pub fn archive_old_corpus(version: String) -> Result<String, KashshafError> {
    let app_data_dir = get_app_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;

    let archive_path = kashshaf_lib::archive_old_corpus(&app_data_dir, &version)
        .map_err(|e| KashshafError::Other(e.to_string()))?;

    Ok(archive_path.to_string_lossy().to_string())
}

/// Reload AppState after download completes
/// Returns true if successful, false if data still not ready
#[tauri::command]
pub async fn reload_app_state(state: State<'_, ManagedAppState>) -> Result<bool, KashshafError> {
    let data_dir = get_corpus_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;

    // Try to create new AppState
    match AppState::new(data_dir) {
        Ok(new_state) => {
            // Swap the state inside the RwLock
            let mut guard = state.write().map_err(|_| {
                KashshafError::Other("Failed to acquire state write lock".to_string())
            })?;
            *guard = Some(Arc::new(new_state));
            println!("AppState reloaded successfully after corpus download");
            Ok(true)
        }
        Err(e) => {
            eprintln!("Failed to reload AppState: {}", e);
            Ok(false)
        }
    }
}

// ============ User Settings Commands ============

/// Get a user setting by key
/// Can be called before AppState is initialized (uses settings.db directly)
#[tauri::command]
pub fn get_user_setting(key: String) -> Result<Option<String>, KashshafError> {
    use kashshaf_lib::downloader::get_settings_db_path;

    let settings_path = get_settings_db_path().map_err(|e| KashshafError::Other(e.to_string()))?;

    // Ensure parent directory exists (may not exist on first startup)
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| KashshafError::Other(e.to_string()))?;
    }

    // Initialize settings DB if not exists (same as in state.rs)
    let conn = rusqlite::Connection::open(&settings_path)
        .map_err(|e| KashshafError::Database(e.to_string()))?;

    // Ensure user_settings table exists
    conn.execute(
        "CREATE TABLE IF NOT EXISTS user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| KashshafError::Database(e.to_string()))?;

    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM user_settings WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| KashshafError::Database(e.to_string()))?;

    Ok(result)
}

/// Set a user setting
/// Can be called before AppState is initialized (uses settings.db directly)
#[tauri::command]
pub fn set_user_setting(key: String, value: String) -> Result<(), KashshafError> {
    use kashshaf_lib::downloader::get_settings_db_path;

    let settings_path = get_settings_db_path().map_err(|e| KashshafError::Other(e.to_string()))?;

    // Ensure parent directory exists (may not exist on first startup)
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| KashshafError::Other(e.to_string()))?;
    }

    let conn = rusqlite::Connection::open(&settings_path)
        .map_err(|e| KashshafError::Database(e.to_string()))?;

    // Ensure user_settings table exists
    conn.execute(
        "CREATE TABLE IF NOT EXISTS user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| KashshafError::Database(e.to_string()))?;

    conn.execute(
        "INSERT OR REPLACE INTO user_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| KashshafError::Database(e.to_string()))?;

    Ok(())
}

/// Check if corpus files exist (tantivy_index + corpus.db)
/// Returns true if both exist, false otherwise
#[tauri::command]
pub fn corpus_exists() -> Result<bool, KashshafError> {
    let data_dir = get_corpus_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;

    let index_path = data_dir.join("tantivy_index");
    let db_path = data_dir.join("corpus.db");

    let exists = index_path.exists() && db_path.exists();
    Ok(exists)
}

/// Delete local corpus data (corpus.db, tantivy_index, manifest.local.json)
/// Preserves settings.db (search history, saved searches, user preferences)
/// Returns the number of items deleted
#[tauri::command]
pub fn delete_local_data(state: State<'_, ManagedAppState>) -> Result<u32, KashshafError> {
    let data_dir = get_corpus_data_directory().map_err(|e| KashshafError::Other(e.to_string()))?;

    // First, clear the AppState to release any file handles
    {
        let mut guard = state.write().map_err(|_| {
            KashshafError::Other("Failed to acquire state write lock".to_string())
        })?;
        *guard = None;
        println!("AppState cleared before deleting local data");
    }

    let mut deleted_count: u32 = 0;

    // Delete corpus.db
    let db_path = data_dir.join("corpus.db");
    if db_path.exists() {
        std::fs::remove_file(&db_path)
            .map_err(|e| KashshafError::Other(format!("Failed to delete corpus.db: {}", e)))?;
        println!("Deleted: {:?}", db_path);
        deleted_count += 1;
    }

    // Delete tantivy_index directory
    let index_path = data_dir.join("tantivy_index");
    if index_path.exists() {
        std::fs::remove_dir_all(&index_path)
            .map_err(|e| KashshafError::Other(format!("Failed to delete tantivy_index: {}", e)))?;
        println!("Deleted: {:?}", index_path);
        deleted_count += 1;
    }

    // Delete manifest.local.json (download tracking file)
    let manifest_path = data_dir.join("manifest.local.json");
    if manifest_path.exists() {
        std::fs::remove_file(&manifest_path)
            .map_err(|e| KashshafError::Other(format!("Failed to delete manifest.local.json: {}", e)))?;
        println!("Deleted: {:?}", manifest_path);
        deleted_count += 1;
    }

    println!("Local data deletion complete. {} items deleted.", deleted_count);
    Ok(deleted_count)
}
