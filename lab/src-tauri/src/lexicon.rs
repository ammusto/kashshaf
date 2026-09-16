//! The lexicons (Lab spec §4.2, §6.5): transmission verbs, formulae, and
//! their storage in `lexicon_entry`.
//!
//! Shipped defaults live in `lexicons/*.json` and are inserted on first run.
//! On every start they are re-synced: a shipped entry missing from the table
//! is inserted; rows with `source = 'user'` and shipped rows the user has
//! disabled are never touched. A shipped entry the user disabled stays
//! disabled across upgrades, which is the point of the rule.
//!
//! The extractor takes a [`Lexicon`] — plain data — so it is testable without
//! a database; [`load`] builds one from the enabled rows.

use anyhow::{Context, Result};
use kashshaf_engine::normalize_arabic;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Core,
    History,
    Written,
    /// Single-link: opens a *citation*, not an isnād (§4.2).
    Citation,
    /// The linking verb of a samāʿ chain: `سمعت فلانا **يقول** سمعت فلانا
    /// **يقول**`. Ṭabaqāt and Sufi biography carry their isnāds this way, and
    /// with only the ḥadīth-shaped core group the chain breaks after one
    /// link and `min_links` throws it away. Its own group because `يقول` is
    /// also ordinary prose, so a genre that does not use samāʿ should be
    /// able to switch it off.
    Sama,
}

impl Group {
    pub fn as_str(self) -> &'static str {
        match self {
            Group::Core => "core",
            Group::History => "history",
            Group::Written => "written",
            Group::Citation => "citation",
            Group::Sama => "sama",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "core" => Some(Group::Core),
            "history" => Some(Group::History),
            "written" => Some(Group::Written),
            "citation" => Some(Group::Citation),
            "sama" => Some(Group::Sama),
            _ => None,
        }
    }
}

/// One row of `lexicon_entry`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub id: Option<i64>,
    /// `transmission` | `formula` | `banal` | `stopword`
    pub kind: String,
    pub grp: Option<String>,
    /// Normalized surfaces; multi-token entries match as sequences.
    pub tokens: Vec<String>,
    pub enabled: bool,
    /// `shipped` | `user`
    pub source: String,
}

/// What the extractor matches on. Everything normalized once, here.
#[derive(Debug, Clone, Default)]
pub struct Lexicon {
    /// `(tokens, group)`, longest entries first so matching is greedy.
    pub transmission: Vec<(Vec<String>, Group)>,
    pub formulas: Vec<Vec<String>>,
    /// sha1 over the enabled entries, stored on every isnād so a later
    /// lexicon change is visible (`isnad.lexicon_hash`, §6.2).
    pub hash: String,
}

impl Lexicon {
    pub fn from_entries<'a, I: IntoIterator<Item = &'a Entry>>(entries: I) -> Self {
        let mut transmission = Vec::new();
        let mut formulas = Vec::new();
        let mut hasher = Sha1::new();
        let mut sorted: Vec<&Entry> = entries.into_iter().filter(|e| e.enabled).collect();
        sorted.sort_by(|a, b| (&a.kind, &a.grp, &a.tokens).cmp(&(&b.kind, &b.grp, &b.tokens)));
        for e in sorted {
            let toks: Vec<String> = e.tokens.iter().map(|t| normalize_arabic(t)).collect();
            hasher.update(e.kind.as_bytes());
            hasher.update(b"|");
            hasher.update(e.grp.as_deref().unwrap_or("").as_bytes());
            hasher.update(b"|");
            hasher.update(toks.join(" ").as_bytes());
            hasher.update(b"\n");
            match e.kind.as_str() {
                "transmission" => {
                    let g = e.grp.as_deref().and_then(Group::parse).unwrap_or(Group::Core);
                    transmission.push((toks, g));
                }
                "formula" => formulas.push(toks),
                _ => {}
            }
        }
        transmission.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        formulas.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        Self { transmission, formulas, hash: hex::encode(hasher.finalize()) }
    }

    /// The shipped defaults alone — what tests and a fresh install use.
    pub fn shipped() -> Self {
        let entries = shipped_entries();
        Self::from_entries(entries.iter())
    }
}

#[derive(Deserialize)]
struct TransmissionFile {
    groups: std::collections::BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct FormulaFile {
    formulas: Vec<Vec<String>>,
}

const TRANSMISSION_JSON: &str = include_str!("../lexicons/transmission.json");
const FORMULAS_JSON: &str = include_str!("../lexicons/formulas.json");

/// Every shipped entry, as rows to insert.
pub fn shipped_entries() -> Vec<Entry> {
    let t: TransmissionFile = serde_json::from_str(TRANSMISSION_JSON).expect("lexicons/transmission.json is valid");
    let f: FormulaFile = serde_json::from_str(FORMULAS_JSON).expect("lexicons/formulas.json is valid");
    let mut out = Vec::new();
    for (grp, items) in &t.groups {
        for item in items {
            out.push(Entry {
                id: None,
                kind: "transmission".into(),
                grp: Some(grp.clone()),
                tokens: item.split_whitespace().map(String::from).collect(),
                enabled: true,
                source: "shipped".into(),
            });
        }
    }
    for toks in f.formulas {
        out.push(Entry { id: None, kind: "formula".into(), grp: None, tokens: toks, enabled: true, source: "shipped".into() });
    }
    out
}

/// §6.5's re-sync: insert shipped entries that are missing; never touch user
/// rows or rows the user disabled. Returns how many were inserted.
pub fn sync_shipped(conn: &Connection) -> Result<usize> {
    let mut inserted = 0;
    let tx_started = conn.execute_batch("BEGIN").is_ok();
    for e in shipped_entries() {
        let tokens_json = serde_json::to_string(&e.tokens)?;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM lexicon_entry WHERE kind = ?1 AND source = 'shipped' AND tokens_json = ?2 \
             AND ((grp IS NULL AND ?3 IS NULL) OR grp = ?3)",
            rusqlite::params![e.kind, tokens_json, e.grp],
            |r| r.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO lexicon_entry (kind, grp, tokens_json, enabled, source) VALUES (?1, ?2, ?3, 1, 'shipped')",
                rusqlite::params![e.kind, e.grp, tokens_json],
            )?;
            inserted += 1;
        }
    }
    if tx_started {
        conn.execute_batch("COMMIT")?;
    }
    Ok(inserted)
}

/// Every row of one kind (or all kinds), for the settings editor.
pub fn list(conn: &Connection, kind: Option<&str>) -> Result<Vec<Entry>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, grp, tokens_json, enabled, source FROM lexicon_entry \
         WHERE (?1 IS NULL OR kind = ?1) ORDER BY kind, grp, id",
    )?;
    let rows = stmt
        .query_map([kind], |r| {
            let tokens_json: String = r.get(3)?;
            Ok(Entry {
                id: Some(r.get(0)?),
                kind: r.get(1)?,
                grp: r.get(2)?,
                tokens: serde_json::from_str(&tokens_json).unwrap_or_default(),
                enabled: r.get::<_, i64>(4)? != 0,
                source: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The lexicon the extractor uses: every enabled transmission and formula row.
pub fn load(conn: &Connection) -> Result<Lexicon> {
    let entries = list(conn, None).context("reading lexicon_entry")?;
    Ok(Lexicon::from_entries(entries.iter()))
}

pub fn add_user_entry(conn: &Connection, kind: &str, grp: Option<&str>, tokens: &[String]) -> Result<i64> {
    let tokens: Vec<String> = tokens.iter().map(|t| normalize_arabic(t)).filter(|t| !t.is_empty()).collect();
    conn.execute(
        "INSERT INTO lexicon_entry (kind, grp, tokens_json, enabled, source) VALUES (?1, ?2, ?3, 1, 'user')",
        rusqlite::params![kind, grp, serde_json::to_string(&tokens)?],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn set_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<()> {
    conn.execute("UPDATE lexicon_entry SET enabled = ?2 WHERE id = ?1", rusqlite::params![id, enabled as i64])?;
    Ok(())
}

/// Delete a user entry. Shipped entries are disabled, not deleted, so the
/// re-sync cannot bring them back enabled.
pub fn delete_user_entry(conn: &Connection, id: i64) -> Result<bool> {
    let n = conn.execute("DELETE FROM lexicon_entry WHERE id = ?1 AND source = 'user'", [id])?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_lexicon_has_the_groups_and_the_formulae_of_the_spec() {
        let lex = Lexicon::shipped();
        let has = |w: &str, g: Group| lex.transmission.iter().any(|(t, grp)| t.join(" ") == w && *grp == g);
        assert!(has("حدثنا", Group::Core));
        assert!(has("ثنا", Group::Core));
        assert!(has("انشدنا", Group::History));
        assert!(has("قرات علي", Group::Written));
        assert!(has("بلغني", Group::Citation));
        assert!(lex.formulas.iter().any(|f| f.join(" ") == "صلي الله عليه وسلم"));
        assert!(lex.formulas.iter().any(|f| f == &vec!["يعني".to_string()]));
        // Longest first, so a multi-token entry beats its own prefix.
        assert!(lex.transmission[0].0.len() >= lex.transmission.last().unwrap().0.len());
        assert_eq!(lex.hash.len(), 40);
    }

    #[test]
    fn the_hash_changes_with_the_entries_and_ignores_disabled_ones() {
        let mut entries = shipped_entries();
        let base = Lexicon::from_entries(entries.iter()).hash;
        entries[0].enabled = false;
        let disabled = Lexicon::from_entries(entries.iter()).hash;
        assert_ne!(base, disabled);
        entries.push(Entry { id: None, kind: "transmission".into(), grp: Some("core".into()), tokens: vec!["نبئت".into()], enabled: true, source: "user".into() });
        assert_ne!(Lexicon::from_entries(entries.iter()).hash, disabled);
    }

    #[test]
    fn re_sync_inserts_what_is_missing_and_leaves_user_choices_alone() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE lexicon_entry (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, grp TEXT, tokens_json TEXT NOT NULL, \
             enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL)",
        )
        .unwrap();
        let n = sync_shipped(&conn).unwrap();
        assert_eq!(n, shipped_entries().len());
        assert_eq!(sync_shipped(&conn).unwrap(), 0, "a second sync inserts nothing");

        // The user disables حدثنا and adds an entry of their own.
        conn.execute("UPDATE lexicon_entry SET enabled = 0 WHERE tokens_json = ?1", [serde_json::to_string(&["حدثنا"]).unwrap()]).unwrap();
        let user_id = add_user_entry(&conn, "transmission", Some("core"), &["نبئت".into()]).unwrap();
        conn.execute("DELETE FROM lexicon_entry WHERE tokens_json = ?1 AND source='shipped'", [serde_json::to_string(&["ثنا"]).unwrap()]).unwrap();

        // Re-sync: ثنا comes back (it was missing), حدثنا stays disabled, the user row stays.
        assert_eq!(sync_shipped(&conn).unwrap(), 1);
        let all = list(&conn, Some("transmission")).unwrap();
        let hd = all.iter().find(|e| e.tokens == vec!["حدثنا"]).unwrap();
        assert!(!hd.enabled, "a user-disabled shipped row is not re-enabled");
        assert!(all.iter().any(|e| e.tokens == vec!["ثنا"] && e.enabled));
        assert!(all.iter().any(|e| e.id == Some(user_id) && e.source == "user"));

        let lex = load(&conn).unwrap();
        assert!(!lex.transmission.iter().any(|(t, _)| t == &vec!["حدثنا".to_string()]));
        // Entries are normalized on the way in: ئ folds to ي.
        assert!(lex.transmission.iter().any(|(t, _)| t == &vec![normalize_arabic("نبئت")]));

        assert!(delete_user_entry(&conn, user_id).unwrap());
        assert!(!delete_user_entry(&conn, hd.id.unwrap()).unwrap(), "shipped rows are not deleted");
    }
}
