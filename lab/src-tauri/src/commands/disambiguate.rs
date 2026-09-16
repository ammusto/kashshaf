//! The name disambiguator's bridge (Phase 10 A).
//!
//! Reads the open book's transmitter rows, ranks the forms against one
//! another with [`crate::analysis::disambiguate`], and records the two
//! verdicts a reader can give: these forms are one person, or this pair is
//! not and should never be offered again.
//!
//! "Same person" is an [`Op`], so it undoes like everything else in the
//! workbench and lands in `equivalence_log` with the rest.

use crate::analysis::disambiguate::{self as dis, Candidate, FormRow, Link};
use crate::commands::isnad::{db, dberr};
use crate::error::LabError;
use crate::state::{handles, Handles, ManagedLabState};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use tauri::State;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LabError> + Send + 'static) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))? }
}

/// Every transmitter of the book that is not in a rejected isnād: the
/// disambiguator works on what is on the page, decided or not, because
/// deciding who these people are is what it is for.
pub(crate) fn links(conn: &Connection, book_id: u64) -> Result<Vec<Link>, LabError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.isnad_id, t.position, t.person_id, t.raw, COALESCE(t.part_index, i.part_index), COALESCE(t.page_id, i.page_id), t.id \
             FROM transmitter t JOIN isnad i ON i.id = t.isnad_id \
             WHERE i.book_id = ?1 AND i.status != 'rejected' ORDER BY t.isnad_id, t.position",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![book_id as i64], |r| {
            let raw: String = r.get(3)?;
            Ok(Link {
                transmitter_id: r.get(6)?,
                isnad_id: r.get(0)?,
                position: r.get::<_, i64>(1)? as usize,
                person_id: r.get(2)?,
                form_norm: crate::analysis::names::form_norm(&raw),
                raw,
                part_index: r.get::<_, i64>(4)? as u32,
                page_id: r.get::<_, i64>(5)? as u64,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

pub(crate) fn person_names(conn: &Connection) -> Result<HashMap<i64, String>, LabError> {
    let mut stmt = conn.prepare("SELECT id, canonical_name FROM person").map_err(dberr)?;
    let mut out = HashMap::new();
    for r in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(dberr)? {
        let (id, n) = r.map_err(dberr)?;
        out.insert(id, n);
    }
    Ok(out)
}

fn distinctions(conn: &Connection) -> Result<HashSet<(String, String)>, LabError> {
    let mut stmt = conn.prepare("SELECT form_norm_a, form_norm_b FROM name_distinction").map_err(dberr)?;
    let mut out = HashSet::new();
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(dberr)? {
        out.insert(r.map_err(dberr)?);
    }
    Ok(out)
}

/// Every distinct name form in the book, commonest first.
#[tauri::command]
pub async fn disambiguation_forms(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<FormRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        Ok(dis::forms(&links(&conn, book_id)?, &person_names(&conn)?))
    })
    .await
}

/// The forms that might be the same person as this one, best first.
#[tauri::command]
pub async fn disambiguation_candidates(state: State<'_, ManagedLabState>, book_id: u64, form_norm: String) -> Result<Vec<Candidate>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        Ok(dis::candidates(&links(&conn, book_id)?, &form_norm, &distinctions(&conn)?, &person_names(&conn)?))
    })
    .await
}

/// "Not the same": record it, so the pair is never offered again.
#[tauri::command]
pub async fn name_distinction_add(state: State<'_, ManagedLabState>, book_id: u64, forms: Vec<String>) -> Result<usize, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut n = 0;
        // Every pair in the selection, not just the first two: saying four
        // names are four people says it of each pair.
        for i in 0..forms.len() {
            for j in (i + 1)..forms.len() {
                let (a, b) = dis::pair(&forms[i], &forms[j]);
                n += conn
                    .execute(
                        "INSERT OR IGNORE INTO name_distinction (form_norm_a, form_norm_b, created_at) VALUES (?1, ?2, ?3)",
                        params![a, b, crate::store::now()],
                    )
                    .map_err(dberr)?;
            }
        }
        conn.execute(
            "INSERT INTO equivalence_log (at, action, detail_json) VALUES (?1, ?2, ?3)",
            params![crate::store::now(), "not_same", serde_json::to_string(&forms).unwrap_or_default()],
        )
        .map_err(dberr)?;
        crate::commands::workspace::mirror(&h, book_id, crate::workspace::Part::Isnads);
        Ok(n)
    })
    .await
}

/// Undo a "not the same", so the pair can be ranked again.
#[tauri::command]
pub async fn name_distinction_remove(state: State<'_, ManagedLabState>, forms: Vec<String>) -> Result<usize, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut n = 0;
        for i in 0..forms.len() {
            for j in (i + 1)..forms.len() {
                let (a, b) = dis::pair(&forms[i], &forms[j]);
                n += conn
                    .execute("DELETE FROM name_distinction WHERE form_norm_a = ?1 AND form_norm_b = ?2", params![a, b])
                    .map_err(dberr)?;
            }
        }
        Ok(n)
    })
    .await
}

/// Every pair a reader has ruled apart, for the list to mark.
#[tauri::command]
pub async fn name_distinctions(state: State<'_, ManagedLabState>) -> Result<Vec<(String, String)>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut v: Vec<(String, String)> = distinctions(&conn)?.into_iter().collect();
        v.sort();
        Ok(v)
    })
    .await
}

/// The rows behind "Same person": every transmitter in the book carrying one
/// of these forms, and the person each already points at.
pub(crate) fn rows_for_forms(conn: &Connection, book_id: u64, forms: &[String]) -> Result<Vec<Link>, LabError> {
    let want: HashSet<&str> = forms.iter().map(|s| s.as_str()).collect();
    Ok(links(conn, book_id)?.into_iter().filter(|l| want.contains(l.form_norm.as_str())).collect())
}

/// Which person the merged forms should end up as: the one already carrying
/// the most rows, or none when nothing is linked yet.
pub(crate) fn target_person(rows: &[Link]) -> Option<i64> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for r in rows {
        if let Some(p) = r.person_id {
            *counts.entry(p).or_insert(0) += 1;
        }
    }
    counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0))).map(|(p, _)| p)
}

/// The transmitter whose raw form names a new person: the commonest form's
/// first row.
pub(crate) fn naming_row(conn: &Connection, book_id: u64, forms: &[String], names: &HashMap<i64, String>) -> Result<Option<(i64, String)>, LabError> {
    let rows = rows_for_forms(conn, book_id, forms)?;
    let counted = dis::forms(&rows, names);
    let Some(best) = counted.first() else { return Ok(None) };
    let first = rows.iter().find(|r| r.form_norm == best.form_norm && r.raw == best.raw);
    let Some(first) = first else { return Ok(None) };
    let id: i64 = conn
        .query_row(
            "SELECT t.id FROM transmitter t JOIN isnad i ON i.id = t.isnad_id WHERE i.book_id = ?1 AND t.isnad_id = ?2 AND t.position = ?3 LIMIT 1",
            params![book_id as i64, first.isnad_id, first.position as i64],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    Ok(Some((id, first.raw.clone())))
}

/// Every transmitter id in the book carrying one of these forms.
pub(crate) fn transmitter_ids(conn: &Connection, book_id: u64, forms: &[String]) -> Result<Vec<i64>, LabError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.raw FROM transmitter t JOIN isnad i ON i.id = t.isnad_id \
             WHERE i.book_id = ?1 AND i.status != 'rejected' ORDER BY t.id",
        )
        .map_err(dberr)?;
    let want: HashSet<&str> = forms.iter().map(|s| s.as_str()).collect();
    let rows = stmt
        .query_map(params![book_id as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows.into_iter().filter(|(_, raw)| want.contains(crate::analysis::names::form_norm(raw).as_str())).map(|(id, _)| id).collect())
}

/// Every person the given forms are linked to, apart from `keep`.
pub(crate) fn other_persons(h: &Handles, conn: &Connection, book_id: u64, forms: &[String], keep: i64) -> Result<Vec<i64>, LabError> {
    let _ = h;
    let rows = rows_for_forms(conn, book_id, forms)?;
    let mut out: Vec<i64> = rows.iter().filter_map(|r| r.person_id).filter(|p| *p != keep).collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod diagnostics {
    //! Not a test of anything: a way to look at the ranker's output on the
    //! real annotations, which is the only place the question "is this the
    //! same man" has real answers in it.
    use super::*;
    use crate::analysis::disambiguate as dis;

    fn open() -> Option<Connection> {
        let path = std::env::var("KASHSHAF_LAB_DB").ok()?;
        Connection::open(path).ok()
    }

    fn show(conn: &Connection, book: u64, raw: &str) {
        let links = links(conn, book).unwrap();
        let names = person_names(conn).unwrap();
        let target = crate::analysis::names::form_norm(raw);
        let c = dis::candidates(&links, &target, &HashSet::new(), &names);
        println!("\n=== {} ({} in book {}) : {} candidates", raw, target, book, c.len());
        for (i, x) in c.iter().take(10).enumerate() {
            println!(
                "{:2}. {:<44} x{:<4} company {:.2}  shared {}+{}  matched [{}]{}",
                i + 1,
                x.raw,
                x.count,
                x.score,
                x.shared_from,
                x.shared_to,
                x.matched.join(", "),
                x.confusable.as_ref().map(|c| format!("  CONFUSABLE {}", c)).unwrap_or_default()
            );
        }
    }

    #[test]
    #[ignore]
    fn rank_two_real_names() {
        let Some(conn) = open() else {
            println!("set KASHSHAF_LAB_DB to run this");
            return;
        };
        show(&conn, 1820, "الجنيد");
        show(&conn, 1820, "الحسن بن محمد");
        show(&conn, 1820, "الحسن بن علي");
        show(&conn, 1820, "احمد بن علي بن جعفر");
    }

    #[test]
    #[ignore]
    fn rank_how_many_pairs_survive() {
        let Some(conn) = open() else {
            println!("set KASHSHAF_LAB_DB to run this");
            return;
        };
        let books: Vec<u64> = {
            let mut st = conn.prepare("SELECT DISTINCT book_id FROM isnad ORDER BY book_id").unwrap();
            st.query_map([], |r| r.get::<_, i64>(0)).unwrap().map(|x| x.unwrap() as u64).collect()
        };
        let names = person_names(&conn).unwrap();
        let (mut pairs, mut kept, mut confused) = (0usize, 0usize, 0usize);
        for b in &books {
            let links = links(&conn, *b).unwrap();
            let forms = dis::forms(&links, &names);
            pairs += forms.len() * forms.len().saturating_sub(1) / 2;
            for f in &forms {
                let c = dis::candidates(&links, &f.form_norm, &HashSet::new(), &names);
                // Each unordered pair is seen from both ends.
                kept += c.iter().filter(|x| x.confusable.is_none()).count();
                confused += c.iter().filter(|x| x.confusable.is_some()).count();
            }
            println!("book {}: {} forms", b, forms.len());
        }
        println!(
            "\ncorpus-wide: {} pairs examined, {} survive the gate, {} more are commonly confused",
            pairs,
            kept / 2,
            confused / 2
        );
    }
}
