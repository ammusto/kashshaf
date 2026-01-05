//! Application state management

use crate::cache::TokenCache;
use crate::downloader::get_settings_db_path;
use crate::search::SearchEngine;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

/// Default token cache capacity (number of pages)
const DEFAULT_CACHE_CAPACITY: usize = 1000;

/// Application state holding search engine and database path
pub struct AppState {
    pub search_engine: Arc<SearchEngine>,
    pub token_cache: Arc<TokenCache>,
    pub db_path: PathBuf,
    pub settings_db_path: PathBuf,
    pub data_dir: PathBuf,
}

impl AppState {
    /// Initialize application state
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let index_path = data_dir.join("tantivy_index");
        let db_path = data_dir.join("corpus.db");

        // Settings database is stored in app data directory, not corpus data
        // This allows settings to persist across corpus updates
        let settings_db_path = get_settings_db_path()
            .unwrap_or_else(|_| data_dir.join("settings.db"));

        let search_engine = Arc::new(SearchEngine::open(&index_path)?);
        // TokenCache loads tokens from SQLite corpus.db
        let token_cache = Arc::new(TokenCache::new(db_path.clone(), DEFAULT_CACHE_CAPACITY));

        // Initialize settings database (create if missing)
        Self::init_settings_db(&settings_db_path)?;

        Ok(Self {
            search_engine,
            token_cache,
            db_path,
            settings_db_path,
            data_dir,
        })
    }

    /// Get a new database connection (each call creates a new connection)
    pub fn get_db_connection(&self) -> Result<rusqlite::Connection> {
        Ok(rusqlite::Connection::open(&self.db_path)?)
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
