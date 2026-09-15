//! `analysis.db` (Lab spec §6).
//!
//! SQLite in Lab's own directory, WAL, `foreign_keys=ON`, schema version in
//! `lab_info`, migrations forward-only and numbered, applied at startup.
//!
//! - Migration 1 (Phase 0): `lab_info`, `lab_setting`.
//! - Migration 2 (Phase 2): the isnād tables (§6.2), the authority file (§6.3)
//!   and the lexicon (§6.5). The shipped lexicon entries are inserted on first
//!   run and re-synced on every start without touching user rows or
//!   user-disabled shipped rows.
//! - Migration 3 (Phase 3): text reuse and Qurʾān quotation tables (§6.4).
//! - Migration 5 (Phase 5, spec 1.5): `note` — the reader's annotations.
//! - Migration 4 (Phase 4, amendment 1.4): spans that cross a page break —
//!   end-page columns on `isnad` (chain and matn), a page and a place on
//!   `transmitter`; `ayas_json` on `quran_match` for ambiguous hits.

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// One forward-only migration. Never edit a shipped entry: add the next one.
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

/// Every span-bearing table shares these (spec §6): the anchor, plus a
/// surface snapshot for re-anchoring across corpus versions (§6.1).
const ANCHOR_COLUMNS: &str = r#"
            corpus_version TEXT NOT NULL,
            book_id INTEGER NOT NULL, part_index INTEGER NOT NULL, page_id INTEGER NOT NULL,
            tok_start INTEGER NOT NULL, tok_end INTEGER NOT NULL,
            snapshot TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,"#;

const MIGRATIONS: &[Migration] = &[
    Migration {
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
    },
    Migration {
        version: 2,
        name: "isnad, transmitter, person, name_form, equivalence_log, lexicon_entry",
        // The anchor columns are spliced in by `migration_sql`.
        sql: r#"
        CREATE TABLE IF NOT EXISTS person (
            id INTEGER PRIMARY KEY,
            canonical_name TEXT NOT NULL,
            death_ah INTEGER, notes TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS name_form (
            id INTEGER PRIMARY KEY,
            person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
            form TEXT NOT NULL,
            form_norm TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user','auto')),
            UNIQUE(person_id, form_norm)
        );
        CREATE INDEX IF NOT EXISTS name_form_norm ON name_form(form_norm);
        CREATE TABLE IF NOT EXISTS equivalence_log (
            id INTEGER PRIMARY KEY, at TEXT NOT NULL,
            action TEXT NOT NULL,
            detail_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS isnad (
            id INTEGER PRIMARY KEY,
            @ANCHOR@
            kind TEXT NOT NULL CHECK (kind IN ('isnad','citation')),
            matn_tok_start INTEGER, matn_tok_end INTEGER,
            links INTEGER NOT NULL,
            confidence REAL NOT NULL, confidence_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','rejected','orphaned')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            extractor_version TEXT NOT NULL, lexicon_hash TEXT NOT NULL,
            reanchored_from_version TEXT,
            overrides_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS isnad_book ON isnad(book_id, part_index, page_id);
        CREATE INDEX IF NOT EXISTS isnad_status ON isnad(book_id, status);
        CREATE TABLE IF NOT EXISTS transmitter (
            id INTEGER PRIMARY KEY,
            isnad_id INTEGER NOT NULL REFERENCES isnad(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            tok_start INTEGER NOT NULL, tok_end INTEGER NOT NULL,
            raw TEXT NOT NULL,
            kunya TEXT, ism TEXT, nasab TEXT, nisba TEXT, laqab TEXT,
            verb_before TEXT,
            person_id INTEGER REFERENCES person(id)
        );
        CREATE INDEX IF NOT EXISTS transmitter_person ON transmitter(person_id);
        CREATE INDEX IF NOT EXISTS transmitter_isnad ON transmitter(isnad_id, position);
        CREATE TABLE IF NOT EXISTS lexicon_entry (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('transmission','formula','banal','stopword')),
            grp TEXT,
            tokens_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL CHECK (source IN ('shipped','user'))
        );
        CREATE INDEX IF NOT EXISTS lexicon_kind ON lexicon_entry(kind, source);
    "#,
    },
    Migration {
        version: 3,
        name: "reuse_run, reuse_match, reuse_gold, quran_match",
        // §6.4 verbatim, plus: an index on the query page (the reader layer
        // draws from it); `banal_share`, `aligned`, `anchor_hits` and the
        // aligned pairs on `reuse_match`, so a match can be re-scored and
        // redrawn without re-running; `created_at` and `detector_version` on
        // `quran_match` (a whole-book run is repeatable, and the rows must
        // say which detector wrote them), and a uniqueness rule on
        // `quran_match` so a re-run cannot duplicate a span the user has
        // already judged.
        sql: r#"
        CREATE TABLE IF NOT EXISTS reuse_run (
            id INTEGER PRIMARY KEY,
            corpus_version TEXT NOT NULL, book_id INTEGER NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('passage','book')),
            params_json TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('running','done','cancelled','failed'))
        );
        CREATE INDEX IF NOT EXISTS reuse_run_book ON reuse_run(book_id, mode);
        CREATE TABLE IF NOT EXISTS reuse_match (
            id INTEGER PRIMARY KEY,
            run_id INTEGER NOT NULL REFERENCES reuse_run(id) ON DELETE CASCADE,
            @ANCHOR@
            target_book_id INTEGER NOT NULL, target_part_index INTEGER NOT NULL,
            target_page_id INTEGER NOT NULL, target_tok_start INTEGER NOT NULL, target_tok_end INTEGER NOT NULL,
            score REAL NOT NULL, type TEXT NOT NULL,
            surface_agree REAL, lemma_agree REAL, root_agree REAL, coverage REAL, banality_factor REAL,
            banal_share REAL, aligned INTEGER, anchor_hits INTEGER, pairs_json TEXT,
            zone TEXT,
            user_verdict TEXT CHECK (user_verdict IN ('confirmed','rejected'))
        );
        CREATE INDEX IF NOT EXISTS reuse_match_target ON reuse_match(target_book_id);
        CREATE INDEX IF NOT EXISTS reuse_match_run ON reuse_match(run_id);
        CREATE INDEX IF NOT EXISTS reuse_match_page ON reuse_match(book_id, part_index, page_id);
        CREATE TABLE IF NOT EXISTS reuse_gold (
            id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
            q_json TEXT NOT NULL, t_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quran_match (
            id INTEGER PRIMARY KEY,
            @ANCHOR@
            sura INTEGER NOT NULL, aya_start INTEGER NOT NULL, aya_end INTEGER NOT NULL,
            q_tok_start INTEGER NOT NULL, q_tok_end INTEGER NOT NULL,
            lemma_agree REAL NOT NULL, surface_agree REAL NOT NULL, cue TEXT,
            user_verdict TEXT CHECK (user_verdict IN ('confirmed','rejected')),
            created_at TEXT NOT NULL, detector_version TEXT NOT NULL,
            UNIQUE (book_id, part_index, page_id, tok_start, tok_end, sura, aya_start)
        );
        CREATE INDEX IF NOT EXISTS quran_match_page ON quran_match(book_id, part_index, page_id);
        CREATE INDEX IF NOT EXISTS quran_match_book ON quran_match(book_id, sura, aya_start);
    "#,
    },
    Migration {
        version: 4,
        name: "end pages on isnad, page and place on transmitter, ayas_json on quran_match",
        // Token offsets in `isnad` and `transmitter` are stream offsets from
        // the start page's token 0 and may run past its end; the end columns
        // name the page the last token falls on. NULL = the start page (rows
        // written before this migration).
        sql: r#"
        ALTER TABLE isnad ADD COLUMN end_part_index INTEGER;
        ALTER TABLE isnad ADD COLUMN end_page_id INTEGER;
        ALTER TABLE isnad ADD COLUMN matn_end_part_index INTEGER;
        ALTER TABLE isnad ADD COLUMN matn_end_page_id INTEGER;
        ALTER TABLE transmitter ADD COLUMN part_index INTEGER;
        ALTER TABLE transmitter ADD COLUMN page_id INTEGER;
        ALTER TABLE transmitter ADD COLUMN place TEXT;
        ALTER TABLE quran_match ADD COLUMN ayas_json TEXT;
    "#,
    },
    Migration {
        version: 5,
        name: "note",
        // Annotations on a token range (spec 1.5 C4). Anchored like every
        // other span so re-anchoring (6.1) moves them with the corpus, and
        // mirrored into the workspace's notes.json.
        sql: r#"
        CREATE TABLE IF NOT EXISTS note (
            id INTEGER PRIMARY KEY,
            @ANCHOR@
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            reanchored_from_version TEXT
        );
        CREATE INDEX IF NOT EXISTS note_page ON note(book_id, part_index, page_id);
    "#,
    },
    Migration {
        version: 6,
        name: "note colour and formatted text",
        // The highlight the annotation draws in the reader (9 B3). Notes
        // written before this are yellow, which is what they were drawn in.
        //
        // `note.text` is unchanged in shape and now carries formatting, in
        // the smallest markup that round-trips: **bold** and __underline__.
        // Text written before this reads as itself, because plain text is
        // valid in that markup.
        sql: r#"
        ALTER TABLE note ADD COLUMN color TEXT NOT NULL DEFAULT 'yellow';
    "#,
    },
];

fn migration_sql(m: &Migration) -> String {
    m.sql.replace("@ANCHOR@", ANCHOR_COLUMNS)
}

/// The schema version a fresh database is created at.
pub fn target_schema_version() -> i64 {
    MIGRATIONS.iter().map(|m| m.version).max().unwrap_or(0)
}

#[derive(Debug)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    /// Open (creating if absent) `analysis.db` under `dir`, migrate it, and
    /// re-sync the shipped lexicon.
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("analysis.db");
        let store = Self { path };
        let conn = store.connect()?;
        migrate(&conn)?;
        crate::lexicon::sync_shipped(&conn)?;
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
            conn.execute_batch(&migration_sql(m))?;
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

/// Now, as every timestamp column stores it.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
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

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
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
        for t in ["isnad", "transmitter", "person", "name_form", "equivalence_log", "lexicon_entry", "lab_setting"] {
            assert!(tables(&conn).contains(&t.to_string()), "missing table {}", t);
        }
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

    /// Spec §9 "Migrations": a database from the Phase 0 schema (version 1)
    /// migrates to the current one without losing what it held.
    #[test]
    fn a_phase_0_database_migrates_without_loss() {
        let dir = temp("from-v1");
        let path = dir.join("analysis.db");
        {
            // Exactly what Phase 0 created: migration 1 alone, with a setting.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&migration_sql(&MIGRATIONS[0])).unwrap();
            conn.execute("INSERT INTO lab_info (key, value) VALUES ('schema_version', '1')", []).unwrap();
            conn.execute("INSERT INTO lab_info (key, value) VALUES ('created_at', '2026-09-13T00:00:00Z')", []).unwrap();
            conn.execute("INSERT INTO lab_setting (key, value) VALUES ('stopwords', '[\"في\"]')", []).unwrap();
            assert!(!tables(&conn).contains(&"isnad".to_string()));
        }
        let store = Store::open(&dir).unwrap();
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let conn = store.connect().unwrap();
        let v: String = conn.query_row("SELECT value FROM lab_setting WHERE key='stopwords'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "[\"في\"]", "the Phase 0 setting survives");
        let created: String = conn.query_row("SELECT value FROM lab_info WHERE key='created_at'", [], |r| r.get(0)).unwrap();
        assert_eq!(created, "2026-09-13T00:00:00Z", "created_at is not rewritten by a later migration");
        assert!(tables(&conn).contains(&"isnad".to_string()));
        // The shipped lexicon arrived with the migration.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM lexicon_entry WHERE source='shipped'", [], |r| r.get(0)).unwrap();
        assert!(n > 40, "shipped lexicon has {} entries", n);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A Phase 2 database (schema 2, with an isnād and its lexicon) gains the
    /// §6.4 tables and keeps its rows.
    #[test]
    fn a_phase_2_database_migrates_to_the_reuse_schema_without_loss() {
        let dir = temp("from-v2");
        let path = dir.join("analysis.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..2] {
                conn.execute_batch(&migration_sql(m)).unwrap();
            }
            conn.execute("INSERT INTO lab_info (key, value) VALUES ('schema_version', '2')", []).unwrap();
            conn.execute(
                "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 kind, links, confidence, confidence_json, status, created_at, updated_at, extractor_version, lexicon_hash) \
                 VALUES ('4.1.0', 1, 0, 1, 0, 5, 'x', 'h', 'isnad', 2, 0.5, '{}', 'confirmed', 't', 't', 'v', 'l')",
                [],
            )
            .unwrap();
            assert!(!tables(&conn).contains(&"reuse_match".to_string()));
        }
        let store = Store::open(&dir).unwrap();
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let conn = store.connect().unwrap();
        let t = tables(&conn);
        for name in ["reuse_run", "reuse_match", "reuse_gold", "quran_match"] {
            assert!(t.contains(&name.to_string()), "{} exists", name);
        }
        let status: String = conn.query_row("SELECT status FROM isnad WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "confirmed", "the Phase 2 isnād survives");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A Phase 3 database (schema 3) gains the end-page columns and keeps
    /// its rows; a row written before has NULL ends, meaning the start page.
    #[test]
    fn a_phase_3_database_migrates_to_the_end_page_schema() {
        let dir = temp("from-v3");
        let path = dir.join("analysis.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..3] {
                conn.execute_batch(&migration_sql(m)).unwrap();
            }
            conn.execute("INSERT INTO lab_info (key, value) VALUES ('schema_version', '3')", []).unwrap();
            conn.execute(
                "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 kind, links, confidence, confidence_json, status, created_at, updated_at, extractor_version, lexicon_hash) \
                 VALUES ('4.1.0', 1, 0, 1, 0, 5, 'x', 'h', 'isnad', 2, 0.5, '{}', 'confirmed', 't', 't', 'v', 'l')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO transmitter (isnad_id, position, tok_start, tok_end, raw) VALUES (1, 0, 1, 3, 'x')", []).unwrap();
        }
        let store = Store::open(&dir).unwrap();
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let conn = store.connect().unwrap();
        let (end, place): (Option<i64>, Option<String>) = conn
            .query_row("SELECT i.end_page_id, t.place FROM isnad i JOIN transmitter t ON t.isnad_id = i.id WHERE i.id = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(end, None, "an old row's end is its start page");
        assert_eq!(place, None);
        conn.execute("UPDATE isnad SET end_part_index = 0, end_page_id = 2 WHERE id = 1", []).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Spec 1.5 C4: notes are anchored like every other span, and a
    /// database from Phase 4 gains the table with its rows intact.
    #[test]
    fn a_phase_4_database_gains_the_note_table() {
        let dir = temp("from-v4");
        let path = dir.join("analysis.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..4] {
                conn.execute_batch(&migration_sql(m)).unwrap();
            }
            conn.execute("INSERT INTO lab_info (key, value) VALUES ('schema_version', '4')", []).unwrap();
            conn.execute(
                "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                 kind, links, confidence, confidence_json, status, created_at, updated_at, extractor_version, lexicon_hash) \
                 VALUES ('4.1.0', 1, 0, 1, 0, 5, 'x', 'h', 'isnad', 2, 0.5, '{}', 'confirmed', 't', 't', 'v', 'l')",
                [],
            )
            .unwrap();
            assert!(!tables(&conn).contains(&"note".to_string()));
        }
        let store = Store::open(&dir).unwrap();
        assert_eq!(store.schema_version().unwrap(), target_schema_version());
        let conn = store.connect().unwrap();
        assert!(tables(&conn).contains(&"note".to_string()));
        let status: String = conn.query_row("SELECT status FROM isnad WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "confirmed", "the Phase 4 isnad survives");
        conn.execute(
            "INSERT INTO note (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
             text, created_at, updated_at) VALUES ('4.1.0', 1, 0, 1, 3, 7, 's', 'h', 'a note', 't', 't')",
            [],
        )
        .unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM note WHERE book_id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reuse_matches_go_with_their_run_and_verdicts_are_checked() {
        let dir = temp("reuse-fk");
        let store = Store::open(&dir).unwrap();
        let conn = store.connect().unwrap();
        conn.execute(
            "INSERT INTO reuse_run (corpus_version, book_id, mode, params_json, started_at, status) \
             VALUES ('4.1.0', 1, 'passage', '{}', 't', 'running')",
            [],
        )
        .unwrap();
        assert!(
            conn.execute(
                "INSERT INTO reuse_run (corpus_version, book_id, mode, params_json, started_at, status) \
                 VALUES ('4.1.0', 1, 'window', '{}', 't', 'running')",
                [],
            )
            .is_err(),
            "mode is checked"
        );
        conn.execute(
            "INSERT INTO reuse_match (run_id, corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
             target_book_id, target_part_index, target_page_id, target_tok_start, target_tok_end, score, type) \
             VALUES (1, '4.1.0', 1, 0, 1, 0, 10, 's', 'h', 2, 0, 7, 3, 13, 0.8, 'verbatim')",
            [],
        )
        .unwrap();
        assert!(conn.execute("UPDATE reuse_match SET user_verdict = 'maybe' WHERE id = 1", []).is_err());
        conn.execute("UPDATE reuse_match SET user_verdict = 'confirmed' WHERE id = 1", []).unwrap();
        conn.execute("DELETE FROM reuse_run WHERE id = 1", []).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM reuse_match", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "matches go with their run");

        // quran_match: the same span against the same āya is stored once.
        let ins = "INSERT INTO quran_match (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
             sura, aya_start, aya_end, q_tok_start, q_tok_end, lemma_agree, surface_agree, cue, created_at, detector_version) \
             VALUES ('4.1.0', 1, 0, 1, 4, 9, 's', 'h', 2, 255, 255, 0, 5, 1.0, 0.9, NULL, 't', '0.1.0')";
        conn.execute(ins, []).unwrap();
        assert!(conn.execute(ins, []).is_err(), "duplicate span+āya is refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_keys_cascade_from_isnad_to_transmitter() {
        let dir = temp("fk");
        let store = Store::open(&dir).unwrap();
        let conn = store.connect().unwrap();
        conn.execute(
            "INSERT INTO isnad (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
             kind, links, confidence, confidence_json, status, created_at, updated_at, extractor_version, lexicon_hash) \
             VALUES ('4.1.0', 1, 0, 1, 0, 5, 'x', 'h', 'isnad', 2, 0.5, '{}', 'candidate', 't', 't', 'v', 'l')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transmitter (isnad_id, position, tok_start, tok_end, raw) VALUES (1, 0, 1, 3, 'x')",
            [],
        )
        .unwrap();
        // A transmitter cannot point at a missing person.
        assert!(conn.execute("UPDATE transmitter SET person_id = 99 WHERE id = 1", []).is_err());
        conn.execute("DELETE FROM isnad WHERE id = 1", []).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM transmitter", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "transmitters go with their isnād");
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
