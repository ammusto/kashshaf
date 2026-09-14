//! Settings-database helpers.
//!
//! Kashshaf keeps `settings.db` next to the corpus; Lab keeps `lab_settings.db`
//! in its own directory (Lab spec §2.5). The schemas differ, so what is shared
//! is the opening and the key/value access both apps do around a
//! `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table (§2.2).

use anyhow::{anyhow, Result};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Open a settings database, creating its parent directory first.
///
/// Both callers can be invoked before the corpus exists, so the directory may
/// be missing on the first run; SQLite would otherwise fail with a bare
/// "unable to open database file".
pub fn open_settings_db(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow!("Failed to create {}: {}", parent.display(), e))?;
    }
    Connection::open(path).map_err(|e| anyhow!("unable to open database file: {}", e))
}

/// Reject anything that is not a bare SQL identifier before it reaches a
/// format string. Table names cannot be bound as parameters.
fn check_table(table: &str) -> Result<()> {
    let ok = !table.is_empty()
        && table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !table.starts_with(|c: char| c.is_ascii_digit());
    if ok {
        Ok(())
    } else {
        Err(anyhow!("not a valid table name: {:?}", table))
    }
}

/// `CREATE TABLE IF NOT EXISTS <table> (key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
pub fn ensure_kv_table(conn: &Connection, table: &str) -> Result<()> {
    check_table(table)?;
    conn.execute(
        &format!("CREATE TABLE IF NOT EXISTS {} (key TEXT PRIMARY KEY, value TEXT NOT NULL)", table),
        [],
    )?;
    Ok(())
}

/// Read one key. `None` when the key is absent (the table must exist).
pub fn get_kv(conn: &Connection, table: &str, key: &str) -> Result<Option<String>> {
    check_table(table)?;
    Ok(conn
        .query_row(&format!("SELECT value FROM {} WHERE key = ?1", table), [key], |row| row.get(0))
        .optional()?)
}

/// Write one key, replacing any existing value.
pub fn set_kv(conn: &Connection, table: &str, key: &str, value: &str) -> Result<()> {
    check_table(table)?;
    conn.execute(
        &format!("INSERT OR REPLACE INTO {} (key, value) VALUES (?1, ?2)", table),
        rusqlite::params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("kashshaf-settings-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn open_creates_the_parent_directory_on_first_run() {
        let base = temp("first-run");
        let db = base.join("nested").join("settings.db");
        assert!(!db.parent().unwrap().exists());
        let conn = open_settings_db(&db).unwrap();
        ensure_kv_table(&conn, "user_settings").unwrap();
        assert!(db.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn kv_round_trips_and_replaces() {
        let base = temp("kv");
        let conn = open_settings_db(&base.join("settings.db")).unwrap();
        ensure_kv_table(&conn, "user_settings").unwrap();
        assert_eq!(get_kv(&conn, "user_settings", "exact_counts").unwrap(), None);
        set_kv(&conn, "user_settings", "exact_counts", "true").unwrap();
        assert_eq!(get_kv(&conn, "user_settings", "exact_counts").unwrap().as_deref(), Some("true"));
        set_kv(&conn, "user_settings", "exact_counts", "false").unwrap();
        assert_eq!(get_kv(&conn, "user_settings", "exact_counts").unwrap().as_deref(), Some("false"));
        // ensure_kv_table is idempotent and keeps the rows
        ensure_kv_table(&conn, "user_settings").unwrap();
        assert_eq!(get_kv(&conn, "user_settings", "exact_counts").unwrap().as_deref(), Some("false"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_table_name_that_is_not_an_identifier_is_refused() {
        let base = temp("ident");
        let conn = open_settings_db(&base.join("settings.db")).unwrap();
        for bad in ["user settings", "x; DROP TABLE y", "", "1st", "a-b", "\"q\""] {
            assert!(ensure_kv_table(&conn, bad).is_err(), "{:?} was accepted", bad);
            assert!(get_kv(&conn, bad, "k").is_err());
            assert!(set_kv(&conn, bad, "k", "v").is_err());
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
