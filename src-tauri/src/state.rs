//! Application state management

use kashshaf_common::get_settings_db_path;
use anyhow::{anyhow, Result};
use kashshaf_engine::{
    check_corpus_schema_supported, ensure_corpus_indexes, verify_corpus_versions_match, EngineConfig,
    SearchEngine, TokenCache,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Default token cache capacity (number of pages)
const DEFAULT_CACHE_CAPACITY: usize = 1000;

/// Application state holding search engine and database paths
pub struct AppState {
    pub search_engine: Arc<SearchEngine>,
    pub token_cache: Arc<TokenCache>,
    pub db_path: PathBuf,
    pub metadata_db_path: PathBuf,
    pub settings_db_path: PathBuf,
    pub data_dir: PathBuf,
    /// `db_info.schema_version` of corpus.db (None for a legacy build without db_info)
    pub db_schema_version: Option<i64>,
    pub corpus_version: Option<String>,
}

impl AppState {
    /// Initialize application state
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let index_path = data_dir.join("tantivy_index");
        let db_path = data_dir.join("corpus.db");
        let metadata_db_path = data_dir.join("metadata.db");

        // settings.db lives next to the corpus (kashshaf_common::get_settings_db_path);
        // delete_local_data spares it.
        let settings_db_path = get_settings_db_path().unwrap_or_else(|_| data_dir.join("settings.db"));

        // metadata.db must exist; rusqlite would otherwise silently create an empty file
        // and surface "no such table: books" only on the first metadata query.
        if !metadata_db_path.exists() {
            return Err(anyhow!(
                "metadata.db is missing from {}. Re-download the corpus to restore it.",
                data_dir.display()
            ));
        }

        // Refuse a corpus.db schema this build cannot read (forces the user to update
        // the app rather than failing on the first page load), then check that both
        // databases come from the same corpus build.
        let info = check_corpus_schema_supported(&db_path)?;
        verify_corpus_versions_match(&db_path, &metadata_db_path)?;
        let db_schema_version = info.as_ref().map(|i| i.schema_version);
        let corpus_version = info.as_ref().map(|i| i.corpus_version.clone());

        // Schema 3 ships with the lemma and root indexes; older builds get them here.
        if db_schema_version.unwrap_or(0) < 3 {
            let conn = rusqlite::Connection::open(&db_path)?;
            let t0 = std::time::Instant::now();
            let created = ensure_corpus_indexes(&conn)?;
            if !created.is_empty() {
                eprintln!(
                    "[corpus.db] created indexes {:?} in {} ms",
                    created,
                    t0.elapsed().as_millis()
                );
            }
        }

        let config = EngineConfig { exact_counts: Self::read_exact_counts_setting(&settings_db_path), ..EngineConfig::default() };
        let mut engine = SearchEngine::open_with_corpus(&index_path, Some(&db_path), config)?;
        let token_cache = Arc::new(TokenCache::new(db_path.clone(), DEFAULT_CACHE_CAPACITY)?);
        engine.set_token_cache(token_cache.clone());
        let search_engine = Arc::new(engine);
        eprintln!(
            "[engine] {:?} index, {} docs, {} segments, reading_order={}, codec={}, corpus={:?}, db schema={:?}",
            search_engine.kind(),
            search_engine.doc_count().unwrap_or(0),
            search_engine.segment_count(),
            search_engine.reading_order(),
            token_cache.has_codec(),
            corpus_version,
            db_schema_version
        );

        Self::init_settings_db(&settings_db_path)?;

        Ok(Self {
            search_engine,
            token_cache,
            db_path,
            metadata_db_path,
            settings_db_path,
            data_dir,
            db_schema_version,
            corpus_version,
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
    /// `user_settings.exact_counts` ("true"/"false", default false). Tolerates a
    /// missing settings.db or table (first run).
    pub fn read_exact_counts_setting(settings_db_path: &PathBuf) -> bool {
        let Ok(conn) = rusqlite::Connection::open(settings_db_path) else { return false };
        conn.query_row("SELECT value FROM user_settings WHERE key = 'exact_counts'", [], |r| r.get::<_, String>(0))
            .map(|v| v == "true")
            .unwrap_or(false)
    }

    fn init_settings_db(path: &PathBuf) -> Result<()> {
        let conn = rusqlite::Connection::open(path)?;

        // Check if we need to migrate the old saved_searches table
        let needs_migration = {
            let mut stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('saved_searches') WHERE name = 'history_id'",
            )?;
            let count: i64 = stmt.query_row([], |row| row.get(0))?;
            count == 0
        };

        if needs_migration {
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

            -- User settings (mode, download prompt, announcements)
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
