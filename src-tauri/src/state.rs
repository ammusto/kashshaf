//! Application state management

use crate::cache::TokenCache;
use crate::downloader::get_settings_db_path;
use crate::search::SearchEngine;
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Default token cache capacity (number of pages)
const DEFAULT_CACHE_CAPACITY: usize = 1000;

/// Application state holding search engine and database path
pub struct AppState {
    pub search_engine: Arc<SearchEngine>,
    pub token_cache: Arc<TokenCache>,
    pub db_path: PathBuf,
    pub metadata_db_path: PathBuf,
    pub settings_db_path: PathBuf,
    pub data_dir: PathBuf,
}

impl AppState {
    /// Initialize application state
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let index_path = data_dir.join("tantivy_index");
        let db_path = data_dir.join("corpus.db");
        let metadata_db_path = data_dir.join("metadata.db");

        // Settings database is stored in app data directory, not corpus data
        // This allows settings to persist across corpus updates
        let settings_db_path = get_settings_db_path()
            .unwrap_or_else(|_| data_dir.join("settings.db"));

        // metadata.db must exist; rusqlite would otherwise silently create an empty file
        // and surface "no such table: books" only on the first metadata query.
        if !metadata_db_path.exists() {
            return Err(anyhow!(
                "metadata.db is missing from {}. Re-download the corpus to restore it.",
                data_dir.display()
            ));
        }

        // Both DBs are built together by the data pipeline and share a corpus_version.
        // Refuse to start if they're out of sync — surfaces install/update mistakes
        // (e.g., partial download, manual file swap) before they cause weird query errors.
        verify_corpus_versions_match(&db_path, &metadata_db_path)?;

        // One-time idempotent migration: ensure the lemma_id index on
        // token_definitions exists. Older corpus.db builds didn't have it,
        // and the variants scanner needs O(log n) lookups by lemma.
        ensure_corpus_indexes(&db_path)?;

        let search_engine = Arc::new(SearchEngine::open(&index_path)?);
        // TokenCache loads tokens from SQLite corpus.db
        let token_cache = Arc::new(TokenCache::new(db_path.clone(), DEFAULT_CACHE_CAPACITY));

        // Initialize settings database (create if missing)
        Self::init_settings_db(&settings_db_path)?;

        Ok(Self {
            search_engine,
            token_cache,
            db_path,
            metadata_db_path,
            settings_db_path,
            data_dir,
        })
    }

    /// Get a new database connection (each call creates a new connection)
    pub fn get_db_connection(&self) -> Result<rusqlite::Connection> {
        Ok(rusqlite::Connection::open(&self.db_path)?)
    }

    /// Get a new metadata database connection
    pub fn get_metadata_db_connection(&self) -> Result<rusqlite::Connection> {
        Ok(rusqlite::Connection::open(&self.metadata_db_path)?)
    }

    /// Get a new settings database connection
    pub fn get_settings_db_connection(&self) -> Result<rusqlite::Connection> {
        Ok(rusqlite::Connection::open(&self.settings_db_path)?)
    }

    /// Initialize settings database with required tables
    fn init_settings_db(path: &PathBuf) -> Result<()> {
        let conn = rusqlite::Connection::open(path)?;

        // Check if we need to migrate the old saved_searches table
        let needs_migration = {
            let mut stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('saved_searches') WHERE name = 'history_id'"
            )?;
            let count: i64 = stmt.query_row([], |row| row.get(0))?;
            count == 0
        };

        if needs_migration {
            // Drop old tables if they exist (we're migrating to new schema)
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS saved_searches;
                DROP INDEX IF EXISTS idx_saved_searches_last_used;
                "#,
            )?;
        }

        conn.execute_batch(
            r#"
            -- Search history (auto-saved, rotates at 100 entries)
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                search_type TEXT NOT NULL,
                query_data TEXT NOT NULL,
                display_label TEXT NOT NULL,
                book_filter_count INTEGER DEFAULT 0,
                book_ids TEXT,
                created_at TEXT NOT NULL
            );

            -- Saved searches (user explicitly saved, never auto-deleted)
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

            -- App settings (key-value store)
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- User settings (legacy, keeping for backwards compatibility)
            CREATE TABLE IF NOT EXISTS user_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_search_history_created
            ON search_history(created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_saved_searches_created
            ON saved_searches(created_at DESC);
            "#,
        )?;

        Ok(())
    }
}

/// Idempotent migration: create indexes on corpus.db that newer features rely
/// on but older builds may not have. Logs the outcome so we have proof of
/// migration on startup; check whether the variants slowness is index-related.
fn ensure_corpus_indexes(corpus_db_path: &Path) -> Result<()> {
    let conn = rusqlite::Connection::open(corpus_db_path)?;

    let pre_exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_token_def_lemma'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if pre_exists {
        eprintln!("[corpus.db] idx_token_def_lemma already present at {:?}", corpus_db_path);
    } else {
        eprintln!("[corpus.db] creating idx_token_def_lemma at {:?} (one-time, may take a moment)", corpus_db_path);
        let t0 = std::time::Instant::now();
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_token_def_lemma ON token_definitions(lemma_id);",
        )?;
        eprintln!("[corpus.db] idx_token_def_lemma created in {} ms", t0.elapsed().as_millis());
    }

    Ok(())
}

/// Read corpus_version from a database's db_info table.
/// Returns None if the table or column is missing (e.g., legacy build).
fn read_corpus_version(db_path: &Path) -> Result<Option<String>> {
    let conn = rusqlite::Connection::open(db_path)?;
    let table_exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_info'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !table_exists {
        return Ok(None);
    }
    let version: Option<String> = conn
        .query_row("SELECT corpus_version FROM db_info LIMIT 1", [], |row| {
            row.get(0)
        })
        .ok();
    Ok(version)
}

/// Verify that corpus.db and metadata.db were built from the same corpus_version.
/// If either DB lacks the db_info table, skip the check (legacy build).
fn verify_corpus_versions_match(corpus_path: &Path, metadata_path: &Path) -> Result<()> {
    let corpus_version = read_corpus_version(corpus_path)?;
    let metadata_version = read_corpus_version(metadata_path)?;

    match (corpus_version, metadata_version) {
        (Some(c), Some(m)) if c != m => Err(anyhow!(
            "corpus.db and metadata.db are out of sync (corpus={}, metadata={}). \
             Re-download the corpus to restore alignment.",
            c,
            m
        )),
        _ => Ok(()),
    }
}
