//! Variants: distribution of surface forms that match a lemma or root query.
//!
//! For a query like `lemma phrase علم حقيقة`, this module:
//!  1. Asks SearchEngine for every page hit (unscored, unpaginated).
//!  2. Resolves each query token to the set of token_definition rows whose
//!     lemma_id (or root_id) matches.
//!  3. Walks the page_tokens BLOBs of those hits in order, scanning for
//!     N-position runs where each token_def_id falls in the corresponding
//!     candidate set, and tallies the matched surface tuples.
//!
//! The pre-filter (union containment) skips pages that can't possibly match.
//! For very large hit sets (>MAX_SCANNED_HITS) we uniformly sub-sample rather
//! than aborting; the response carries `was_sampled` so the UI can flag it.

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::search::{normalize_root_query, SearchEngine, SearchFilters, SearchMode};

/// Hard cap on the number of page blobs we walk in one variants call.
/// Larger hit sets are uniformly sub-sampled; counts in the response are then
/// estimates, and `was_sampled` is set so the UI can warn.
pub const MAX_SCANNED_HITS: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// One surface per query position, in query order
    /// (e.g. ["يعلم", "حقيقة"] for a 2-token lemma phrase).
    pub surface_tuple: Vec<String>,
    /// Number of phrase matches counted in the scanned hits.
    pub freq: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantsResponse {
    pub variants: Vec<Variant>,
    /// Total Tantivy matches before any sampling.
    pub total_hits: usize,
    /// Number of hits actually walked (≤ total_hits).
    pub scanned_hits: usize,
    /// True when scanned_hits < total_hits (i.e., counts are estimates).
    pub was_sampled: bool,
    pub elapsed_ms: u64,
}

/// For each query token, return a HashMap of token_definition.id → surface
/// for every token_definition whose lemma (or root) matches that query token.
/// The map serves as both the membership check during the blob scan and the
/// source of the surface string when recording matched tuples.
///
/// An empty inner map means that query token resolved to nothing in the
/// corpus (typo, or stop word stripped during build), and the scan will
/// produce zero matches at that position. We don't error — the empty result
/// is itself the answer.
pub fn lemma_candidates_for_query(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
) -> Result<Vec<HashMap<u32, String>>> {
    let tokens: Vec<String> = match mode {
        SearchMode::Lemma => query
            .split_whitespace()
            .map(|s| s.to_string())
            .collect(),
        SearchMode::Root => normalize_root_query(query)
            .split_whitespace()
            .map(|s| s.to_string())
            .collect(),
        SearchMode::Surface => {
            return Err(anyhow!(
                "variants are only available for lemma and root searches"
            ));
        }
    };

    if tokens.is_empty() {
        return Err(anyhow!("query is empty"));
    }

    // Choose the lookup table + column based on mode. The shape of the
    // downstream query is identical otherwise.
    let (lookup_table, lookup_col, fk_col) = match mode {
        SearchMode::Lemma => ("lemmas", "lemma", "lemma_id"),
        SearchMode::Root => ("roots", "root", "root_id"),
        SearchMode::Surface => unreachable!(),
    };

    let mut sets: Vec<HashMap<u32, String>> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let lookup_sql = format!("SELECT id FROM {} WHERE {} = ?1", lookup_table, lookup_col);
        let id_opt: Option<i64> = conn
            .query_row(&lookup_sql, rusqlite::params![token], |row| row.get(0))
            .ok();
        let Some(parent_id) = id_opt else {
            sets.push(HashMap::new());
            continue;
        };

        let cand_sql = format!(
            "SELECT id, surface FROM token_definitions WHERE {} = ?1",
            fk_col
        );
        let mut stmt = conn.prepare(&cand_sql)?;
        let rows = stmt.query_map([parent_id], |row| {
            let id: i64 = row.get(0)?;
            let surface: String = row.get(1)?;
            Ok((id as u32, surface))
        })?;
        let mut map: HashMap<u32, String> = HashMap::new();
        for r in rows {
            let (id, surface) = r?;
            map.insert(id, surface);
        }
        sets.push(map);
    }
    Ok(sets)
}

#[derive(Debug, Default, Clone)]
pub struct ScanStats {
    /// Total pages we attempted to fetch (hits.len()).
    pub pages_attempted: usize,
    /// Pages where corpus.db actually returned a non-empty blob.
    pub pages_with_blob: usize,
    /// Pages that hit the union pre-filter (no token in the page intersects
    /// the candidate union → cheap skip without a position scan).
    pub pages_prefiltered: usize,
    /// Pages where at least one position-scan match was found.
    pub pages_with_match: usize,
    /// Total token_id positions scanned across all pages (approximates the
    /// inner-loop work).
    pub positions_scanned: u64,
    /// Wall-clock cost of just the SQLite blob reads, in microseconds.
    /// Helps separate I/O cost from CPU cost.
    pub sql_micros: u128,
}

/// Walks page_tokens BLOBs for `hits` and counts exact phrase matches whose
/// token_def_ids align position-by-position with `candidate_sets`.
///
/// Returns a HashMap of surface tuple → frequency plus per-stage stats so the
/// orchestrator can log a breakdown of where the time went.
pub fn scan_variants(
    conn: &Connection,
    hits: &[(u64, u64, u64)],
    candidate_sets: &[HashMap<u32, String>],
) -> Result<(HashMap<Vec<String>, u32>, ScanStats)> {
    let mut stats = ScanStats {
        pages_attempted: hits.len(),
        ..Default::default()
    };

    let n = candidate_sets.len();
    if n == 0 || candidate_sets.iter().any(|s| s.is_empty()) {
        return Ok((HashMap::new(), stats));
    }

    // Union of all candidate token_def_ids across positions. Used as a quick
    // page-level pre-filter: if no token in the page is in this set, the
    // phrase can't possibly match, skip the position scan entirely.
    let union: HashSet<u32> = candidate_sets
        .iter()
        .flat_map(|m| m.keys().copied())
        .collect();

    let mut counts: HashMap<Vec<String>, u32> = HashMap::new();
    let mut stmt =
        conn.prepare("SELECT token_ids FROM page_tokens WHERE book_id = ?1 AND page_id = ?2")?;

    for &(text_id, _part_index, page_id) in hits {
        let sql_t0 = std::time::Instant::now();
        let blob_opt: Option<Vec<u8>> = stmt
            .query_row(
                rusqlite::params![text_id as i64, page_id as i64],
                |row| row.get(0),
            )
            .ok();
        stats.sql_micros += sql_t0.elapsed().as_micros();

        let Some(blob) = blob_opt else { continue };
        if blob.len() < 4 * n {
            continue;
        }
        stats.pages_with_blob += 1;

        let tokens: Vec<u32> = blob
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        if tokens.len() < n {
            continue;
        }

        // Page-level pre-filter — typically eliminates >95% of hits cheaply.
        if !tokens.iter().any(|t| union.contains(t)) {
            stats.pages_prefiltered += 1;
            continue;
        }

        // Position scan. For each candidate start offset, check whether the
        // next n token_def_ids fall in their respective sets. Build the
        // surface tuple as we go so we don't need a second pass.
        let last_start = tokens.len() - n;
        let positions_this_page = (last_start + 1) as u64;
        stats.positions_scanned = stats.positions_scanned.saturating_add(positions_this_page);

        let mut matched_on_page = false;
        for start in 0..=last_start {
            let mut tuple: Vec<String> = Vec::with_capacity(n);
            let mut all_match = true;
            for i in 0..n {
                let tdef = tokens[start + i];
                match candidate_sets[i].get(&tdef) {
                    Some(surface) => tuple.push(surface.clone()),
                    None => {
                        all_match = false;
                        break;
                    }
                }
            }
            if all_match {
                *counts.entry(tuple).or_insert(0) += 1;
                matched_on_page = true;
            }
        }
        if matched_on_page {
            stats.pages_with_match += 1;
        }
    }
    Ok((counts, stats))
}

/// End-to-end variants pipeline: Tantivy hit collection, sampling, candidate
/// resolution, blob scan, sorting. Stage timings + per-stage counts logged to
/// stderr so the bottleneck is visible.
pub fn compute_variants(
    engine: &SearchEngine,
    corpus_db_path: &Path,
    query: &str,
    mode: SearchMode,
    filters: &SearchFilters,
) -> Result<VariantsResponse> {
    let t0 = std::time::Instant::now();
    eprintln!("[variants] BEGIN query={:?} mode={:?}", query, mode);

    // ── Stage 1: enumerate every Tantivy hit. ──
    let stage_t0 = std::time::Instant::now();
    let (mut hits, count_total) = engine.collect_all_hits(query, mode, filters)?;
    let t1_elapsed = stage_t0.elapsed();
    let total_hits = hits.len();
    eprintln!(
        "[variants] stage1 collect_all_hits: {} ms  (hits={}, count_total={})",
        t1_elapsed.as_millis(),
        total_hits,
        count_total
    );

    // Sampling. Cheap; lumped into stage1 timing for simplicity.
    let was_sampled = total_hits > MAX_SCANNED_HITS;
    if was_sampled {
        let stride = total_hits.div_ceil(MAX_SCANNED_HITS);
        hits = hits.into_iter().step_by(stride).collect();
        eprintln!(
            "[variants]   sampled: stride={} → {} pages will be scanned",
            stride,
            hits.len()
        );
    }
    let scanned_hits = hits.len();

    // Open corpus.db once and reuse across stages.
    let conn = Connection::open(corpus_db_path)?;

    // ── Stage 2: resolve candidate token_def_ids per query position. ──
    let stage_t0 = std::time::Instant::now();
    let candidate_sets = lemma_candidates_for_query(&conn, query, mode)?;
    let t2_elapsed = stage_t0.elapsed();
    let cand_sizes: Vec<usize> = candidate_sets.iter().map(|s| s.len()).collect();
    eprintln!(
        "[variants] stage2 lemma_candidates_for_query: {} ms  (candidates_per_position={:?})",
        t2_elapsed.as_millis(),
        cand_sizes
    );

    // ── Stage 3: blob scan + position checks. ──
    let stage_t0 = std::time::Instant::now();
    let (counts, scan_stats) = scan_variants(&conn, &hits, &candidate_sets)?;
    let t3_elapsed = stage_t0.elapsed();
    eprintln!(
        "[variants] stage3 scan_variants: {} ms  (attempted={}, with_blob={}, prefiltered={}, with_match={}, positions_scanned={}, sql_io={} ms)",
        t3_elapsed.as_millis(),
        scan_stats.pages_attempted,
        scan_stats.pages_with_blob,
        scan_stats.pages_prefiltered,
        scan_stats.pages_with_match,
        scan_stats.positions_scanned,
        scan_stats.sql_micros / 1000,
    );

    // ── Stage 4: aggregation + sort. ──
    let stage_t0 = std::time::Instant::now();
    let mut variants: Vec<Variant> = counts
        .into_iter()
        .map(|(surface_tuple, freq)| Variant { surface_tuple, freq })
        .collect();
    variants.sort_by(|a, b| {
        b.freq
            .cmp(&a.freq)
            .then_with(|| a.surface_tuple.cmp(&b.surface_tuple))
    });
    let t4_elapsed = stage_t0.elapsed();
    eprintln!(
        "[variants] stage4 aggregation+sort: {} ms  (variants={})",
        t4_elapsed.as_millis(),
        variants.len()
    );

    let elapsed_ms = t0.elapsed().as_millis() as u64;
    eprintln!("[variants] DONE total={} ms", elapsed_ms);

    Ok(VariantsResponse {
        variants,
        total_hits,
        scanned_hits,
        was_sampled,
        elapsed_ms,
    })
}
