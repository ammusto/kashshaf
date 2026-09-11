//! `corpus.db` / `metadata.db` version gating and small shared queries.

use anyhow::{anyhow, Result};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// `db_info.schema_version` values this engine can read.
///
/// * 1 — original layout
/// * 2 — `parts` column in `metadata.db` (no change to `corpus.db` reads)
/// * 3 — `page_tokens.encoding`, `WITHOUT ROWID`, `token_codec`, root index
/// * 4 — `triples` table + `token_definitions.triple_id` (compound index)
pub const MIN_SUPPORTED_DB_SCHEMA: i64 = 1;
pub const MAX_SUPPORTED_DB_SCHEMA: i64 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbInfo {
    pub corpus_version: String,
    pub schema_version: i64,
}

/// Read `db_info` from a database, or `None` if the table is missing (legacy build).
pub fn read_db_info(path: &Path) -> Result<Option<DbInfo>> {
    let conn = Connection::open(path)?;
    read_db_info_conn(&conn)
}

pub fn read_db_info_conn(conn: &Connection) -> Result<Option<DbInfo>> {
    let table_exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_info'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !table_exists {
        return Ok(None);
    }
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT corpus_version, schema_version FROM db_info LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(corpus_version, schema_version)| DbInfo {
        corpus_version,
        schema_version,
    }))
}

/// Refuse to open a `corpus.db` whose schema this build cannot read.
/// Returns the `DbInfo` (or `None` for a legacy database without one).
pub fn check_corpus_schema_supported(corpus_db: &Path) -> Result<Option<DbInfo>> {
    let info = read_db_info(corpus_db)?;
    if let Some(ref i) = info {
        if i.schema_version > MAX_SUPPORTED_DB_SCHEMA {
            return Err(anyhow!(
                "corpus.db schema version {} is newer than this app supports (max {}). \
                 Please update Kashshaf.",
                i.schema_version,
                MAX_SUPPORTED_DB_SCHEMA
            ));
        }
        if i.schema_version < MIN_SUPPORTED_DB_SCHEMA {
            return Err(anyhow!(
                "corpus.db schema version {} is too old for this app (min {}). \
                 Re-download the corpus.",
                i.schema_version,
                MIN_SUPPORTED_DB_SCHEMA
            ));
        }
    }
    Ok(info)
}

/// Verify that corpus.db and metadata.db were built from the same corpus_version.
/// If either DB lacks `db_info`, the check is skipped (legacy build).
pub fn verify_corpus_versions_match(corpus_path: &Path, metadata_path: &Path) -> Result<()> {
    let c = read_db_info(corpus_path)?.map(|i| i.corpus_version);
    let m = read_db_info(metadata_path)?.map(|i| i.corpus_version);
    match (c, m) {
        (Some(c), Some(m)) if c != m => Err(anyhow!(
            "corpus.db and metadata.db are out of sync (corpus={}, metadata={}). \
             Re-download the corpus to restore alignment.",
            c,
            m
        )),
        _ => Ok(()),
    }
}

/// Does `page_tokens` carry the `encoding` column (schema >= 3)?
pub fn page_tokens_has_encoding(conn: &Connection) -> Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(page_tokens)")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for n in names {
        if n? == "encoding" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Idempotent: make sure the lookup indexes the engine relies on exist.
/// Schema 3 databases ship with both; older ones get them created here.
pub fn ensure_corpus_indexes(conn: &Connection) -> Result<Vec<&'static str>> {
    let mut created = Vec::new();
    for (name, sql) in [
        (
            "idx_token_def_lemma",
            "CREATE INDEX IF NOT EXISTS idx_token_def_lemma ON token_definitions(lemma_id)",
        ),
        (
            "idx_token_def_root",
            "CREATE INDEX IF NOT EXISTS idx_token_def_root ON token_definitions(root_id)",
        ),
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            conn.execute_batch(sql)?;
            created.push(name);
        }
    }
    Ok(created)
}
