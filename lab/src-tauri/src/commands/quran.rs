//! Qurʾān quotation commands (Lab spec §4.4, §6.4, §7.6).
//!
//! A whole-book run streams like isnād extraction: per page, results into
//! `quran_match`, progress on `quran-progress`, cancel keeps completed pages.
//! Rows the user has judged survive a re-run (the uniqueness rule in §6.4's
//! migration makes the re-insert a no-op).

use crate::analysis::quran::{self, Params, DETECTOR_VERSION};
use crate::commands::isnad::{db, dberr, snapshot};
use crate::error::LabError;
use crate::source::FreqLayer;
use crate::state::{handles, quran as quran_cell, ManagedLabState};
use crate::store::now;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{Emitter, State, Window};

const PROGRESS_EVENT: &str = "quran-progress";

#[derive(Debug, Clone, Serialize)]
pub struct RunProgress {
    pub done: u64,
    pub total: u64,
    pub found: u64,
    pub estimate_ms: Option<u64>,
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LabError> + Send + 'static) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))? }
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub available: bool,
    pub error: Option<String>,
    pub tokens: usize,
    pub ayas: usize,
    pub trigrams: usize,
    pub fourgrams: usize,
    pub fivegrams: usize,
    pub ingest_version: Option<String>,
    pub detector_version: &'static str,
}

/// Whether the shipped Qurʾān loaded, and the index's size.
#[tauri::command]
pub async fn quran_status(state: State<'_, ManagedLabState>) -> Result<Status, LabError> {
    let cell = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?.quran.clone();
    blocking(move || match quran_cell(&cell) {
        Ok(q) => Ok(Status {
            available: true,
            error: None,
            tokens: q.text.token_count(),
            ayas: q.text.ayas.len(),
            trigrams: q.index.trigram_count(),
            fourgrams: q.index.fourgram_count(),
            fivegrams: q.index.fivegram_count(),
            ingest_version: q.text.info.get("ingest_version").cloned(),
            detector_version: DETECTOR_VERSION,
        }),
        Err(e) => Ok(Status { available: false, error: Some(e.to_string()), tokens: 0, ayas: 0, trigrams: 0, fourgrams: 0, fivegrams: 0, ingest_version: None, detector_version: DETECTOR_VERSION }),
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct RunSummary {
    pub book_id: u64,
    pub pages: usize,
    pub pages_done: usize,
    pub hits: usize,
    pub kept_judged: usize,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub detector_version: &'static str,
}

/// Detect quotations across the current book (§4.4 whole-book run).
#[tauri::command]
pub async fn quran_run(window: Window, state: State<'_, ManagedLabState>, book_id: u64, params: Option<Params>) -> Result<RunSummary, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let q = quran_cell(&h.quran)?;
        let book = crate::commands::stats::load_book(&h, Some(&window), book_id)?;
        let conn = db(&h)?;
        let params = params.unwrap_or_default();
        let freq = h.source.freq_table(FreqLayer::Lemma).ok();
        let corpus_version = h.source.corpus_version().to_string();
        h.cancel.store(false, Ordering::SeqCst);
        let started = std::time::Instant::now();

        // Judged rows stay; unjudged rows of this book are replaced.
        conn.execute("DELETE FROM quran_match WHERE book_id = ?1 AND user_verdict IS NULL", [book_id as i64]).map_err(dberr)?;
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM quran_match WHERE book_id = ?1", [book_id as i64], |r| r.get(0)).map_err(dberr)?;

        let total = book.pages.len() as u64;
        let mut found = 0u64;
        let mut pages_done = 0usize;
        let mut cancelled = false;
        for (i, page) in book.pages.iter().enumerate() {
            if h.should_stop() {
                cancelled = true;
                break;
            }
            let hits = quran::detect_page(&q.index, &q.text, &page.tokens, &page.body, freq.as_deref(), &params);
            conn.execute_batch("BEGIN").map_err(dberr)?;
            for hit in &hits {
                let (snap, hash) = snapshot(page, hit.tok_start, hit.tok_end);
                let ayas_json = if hit.also.is_empty() { None } else { Some(serde_json::to_string(&hit.also).unwrap_or_default()) };
                let n = conn
                    .execute(
                        "INSERT OR IGNORE INTO quran_match (corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
                         sura, aya_start, aya_end, q_tok_start, q_tok_end, lemma_agree, surface_agree, cue, created_at, detector_version, ayas_json) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                        params![
                            corpus_version,
                            page.book_id as i64,
                            page.part_index as i64,
                            page.page_id as i64,
                            hit.tok_start as i64,
                            hit.tok_end as i64,
                            snap,
                            hash,
                            hit.sura as i64,
                            hit.aya_start as i64,
                            hit.aya_end as i64,
                            hit.q_tok_start as i64,
                            hit.q_tok_end as i64,
                            hit.lemma_agree,
                            hit.surface_agree,
                            hit.cue,
                            now(),
                            DETECTOR_VERSION,
                            ayas_json,
                        ],
                    )
                    .map_err(dberr)?;
                found += n as u64;
            }
            conn.execute_batch("COMMIT").map_err(dberr)?;
            pages_done = i + 1;
            let elapsed = started.elapsed().as_millis() as u64;
            let done = pages_done as u64;
            let _ = window.emit(PROGRESS_EVENT, RunProgress { done, total, found, estimate_ms: if done >= 20 { Some(elapsed * total / done) } else { None } });
        }
        Ok(RunSummary { book_id, pages: book.pages.len(), pages_done, hits: found as usize, kept_judged: kept as usize, elapsed_ms: started.elapsed().as_millis() as u64, cancelled, detector_version: DETECTOR_VERSION })
    })
    .await
}

/// One stored quotation, as the §7.6 table shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchRow {
    pub id: i64,
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub snapshot: String,
    pub sura: u32,
    pub sura_name: String,
    pub aya_start: u32,
    pub aya_end: u32,
    pub q_tok_start: usize,
    pub q_tok_end: usize,
    /// The matched stretch of the Qurʾān, imlāʾī with tashkil.
    pub aya_text: String,
    pub lemma_agree: f64,
    pub surface_agree: f64,
    pub aligned: usize,
    pub cue: Option<String>,
    pub user_verdict: Option<String>,
    pub detector_version: String,
    /// The other āyāt an ambiguous hit aligns to equally (amendment 1.4);
    /// empty when the reading is unique.
    pub also: Vec<quran::AyaRef>,
}

fn read_rows(conn: &Connection, q: &crate::state::Quran, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<MatchRow>, LabError> {
    let mut stmt = conn.prepare(sql).map_err(dberr)?;
    let rows = stmt
        .query_map(args, |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)? as u64,
                r.get::<_, i64>(2)? as u32,
                r.get::<_, i64>(3)? as u64,
                r.get::<_, i64>(4)? as usize,
                r.get::<_, i64>(5)? as usize,
                r.get::<_, String>(6)?,
                r.get::<_, i64>(7)? as u32,
                r.get::<_, i64>(8)? as u32,
                r.get::<_, i64>(9)? as u32,
                r.get::<_, i64>(10)? as usize,
                r.get::<_, i64>(11)? as usize,
                r.get::<_, f64>(12)?,
                r.get::<_, f64>(13)?,
                r.get::<_, Option<String>>(14)?,
                r.get::<_, Option<String>>(15)?,
                r.get::<_, String>(16)?,
                r.get::<_, Option<String>>(17)?,
            ))
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows
        .into_iter()
        .map(|(id, book_id, part_index, page_id, tok_start, tok_end, snapshot, sura, aya_start, aya_end, q_tok_start, q_tok_end, lemma_agree, surface_agree, cue, user_verdict, detector_version, ayas_json)| {
            let sura_name = q.text.sura(sura).map(|s| s.name.clone()).unwrap_or_default();
            let aya_text = q
                .text
                .page(sura)
                .map(|p| {
                    let n = p.tokens.len();
                    p.tokens[q_tok_start.min(n)..q_tok_end.min(n)].iter().map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ")
                })
                .unwrap_or_default();
            MatchRow {
                id,
                book_id,
                part_index,
                page_id,
                tok_start,
                tok_end,
                snapshot,
                sura,
                sura_name,
                aya_start,
                aya_end,
                q_tok_start,
                q_tok_end,
                aya_text,
                lemma_agree,
                surface_agree,
                aligned: q_tok_end.saturating_sub(q_tok_start),
                cue,
                user_verdict,
                detector_version,
                also: ayas_json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
            }
        })
        .collect())
}

const COLUMNS: &str = "id, book_id, part_index, page_id, tok_start, tok_end, snapshot, sura, aya_start, aya_end, q_tok_start, q_tok_end, \
    lemma_agree, surface_agree, cue, user_verdict, detector_version, ayas_json";

/// Every stored quotation of a book, by sūra:āya then page.
#[tauri::command]
pub async fn quran_list(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<MatchRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let q = quran_cell(&h.quran)?;
        let conn = db(&h)?;
        read_rows(&conn, &q, &format!("SELECT {} FROM quran_match WHERE book_id = ?1 ORDER BY sura, aya_start, part_index, page_id, tok_start", COLUMNS), &[&(book_id as i64)])
    })
    .await
}

/// The quotations on one page, for the reader layer.
#[tauri::command]
pub async fn quran_page(state: State<'_, ManagedLabState>, book_id: u64, part_index: u32, page_id: u64) -> Result<Vec<MatchRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let q = quran_cell(&h.quran)?;
        let conn = db(&h)?;
        read_rows(
            &conn,
            &q,
            &format!("SELECT {} FROM quran_match WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 ORDER BY tok_start", COLUMNS),
            &[&(book_id as i64), &(part_index as i64), &(page_id as i64)],
        )
    })
    .await
}

/// One āya with its display texts, for the detail view (fix 10c).
#[derive(Debug, Clone, Serialize)]
pub struct AyaText {
    pub sura: u32,
    pub aya: u32,
    pub text: String,
    pub text_uthmani: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AyaContext {
    pub sura: u32,
    pub sura_name: String,
    pub before: Option<AyaText>,
    pub ayas: Vec<AyaText>,
    pub after: Option<AyaText>,
}

/// The āyāt of a hit with one āya of context on either side (fix 10c).
#[tauri::command]
pub async fn quran_context(state: State<'_, ManagedLabState>, sura: u32, aya_start: u32, aya_end: u32) -> Result<AyaContext, LabError> {
    let cell = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?.quran.clone();
    blocking(move || {
        let q = quran_cell(&cell)?;
        let s = q.text.sura(sura).ok_or_else(|| LabError::NotFound(format!("sūra {}", sura)))?;
        let one = |a: u32| -> Result<Option<AyaText>, LabError> {
            if a < 1 || a > s.ayas {
                return Ok(None);
            }
            let (text, text_uthmani) = q.text.aya_text(sura, a).map_err(|e| LabError::Other(e.to_string()))?;
            Ok(Some(AyaText { sura, aya: a, text, text_uthmani }))
        };
        let mut ayas = Vec::new();
        for a in aya_start.max(1)..=aya_end.min(s.ayas).max(aya_start) {
            if let Some(t) = one(a)? {
                ayas.push(t);
            }
        }
        Ok(AyaContext { sura, sura_name: s.name.clone(), before: one(aya_start.saturating_sub(1))?, ayas, after: one(aya_end + 1)? })
    })
    .await
}

/// Confirm or reject a quotation (`None` clears).
#[tauri::command]
pub async fn quran_verdict(state: State<'_, ManagedLabState>, match_id: i64, verdict: Option<String>) -> Result<MatchRow, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        if let Some(v) = &verdict {
            if v != "confirmed" && v != "rejected" {
                return Err(LabError::Other(format!("verdict must be confirmed or rejected, not {}", v)));
            }
        }
        let q = quran_cell(&h.quran)?;
        let conn = db(&h)?;
        conn.execute("UPDATE quran_match SET user_verdict = ?2 WHERE id = ?1", params![match_id, verdict]).map_err(dberr)?;
        read_rows(&conn, &q, &format!("SELECT {} FROM quran_match WHERE id = ?1", COLUMNS), &[&match_id])?
            .pop()
            .ok_or_else(|| LabError::NotFound(format!("quotation {}", match_id)))
    })
    .await
}

/// Export a book's quotations as CSV or JSON (§6.6).
#[tauri::command]
pub async fn quran_export(state: State<'_, ManagedLabState>, book_id: u64, format: String) -> Result<String, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let q = quran_cell(&h.quran)?;
        let conn = db(&h)?;
        let rows = read_rows(&conn, &q, &format!("SELECT {} FROM quran_match WHERE book_id = ?1 ORDER BY sura, aya_start, part_index, page_id, tok_start", COLUMNS), &[&(book_id as i64)])?;
        let (name, body) = match format.as_str() {
            "json" => (format!("quran-{}.json", book_id), serde_json::to_string_pretty(&rows).map_err(|e| LabError::Other(e.to_string()))?),
            _ => {
                let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
                let mut out = String::from("id,book_id,part_index,page_id,tok_start,tok_end,sura,sura_name,aya_start,aya_end,aligned,lemma_agree,surface_agree,cue,verdict,text,aya_text\n");
                for r in &rows {
                    out.push_str(&format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{:.3},{:.3},{},{},{},{}\n",
                        r.id,
                        r.book_id,
                        r.part_index,
                        r.page_id,
                        r.tok_start,
                        r.tok_end,
                        r.sura,
                        esc(&r.sura_name),
                        r.aya_start,
                        r.aya_end,
                        r.aligned,
                        r.lemma_agree,
                        r.surface_agree,
                        esc(r.cue.as_deref().unwrap_or("")),
                        r.user_verdict.as_deref().unwrap_or(""),
                        esc(&r.snapshot),
                        esc(&r.aya_text),
                    ));
                }
                (format!("quran-{}.csv", book_id), out)
            }
        };
        crate::commands::stats::save_export(name, body)
    })
    .await
}
