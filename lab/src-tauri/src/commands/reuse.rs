//! Text reuse commands (Lab spec §4.3, §6.4, §7.5).
//!
//! Thin over `analysis::reuse`: passage mode in both modes, book mode in
//! local mode only (a 20-window trial gives the estimate; progress per page;
//! cancel keeps what is done), storage in `reuse_run` / `reuse_match`,
//! re-scoring from stored components, verdicts, and the gold set
//! (`reuse_gold`) that confirmed matches feed.
//!
//! Zones (§4.3 preprocessing) are computed per query page here: Qurʾān
//! spans from the §4.4 detector, isnād spans from confirmed rows in
//! `isnad` and from live extraction at confidence ≥ 0.6.

use crate::analysis::isnad;
use crate::analysis::quran;
use crate::analysis::reuse::{self, BookAggregate, Components, Match, MatchType, Params, Zone};
use crate::commands::isnad::{db, dberr, snapshot};
use crate::error::LabError;
use crate::lexicon;
use crate::source::{BookSource, FreqLayer, FreqTable, Page, PageRef};
use crate::state::{handles, quran as quran_cell, Handles, ManagedLabState};
use crate::store::now;
use kashshaf_engine::normalize_arabic;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State, Window};

const PROGRESS_EVENT: &str = "reuse-progress";

#[derive(Debug, Clone, Serialize)]
pub struct RunProgress {
    pub stage: &'static str,
    pub done: u64,
    pub total: u64,
    pub found: u64,
    pub estimate_ms: Option<u64>,
}

fn emit(window: &Window, stage: &'static str, done: u64, total: u64, found: u64, started: std::time::Instant) {
    let elapsed = started.elapsed().as_millis() as u64;
    let estimate_ms = if done >= 5 && done > 0 { Some(elapsed * total.max(done) / done) } else { None };
    let _ = window.emit(PROGRESS_EVENT, RunProgress { stage, done, total, found, estimate_ms });
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LabError> + Send + 'static) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))? }
}

// ------------------------------------------------------------ helpers ---

/// What a run needs besides the source: the lemma table, the banal phrase
/// list, the lexicon for isnād zones, the Qurʾān, and the params with the
/// baseline filled in.
struct Setup {
    freq: Arc<FreqTable>,
    banal_phrases: Vec<Vec<String>>,
    lex: lexicon::Lexicon,
    quran: Option<Arc<crate::state::Quran>>,
    params: Params,
}

fn setup(h: &Handles, conn: &Connection, params: Option<Params>) -> Result<Setup, LabError> {
    let freq = h.source.freq_table(FreqLayer::Lemma).map_err(|e| LabError::Source(e.to_string()))?;
    let mut params = params.unwrap_or_default();
    if params.banality_baseline.is_none() {
        params.banality_baseline = Some(reuse::corpus_banal_share(&freq, params.banality_rank));
    }
    let banal_phrases: Vec<Vec<String>> = lexicon::list(conn, Some("banal"))
        .map_err(dberr)?
        .into_iter()
        .filter(|e| e.enabled)
        .map(|e| e.tokens.iter().map(|t| normalize_arabic(t)).collect())
        .collect();
    let lex = lexicon::load(conn).map_err(dberr)?;
    // Without the Qurʾān, reuse still runs; zones just lack `quran`.
    let quran = quran_cell(&h.quran).ok();
    Ok(Setup { freq, banal_phrases, lex, quran, params })
}

/// Per-token zone labels of a page (§4.3): Qurʾān from the detector, isnād
/// from confirmed rows and from live extraction at confidence ≥ 0.6.
fn zones_for(conn: &Connection, s: &Setup, page: &Page) -> Result<Vec<Option<Zone>>, LabError> {
    let n = page.tokens.len();
    let mut z = vec![None; n];
    if let Some(q) = &s.quran {
        for h in quran::detect_page(&q.index, &q.text, &page.tokens, &page.body, Some(&s.freq), &quran::Params::default()) {
            for x in h.tok_start..h.tok_end.min(n) {
                z[x] = Some(Zone::Quran);
            }
        }
    }
    let mut stmt = conn
        .prepare("SELECT tok_start, tok_end FROM isnad WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3 AND status = 'confirmed'")
        .map_err(dberr)?;
    let confirmed = stmt
        .query_map(params![page.book_id as i64, page.part_index as i64, page.page_id as i64], |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as usize)))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    for (a, b) in confirmed {
        for x in a..b.min(n) {
            z[x] = Some(Zone::Isnad);
        }
    }
    let no_overrides = HashMap::new();
    for c in isnad::extract_page(&page.tokens, &page.body, &s.lex, &isnad::Params::default(), &no_overrides) {
        if c.confidence.total >= 0.6 {
            for x in c.tok_start..c.tok_end.min(n) {
                if z[x].is_none() {
                    z[x] = Some(Zone::Isnad);
                }
            }
        }
    }
    Ok(z)
}

/// A phrase-count cache for one run: overlapping windows share trigrams.
struct DfCache<'a> {
    source: &'a dyn BookSource,
    counts: Mutex<HashMap<Vec<String>, usize>>,
}

impl<'a> DfCache<'a> {
    fn new(source: &'a dyn BookSource) -> Self {
        Self { source, counts: Mutex::new(HashMap::new()) }
    }

    fn get(&self, terms: &[String]) -> anyhow::Result<usize> {
        if let Some(n) = self.counts.lock().unwrap().get(terms) {
            return Ok(*n);
        }
        let n = reuse::phrase_df(self.source, terms)?;
        let mut c = self.counts.lock().unwrap();
        if c.len() > 200_000 {
            c.clear();
        }
        c.insert(terms.to_vec(), n);
        Ok(n)
    }
}

/// A page cache in front of `BookSource::page` for one run: candidate pages
/// recur across windows in book mode.
struct PageCache<'a> {
    source: &'a dyn BookSource,
    pages: Mutex<HashMap<(u64, u32, u64), Option<Arc<Page>>>>,
}

impl<'a> PageCache<'a> {
    fn new(source: &'a dyn BookSource) -> Self {
        Self { source, pages: Mutex::new(HashMap::new()) }
    }

    fn get(&self, r: &PageRef) -> anyhow::Result<Option<Page>> {
        let key = (r.book_id, r.part_index, r.page_id);
        if let Some(p) = self.pages.lock().unwrap().get(&key) {
            return Ok(p.as_ref().map(|p| (**p).clone()));
        }
        let p = self.source.page(r.book_id, r.part_index, r.page_id)?.map(Arc::new);
        let mut cache = self.pages.lock().unwrap();
        if cache.len() > 5000 {
            cache.clear();
        }
        cache.insert(key, p.clone());
        Ok(p.map(|p| (*p).clone()))
    }
}

fn insert_run(conn: &Connection, corpus_version: &str, book_id: u64, mode: &str, params: &Params) -> Result<i64, LabError> {
    conn.execute(
        "INSERT INTO reuse_run (corpus_version, book_id, mode, params_json, started_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
        params![corpus_version, book_id as i64, mode, serde_json::to_string(params).unwrap_or_default(), now()],
    )
    .map_err(dberr)?;
    Ok(conn.last_insert_rowid())
}

fn finish_run(conn: &Connection, run_id: i64, status: &str) -> Result<(), LabError> {
    conn.execute("UPDATE reuse_run SET status = ?2, finished_at = ?3 WHERE id = ?1", params![run_id, status, now()]).map_err(dberr)?;
    Ok(())
}

fn insert_match(conn: &Connection, run_id: i64, corpus_version: &str, page: &Page, m: &Match) -> Result<i64, LabError> {
    let (snap, hash) = snapshot(page, m.q_start, m.q_end);
    conn.execute(
        "INSERT INTO reuse_match (run_id, corpus_version, book_id, part_index, page_id, tok_start, tok_end, snapshot, snapshot_hash, \
         target_book_id, target_part_index, target_page_id, target_tok_start, target_tok_end, score, type, \
         surface_agree, lemma_agree, root_agree, coverage, banality_factor, banal_share, aligned, anchor_hits, pairs_json, zone) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
        params![
            run_id,
            corpus_version,
            page.book_id as i64,
            page.part_index as i64,
            page.page_id as i64,
            m.q_start as i64,
            m.q_end as i64,
            snap,
            hash,
            m.target.book_id as i64,
            m.target.part_index as i64,
            m.target.page_id as i64,
            m.t_start as i64,
            m.t_end as i64,
            m.score,
            m.kind.as_str(),
            m.components.surface_agree,
            m.components.lemma_agree,
            m.components.root_agree,
            m.components.coverage,
            m.components.banality_factor,
            m.components.banal_share,
            m.components.aligned as i64,
            m.anchor_hits as i64,
            serde_json::to_string(&m.pairs).unwrap_or_default(),
            m.zone.map(|z| z.as_str()),
        ],
    )
    .map_err(dberr)?;
    Ok(conn.last_insert_rowid())
}

/// One stored match, as the UI lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchRow {
    pub id: i64,
    pub run_id: i64,
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub snapshot: String,
    pub target: PageRef,
    pub target_title: Option<String>,
    pub target_author: Option<i64>,
    pub target_death_ah: Option<i64>,
    pub t_start: usize,
    pub t_end: usize,
    pub pairs: Vec<(usize, usize)>,
    pub components: Components,
    pub score: f64,
    pub kind: MatchType,
    pub zone: Option<Zone>,
    pub anchor_hits: usize,
    pub user_verdict: Option<String>,
}

fn read_matches(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<MatchRow>, LabError> {
    let mut stmt = conn.prepare(sql).map_err(dberr)?;
    let rows = stmt
        .query_map(args, |r| {
            let pairs_json: Option<String> = r.get(25)?;
            let kind: String = r.get(15)?;
            let zone: Option<String> = r.get(26)?;
            Ok(MatchRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                book_id: r.get::<_, i64>(2)? as u64,
                part_index: r.get::<_, i64>(3)? as u32,
                page_id: r.get::<_, i64>(4)? as u64,
                tok_start: r.get::<_, i64>(5)? as usize,
                tok_end: r.get::<_, i64>(6)? as usize,
                snapshot: r.get(7)?,
                target: PageRef { book_id: r.get::<_, i64>(8)? as u64, part_index: r.get::<_, i64>(9)? as u32, page_id: r.get::<_, i64>(10)? as u64 },
                target_title: None,
                target_author: None,
                target_death_ah: None,
                t_start: r.get::<_, i64>(11)? as usize,
                t_end: r.get::<_, i64>(12)? as usize,
                pairs: pairs_json.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                components: Components {
                    surface_agree: r.get::<_, Option<f64>>(16)?.unwrap_or(0.0),
                    lemma_agree: r.get::<_, Option<f64>>(17)?.unwrap_or(0.0),
                    root_agree: r.get::<_, Option<f64>>(18)?.unwrap_or(0.0),
                    coverage: r.get::<_, Option<f64>>(19)?.unwrap_or(0.0),
                    banality_factor: r.get::<_, Option<f64>>(20)?.unwrap_or(1.0),
                    banal_share: r.get::<_, Option<f64>>(21)?.unwrap_or(0.0),
                    aligned: r.get::<_, Option<i64>>(22)?.unwrap_or(0) as usize,
                },
                score: r.get(14)?,
                kind: MatchType::parse(&kind).unwrap_or(MatchType::Weak),
                zone: zone.as_deref().and_then(|z| match z {
                    "quran" => Some(Zone::Quran),
                    "isnad" => Some(Zone::Isnad),
                    _ => None,
                }),
                anchor_hits: r.get::<_, Option<i64>>(23)?.unwrap_or(0) as usize,
                user_verdict: r.get(27)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

const MATCH_COLUMNS: &str = "id, run_id, book_id, part_index, page_id, tok_start, tok_end, snapshot, \
    target_book_id, target_part_index, target_page_id, target_tok_start, target_tok_end, snapshot_hash, score, type, \
    surface_agree, lemma_agree, root_agree, coverage, banality_factor, banal_share, aligned, anchor_hits, corpus_version, pairs_json, zone, user_verdict";

/// Fill target titles from the source's book list, once per distinct book.
fn with_titles(source: &dyn BookSource, rows: &mut [MatchRow]) {
    let mut cache: HashMap<u64, Option<(String, Option<i64>, Option<i64>)>> = HashMap::new();
    for r in rows.iter_mut() {
        let e = cache.entry(r.target.book_id).or_insert_with(|| source.book(r.target.book_id).ok().flatten().map(|b| (b.title, b.author_id, b.death_ah)));
        if let Some((t, a, d)) = e {
            r.target_title = Some(t.clone());
            r.target_author = *a;
            r.target_death_ah = *d;
        }
    }
}

// ------------------------------------------------------------ passage ---

#[derive(Debug, Clone, Deserialize)]
pub struct PassageArgs {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub params: Option<Params>,
    /// Leave out the query's own book (default false: §4.3 excludes only
    /// the page).
    #[serde(default)]
    pub exclude_same_book: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PassageResult {
    pub run_id: i64,
    pub params: Params,
    pub anchors: Vec<reuse::Anchor>,
    pub candidates: usize,
    pub tokens: usize,
    pub non_banal: usize,
    /// Zone labels over the whole query page, for the reader.
    pub zones: Vec<Option<Zone>>,
    pub matches: Vec<MatchRow>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// `lemma-slop` / `surface` when the whole passage was the query.
    pub fallback: Option<&'static str>,
}

/// §4.3 single-passage mode on `[tok_start, tok_end)` of one page. Works in
/// both modes. Every match (not only those above the threshold) is stored
/// and returned; the threshold is a display filter.
#[tauri::command]
pub async fn reuse_passage(window: Window, state: State<'_, ManagedLabState>, args: PassageArgs) -> Result<PassageResult, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let started = std::time::Instant::now();
        let conn = db(&h)?;
        let s = setup(&h, &conn, args.params.clone())?;
        let page = h
            .source
            .page(args.book_id, args.part_index, args.page_id)
            .map_err(|e| LabError::Source(e.to_string()))?
            .ok_or_else(|| LabError::NotFound(format!("page {}:{}:{}", args.book_id, args.part_index, args.page_id)))?;
        let n = page.tokens.len();
        let (a, b) = (args.tok_start.min(n), args.tok_end.min(n));
        if b <= a {
            return Err(LabError::Other("select a passage first".into()));
        }
        let zones = zones_for(&conn, &s, &page)?;
        h.cancel.store(false, Ordering::SeqCst);
        let run_id = insert_run(&conn, h.source.corpus_version(), args.book_id, "passage", &s.params)?;
        let cache = PageCache::new(h.source.as_ref());
        let dfs = DfCache::new(h.source.as_ref());
        let count = |t: &[String]| dfs.get(t);
        let done = std::sync::atomic::AtomicU64::new(0);
        let load = |r: &PageRef| {
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            emit(&window, "align", d, 0, 0, started);
            cache.get(r)
        };
        let cancel = || h.cancel.load(Ordering::SeqCst);
        emit(&window, "candidates", 0, 0, 0, started);
        let run = reuse::passage(
            h.source.as_ref(),
            &s.freq,
            &s.params,
            &s.banal_phrases,
            &page,
            a..b,
            &zones,
            if args.exclude_same_book { Some(args.book_id) } else { None },
            &count,
            &load,
            &cancel,
        )
        .map_err(|e| LabError::Source(e.to_string()))?;
        let cancelled = cancel();
        conn.execute_batch("BEGIN").map_err(dberr)?;
        let mut ids = Vec::with_capacity(run.matches.len());
        for m in &run.matches {
            ids.push(insert_match(&conn, run_id, h.source.corpus_version(), &page, m)?);
        }
        conn.execute_batch("COMMIT").map_err(dberr)?;
        finish_run(&conn, run_id, if cancelled { "cancelled" } else { "done" })?;
        let mut matches = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1 ORDER BY score DESC, aligned DESC", MATCH_COLUMNS), &[&run_id])?;
        with_titles(h.source.as_ref(), &mut matches);
        Ok(PassageResult {
            run_id,
            params: s.params,
            anchors: run.anchors,
            candidates: run.candidates,
            tokens: run.tokens,
            non_banal: run.non_banal,
            zones,
            matches,
            elapsed_ms: started.elapsed().as_millis() as u64,
            cancelled,
            fallback: run.fallback,
        })
    })
    .await
}

/// Re-score every stored match of a run from its components (§7.5: the
/// threshold, type and banality sliders do not re-run). Updates the rows.
#[tauri::command]
pub async fn reuse_rescore(state: State<'_, ManagedLabState>, run_id: i64, params: Params) -> Result<Vec<MatchRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1", MATCH_COLUMNS), &[&run_id])?;
        conn.execute_batch("BEGIN").map_err(dberr)?;
        for r in &rows {
            let (c, score, kind) = reuse::rescore(&r.components, &params);
            conn.execute(
                "UPDATE reuse_match SET score = ?2, type = ?3, banality_factor = ?4 WHERE id = ?1",
                params![r.id, score, kind.as_str(), c.banality_factor],
            )
            .map_err(dberr)?;
        }
        conn.execute("UPDATE reuse_run SET params_json = ?2 WHERE id = ?1", params![run_id, serde_json::to_string(&params).unwrap_or_default()]).map_err(dberr)?;
        conn.execute_batch("COMMIT").map_err(dberr)?;
        let mut rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1 ORDER BY score DESC, aligned DESC", MATCH_COLUMNS), &[&run_id])?;
        with_titles(h.source.as_ref(), &mut rows);
        Ok(rows)
    })
    .await
}

/// Confirm or reject a match (`None` clears). A confirmation writes the
/// pair to `reuse_gold` for `lab-cli reuse-eval` (§4.3).
#[tauri::command]
pub async fn reuse_verdict(state: State<'_, ManagedLabState>, match_id: i64, verdict: Option<String>) -> Result<MatchRow, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        if let Some(v) = &verdict {
            if v != "confirmed" && v != "rejected" {
                return Err(LabError::Other(format!("verdict must be confirmed or rejected, not {}", v)));
            }
        }
        conn.execute("UPDATE reuse_match SET user_verdict = ?2 WHERE id = ?1", params![match_id, verdict]).map_err(dberr)?;
        let mut rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE id = ?1", MATCH_COLUMNS), &[&match_id])?;
        let row = rows.pop().ok_or_else(|| LabError::NotFound(format!("match {}", match_id)))?;
        if verdict.as_deref() == Some("confirmed") {
            let q = serde_json::json!({ "book_id": row.book_id, "part_index": row.part_index, "page_id": row.page_id, "tok_start": row.tok_start, "tok_end": row.tok_end });
            let t = serde_json::json!({ "book_id": row.target.book_id, "part_index": row.target.part_index, "page_id": row.target.page_id, "tok_start": row.t_start, "tok_end": row.t_end });
            let exists: Option<i64> = conn
                .query_row("SELECT id FROM reuse_gold WHERE q_json = ?1 AND t_json = ?2", params![q.to_string(), t.to_string()], |r| r.get(0))
                .optional()
                .map_err(dberr)?;
            if exists.is_none() {
                conn.execute("INSERT INTO reuse_gold (created_at, q_json, t_json) VALUES (?1, ?2, ?3)", params![now(), q.to_string(), t.to_string()]).map_err(dberr)?;
            }
        }
        let mut one = vec![row];
        with_titles(h.source.as_ref(), &mut one);
        Ok(one.pop().unwrap())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct RunRow {
    pub id: i64,
    pub corpus_version: String,
    pub book_id: u64,
    pub mode: String,
    pub params: Params,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub matches: i64,
}

/// Runs stored for a book, newest first.
#[tauri::command]
pub async fn reuse_runs(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<RunRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.corpus_version, r.book_id, r.mode, r.params_json, r.started_at, r.finished_at, r.status, \
                 (SELECT COUNT(*) FROM reuse_match m WHERE m.run_id = r.id) \
                 FROM reuse_run r WHERE r.book_id = ?1 ORDER BY r.id DESC",
            )
            .map_err(dberr)?;
        let rows = stmt
            .query_map([book_id as i64], |r| {
                let pj: String = r.get(4)?;
                Ok(RunRow {
                    id: r.get(0)?,
                    corpus_version: r.get(1)?,
                    book_id: r.get::<_, i64>(2)? as u64,
                    mode: r.get(3)?,
                    params: serde_json::from_str(&pj).unwrap_or_default(),
                    started_at: r.get(5)?,
                    finished_at: r.get(6)?,
                    status: r.get(7)?,
                    matches: r.get(8)?,
                })
            })
            .map_err(dberr)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr)?;
        Ok(rows)
    })
    .await
}

/// The stored matches of a run (all of them; the UI filters).
#[tauri::command]
pub async fn reuse_matches(state: State<'_, ManagedLabState>, run_id: i64) -> Result<Vec<MatchRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1 ORDER BY score DESC, aligned DESC", MATCH_COLUMNS), &[&run_id])?;
        with_titles(h.source.as_ref(), &mut rows);
        Ok(rows)
    })
    .await
}

// --------------------------------------------------------------- book ---

#[derive(Debug, Clone, Serialize)]
pub struct Estimate {
    pub book_id: u64,
    pub pages: usize,
    pub windows: usize,
    pub sampled: usize,
    pub sample_ms: u64,
    pub estimate_ms: u64,
    pub sample_matches: usize,
}

fn require_local(h: &Handles) -> Result<(), LabError> {
    if h.source.is_local() {
        Ok(())
    } else {
        Err(LabError::Source(crate::source::unavailable("Whole-book reuse", "it runs thousands of index queries, which only the local corpus can answer in time (spec §4.3)").to_string()))
    }
}

/// Count every window of the book (§4.3 batch mode).
fn book_windows(book: &crate::state::LoadedBook, p: &Params) -> Vec<(usize, std::ops::Range<usize>)> {
    let mut out = Vec::new();
    for (pi, page) in book.pages.iter().enumerate() {
        for w in reuse::windows(page.tokens.len(), p.window, p.stride, p.min_aligned) {
            out.push((pi, w));
        }
    }
    out
}

/// A 20-window trial for the time estimate shown before a book run.
#[tauri::command]
pub async fn reuse_estimate(window: Window, state: State<'_, ManagedLabState>, book_id: u64, params: Option<Params>) -> Result<Estimate, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        require_local(&h)?;
        let conn = db(&h)?;
        let s = setup(&h, &conn, params)?;
        let book = crate::commands::stats::load_book(&h, Some(&window), book_id)?;
        let windows = book_windows(&book, &s.params);
        // Sample from the middle of the book: front matter is atypical.
        let n = windows.len();
        let sample: Vec<&(usize, std::ops::Range<usize>)> = if n <= 20 { windows.iter().collect() } else { windows.iter().skip(n / 2 - 10).take(20).collect() };
        let cache = PageCache::new(h.source.as_ref());
        let load = |r: &PageRef| cache.get(r);
        let dfs = DfCache::new(h.source.as_ref());
        let count = |t: &[String]| dfs.get(t);
        let started = std::time::Instant::now();
        let mut found = 0usize;
        let mut zone_cache: HashMap<usize, Vec<Option<Zone>>> = HashMap::new();
        for (pi, w) in &sample {
            let page = &book.pages[*pi];
            let zones = match zone_cache.get(pi) {
                Some(z) => z.clone(),
                None => {
                    let z = zones_for(&conn, &s, page)?;
                    zone_cache.insert(*pi, z.clone());
                    z
                }
            };
            let run = reuse::passage(h.source.as_ref(), &s.freq, &s.params, &s.banal_phrases, page, w.clone(), &zones, Some(book_id), &count, &load, &|| false)
                .map_err(|e| LabError::Source(e.to_string()))?;
            found += run.matches.len();
        }
        let sample_ms = started.elapsed().as_millis() as u64;
        let estimate_ms = if sample.is_empty() { 0 } else { sample_ms * n as u64 / sample.len() as u64 };
        Ok(Estimate { book_id, pages: book.pages.len(), windows: n, sampled: sample.len(), sample_ms, estimate_ms, sample_matches: found })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct BookAggRow {
    #[serde(flatten)]
    pub agg: BookAggregate,
    pub title: Option<String>,
    pub author_id: Option<i64>,
    pub death_ah: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookRunSummary {
    pub run_id: i64,
    pub book_id: u64,
    pub pages: usize,
    pub pages_done: usize,
    pub windows: usize,
    pub windows_done: usize,
    pub matches: usize,
    pub aggregates: Vec<BookAggRow>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub params: Params,
}

/// §4.3 batch mode: every window of the book through the passage
/// procedure, overlapping matches merged per target, aggregated per target
/// book. Streams progress per page; cancel keeps completed pages.
#[tauri::command]
pub async fn reuse_book(window: Window, state: State<'_, ManagedLabState>, book_id: u64, params: Option<Params>) -> Result<BookRunSummary, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        require_local(&h)?;
        let started = std::time::Instant::now();
        let conn = db(&h)?;
        let s = setup(&h, &conn, params)?;
        let book = crate::commands::stats::load_book(&h, Some(&window), book_id)?;
        let windows = book_windows(&book, &s.params);
        h.cancel.store(false, Ordering::SeqCst);
        let run_id = insert_run(&conn, h.source.corpus_version(), book_id, "book", &s.params)?;
        let cache = PageCache::new(h.source.as_ref());
        let load = |r: &PageRef| cache.get(r);
        let dfs = DfCache::new(h.source.as_ref());
        let count = |t: &[String]| dfs.get(t);
        let total_pages = book.pages.len() as u64;
        let mut found = 0u64;
        let mut windows_done = 0usize;
        let mut pages_done = 0usize;
        let mut cancelled = false;
        let mut wi = 0usize;
        for (pi, page) in book.pages.iter().enumerate() {
            if h.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let zones = zones_for(&conn, &s, page)?;
            let mut page_matches: Vec<(PageRef, Match)> = Vec::new();
            let qref = PageRef { book_id: page.book_id, part_index: page.part_index, page_id: page.page_id };
            while wi < windows.len() && windows[wi].0 == pi {
                let w = windows[wi].1.clone();
                let run = reuse::passage(h.source.as_ref(), &s.freq, &s.params, &s.banal_phrases, page, w, &zones, Some(book_id), &count, &load, &|| h.cancel.load(Ordering::SeqCst))
                    .map_err(|e| LabError::Source(e.to_string()))?;
                for m in run.matches {
                    page_matches.push((qref.clone(), m));
                }
                wi += 1;
                windows_done += 1;
                if h.cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
            }
            let merged = reuse::merge_overlapping(page_matches);
            conn.execute_batch("BEGIN").map_err(dberr)?;
            for (_, m) in &merged {
                insert_match(&conn, run_id, h.source.corpus_version(), page, m)?;
                found += 1;
            }
            conn.execute_batch("COMMIT").map_err(dberr)?;
            pages_done += 1;
            emit(&window, "book", pages_done as u64, total_pages, found, started);
            if cancelled {
                break;
            }
        }
        finish_run(&conn, run_id, if cancelled { "cancelled" } else { "done" })?;
        let rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1", MATCH_COLUMNS), &[&run_id])?;
        let matches: Vec<Match> = rows
            .iter()
            .map(|r| Match {
                target: r.target.clone(),
                q_start: r.tok_start,
                q_end: r.tok_end,
                t_start: r.t_start,
                t_end: r.t_end,
                pairs: vec![],
                components: r.components,
                score: r.score,
                kind: r.kind,
                zone: r.zone,
                anchor_hits: r.anchor_hits,
            })
            .collect();
        let aggregates = aggregate_rows(h.source.as_ref(), &matches, s.params.threshold);
        Ok(BookRunSummary {
            run_id,
            book_id,
            pages: book.pages.len(),
            pages_done,
            windows: windows.len(),
            windows_done,
            matches: rows.len(),
            aggregates,
            elapsed_ms: started.elapsed().as_millis() as u64,
            cancelled,
            params: s.params,
        })
    })
    .await
}

fn aggregate_rows(source: &dyn BookSource, matches: &[Match], threshold: f64) -> Vec<BookAggRow> {
    reuse::aggregate(matches.iter(), threshold)
        .into_iter()
        .map(|agg| {
            let b = source.book(agg.book_id).ok().flatten();
            BookAggRow { agg, title: b.as_ref().map(|b| b.title.clone()), author_id: b.as_ref().and_then(|b| b.author_id), death_ah: b.as_ref().and_then(|b| b.death_ah) }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerSpan {
    pub id: i64,
    pub tok_start: usize,
    pub tok_end: usize,
    pub score: f64,
    pub kind: MatchType,
    pub target: PageRef,
    pub user_verdict: Option<String>,
}

/// The query spans of a run on one page, for the reader layer.
#[tauri::command]
pub async fn reuse_page_layer(state: State<'_, ManagedLabState>, run_id: i64, part_index: u32, page_id: u64, threshold: f64) -> Result<Vec<LayerSpan>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let rows = read_matches(
            &conn,
            &format!("SELECT {} FROM reuse_match WHERE run_id = ?1 AND part_index = ?2 AND page_id = ?3 AND score >= ?4 ORDER BY tok_start", MATCH_COLUMNS),
            &[&run_id, &(part_index as i64), &(page_id as i64), &threshold],
        )?;
        Ok(rows
            .into_iter()
            .map(|r| LayerSpan { id: r.id, tok_start: r.tok_start, tok_end: r.tok_end, score: r.score, kind: r.kind, target: r.target, user_verdict: r.user_verdict })
            .collect())
    })
    .await
}

/// Export a run's matches as CSV or JSON (§6.6) to `<lab dir>/exports/`.
#[tauri::command]
pub async fn reuse_export(state: State<'_, ManagedLabState>, run_id: i64, format: String) -> Result<String, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let conn = db(&h)?;
        let mut rows = read_matches(&conn, &format!("SELECT {} FROM reuse_match WHERE run_id = ?1 ORDER BY score DESC", MATCH_COLUMNS), &[&run_id])?;
        with_titles(h.source.as_ref(), &mut rows);
        let (name, body) = match format.as_str() {
            "json" => (format!("reuse-run-{}.json", run_id), serde_json::to_string_pretty(&rows).map_err(|e| LabError::Other(e.to_string()))?),
            _ => {
                let mut out = String::from("id,book_id,part_index,page_id,tok_start,tok_end,target_book_id,target_title,target_part_index,target_page_id,target_tok_start,target_tok_end,score,type,surface_agree,lemma_agree,root_agree,coverage,banality_factor,banal_share,aligned,zone,verdict,snapshot\n");
                for r in &rows {
                    let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
                    out.push_str(&format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{},{:.4},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{},{},{}\n",
                        r.id,
                        r.book_id,
                        r.part_index,
                        r.page_id,
                        r.tok_start,
                        r.tok_end,
                        r.target.book_id,
                        esc(r.target_title.as_deref().unwrap_or("")),
                        r.target.part_index,
                        r.target.page_id,
                        r.t_start,
                        r.t_end,
                        r.score,
                        r.kind.as_str(),
                        r.components.surface_agree,
                        r.components.lemma_agree,
                        r.components.root_agree,
                        r.components.coverage,
                        r.components.banality_factor,
                        r.components.banal_share,
                        r.components.aligned,
                        r.zone.map(|z| z.as_str()).unwrap_or(""),
                        r.user_verdict.as_deref().unwrap_or(""),
                        esc(&r.snapshot),
                    ));
                }
                (format!("reuse-run-{}.csv", run_id), out)
            }
        };
        crate::commands::stats::save_export(name, body)
    })
    .await
}
