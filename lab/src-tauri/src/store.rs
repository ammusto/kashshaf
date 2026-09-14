//! `analysis.db` (Lab spec §6).
//!
//! SQLite in Lab's own directory, WAL, `foreign_keys=ON`, schema version in
//! `lab_info`, migrations forward-only and numbered, applied at startup.
//!
//! Phase 0 creates the database and the two tables every later phase needs to
//! record itself in (`lab_info`, `lab_setting`). The feature tables of §6.2 to
//! §6.5 arrive as further numbered migrations with the phases that write to
//! them, because a migration that ships before its writer cannot be tested by
//! the thing that will use it.

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// One forward-only migration. Never edit a shipped entry: add the next one.
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "lab_info and lab_setting",
    sql: r#"
        CREATE TABLE IF NOT EXISTS lab_info (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lab_setting (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    "#,
}];

/// The schema version a fresh database is created at.
pub fn target_schema_version() -> i64 {
    MIGRATIONS.iter().map(|m| m.version).max().unwrap_or(0)
}

#[derive(Debug)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    /// Open (creating if absent) `analysis.db` under `dir` and migrate it.
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("analysis.db");
        let store = Self { path };
        let conn = store.connect()?;
        migrate(&conn)?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A fresh connection with Lab's pragmas. WAL so a long analysis run does
    /// not block the UI's reads.
    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)
            .with_context(|| format!("opening {}", self.path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub fn schema_version(&self) -> Result<i64> {
        read_schema_version(&self.connect()?)
    }
}

fn read_schema_version(conn: &Connection) -> Result<i64> {
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='lab_info'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Ok(0);
    }
    let v: Option<String> = conn
        .query_row("SELECT value FROM lab_info WHERE key='schema_version'", [], |r| r.get(0))
        .ok();
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

/// Apply every migration above the database's current version, in order, each
/// in its own transaction. A database from a *newer* Lab is refused rather
/// than downgraded: the user's annotations are not worth guessing about.
pub fn migrate(conn: &Connection) -> Result<()> {
    let from = read_schema_version(conn)?;
    let target = target_schema_version();
    if from > target {
        return Err(anyhow!(
            "{} was written by a newer Kashshaf Lab (schema {} > {}). Update Lab to open it.",
            "analysis.db",
            from,
            target
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    for m in MIGRATIONS.iter().filter(|m| m.version > from) {
        conn.execute_batch("BEGIN")?;
        let applied = (|| -> Result<()> {
            conn.execute_batch(m.sql)?;
            conn.execute(
                "INSERT OR REPLACE INTO lab_info (key, value) VALUES ('schema_version', ?1)",
                [m.version.to_string()],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO lab_info (key, value) VALUES ('created_at', ?1)",
                [now.as_str()],
            )?;
            Ok(())
        })();
        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.context(format!("migration {} ({})", m.version, m.name)));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kashshaf-lab-store-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_fresh_database_is_created_at_the_target_version() {
        let dir = temp("fresh");
        let store = Store::open(&dir).unwrap();
        assert!(store.path().exists());
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let conn = store.connect().unwrap();
        let created: String = conn
            .query_row("SELECT value FROM lab_info WHERE key='created_at'", [], |r| r.get(0))
            .unwrap();
        assert!(created.contains('T'), "created_at is an RFC 3339 timestamp: {}", created);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrating_is_idempotent_and_keeps_what_is_there() {
        let dir = temp("idempotent");
        let store = Store::open(&dir).unwrap();
        {
            let conn = store.connect().unwrap();
            conn.execute("INSERT INTO lab_setting (key, value) VALUES ('banality_rank', '300')", [])
                .unwrap();
        }
        // Re-open: every migration is already applied, nothing runs, the row stays.
        let store = Store::open(&dir).unwrap();
        let conn = store.connect().unwrap();
        let v: String = conn
            .query_row("SELECT value FROM lab_setting WHERE key='banality_rank'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "300");
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_from_a_newer_lab_is_refused_not_downgraded() {
        let dir = temp("newer");
        let store = Store::open(&dir).unwrap();
        {
            let conn = store.connect().unwrap();
            conn.execute("UPDATE lab_info SET value = ?1 WHERE key='schema_version'", ["999"])
                .unwrap();
        }
        let e = Store::open(&dir).unwrap_err().to_string();
        assert!(e.contains("newer Kashshaf Lab"), "{}", e);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrations_are_numbered_forward_only_and_unique() {
        let mut seen: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        let ordered = seen.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, ordered, "migrations must be listed in ascending, unique order");
        assert_eq!(seen.first().copied(), Some(1), "numbering starts at 1");
    }
}
