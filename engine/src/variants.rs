//! Variants: distribution of surface forms that match a lemma or root query.
//!
//! For a query like `lemma phrase علم حقيقة`, this module:
//!  1. Asks SearchEngine for every page hit (unscored, unpaginated).
//!  2. Resolves each query token to the set of token_definition rows whose
//!     lemma_id (or root_id) matches.
//!  3. Walks the page_tokens blobs of those hits (batched through the
//!     TokenCache decoder, so both blob encodings work), scanning for
//!     N-position runs where each token_def_id falls in the corresponding
//!     candidate set, and tallies the matched surface tuples.
//!
//! For very large hit sets (>MAX_SCANNED_HITS) we uniformly sub-sample rather
//! than aborting; the response carries `was_sampled` so the UI can flag it.

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::cache::TokenCache;
use crate::normalize::normalize_root_query;
use crate::search::{SearchEngine, SearchFilters, SearchMode};
use crate::tokens::PageKey;

/// Hard cap on the number of page blobs we walk in one variants call.
pub const MAX_SCANNED_HITS: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// One surface per query position, in query order.
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
    /// True when scanned_hits < total_hits (counts are estimates).
    pub was_sampled: bool,
    pub elapsed_ms: u64,
}

/// For each query token, a map of token_definition.id → surface for every
/// definition whose lemma (or root) matches that token. An empty inner map
/// means the token resolved to nothing; the scan then yields zero matches.
pub fn lemma_candidates_for_query(conn: &Connection, query: &str, mode: SearchMode) -> Result<Vec<HashMap<u32, String>>> {
    let tokens: Vec<String> = match mode {
        SearchMode::Lemma => query.split_whitespace().map(|s| s.to_string()).collect(),
        SearchMode::Root => normalize_root_query(query).split_whitespace().map(|s| s.to_string()).collect(),
        SearchMode::Surface => {
            return Err(anyhow!("variants are only available for lemma and root searches"));
        }
    };
    if tokens.is_empty() {
        return Err(anyhow!("query is empty"));
    }
    let (lookup_table, lookup_col, fk_col) = match mode {
        SearchMode::Lemma => ("lemmas", "lemma", "lemma_id"),
        SearchMode::Root => ("roots", "root", "root_id"),
        SearchMode::Surface => unreachable!(),
    };

    let mut sets: Vec<HashMap<u32, String>> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let lookup_sql = format!("SELECT id FROM {} WHERE {} = ?1", lookup_table, lookup_col);
        let id_opt: Option<i64> = conn.query_row(&lookup_sql, rusqlite::params![token], |row| row.get(0)).ok();
        let Some(parent_id) = id_opt else {
            sets.push(HashMap::new());
            continue;
        };
        let cand_sql = format!("SELECT id, surface FROM token_definitions WHERE {} = ?1", fk_col);
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
    pub pages_attempted: usize,
    pub pages_with_blob: usize,
    pub pages_prefiltered: usize,
    pub pages_with_match: usize,
    pub positions_scanned: u64,
    pub fetch_micros: u128,
}

/// Count exact phrase matches whose token_def_ids align position-by-position
/// with `candidate_sets`, over the pages in `hits`.
pub fn scan_variants(
    cache: &TokenCache,
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
    let union: HashSet<u32> = candidate_sets.iter().flat_map(|m| m.keys().copied()).collect();

    let mut counts: HashMap<Vec<String>, u32> = HashMap::new();
    for chunk in hits.chunks(2000) {
        let keys: Vec<PageKey> = chunk.iter().map(|&(t, part, p)| PageKey::new(t, part, p)).collect();
        let t0 = std::time::Instant::now();
        let pages = cache.get_ids_batch(&keys)?;
        stats.fetch_micros += t0.elapsed().as_micros();

        for key in &keys {
            let Some(tokens) = pages.get(key) else { continue };
            if tokens.len() < n {
                continue;
            }
            stats.pages_with_blob += 1;
            if !tokens.iter().any(|t| union.contains(t)) {
                stats.pages_prefiltered += 1;
                continue;
            }
            let last_start = tokens.len() - n;
            stats.positions_scanned = stats.positions_scanned.saturating_add((last_start + 1) as u64);
            let mut matched_on_page = false;
            for start in 0..=last_start {
                let mut tuple: Vec<String> = Vec::with_capacity(n);
                let mut all_match = true;
                for i in 0..n {
                    match candidate_sets[i].get(&tokens[start + i]) {
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
    }
    Ok((counts, stats))
}

/// End-to-end variants pipeline: Tantivy hit collection, sampling, candidate
/// resolution, blob scan, sorting.
pub fn compute_variants(
    engine: &SearchEngine,
    cache: &TokenCache,
    query: &str,
    mode: SearchMode,
    filters: &SearchFilters,
) -> Result<VariantsResponse> {
    let t0 = std::time::Instant::now();

    let stage = std::time::Instant::now();
    let (mut hits, count_total) = engine.collect_all_hits(query, mode, filters)?;
    let total_hits = hits.len();
    eprintln!(
        "[variants] stage1 collect_all_hits: {} ms (hits={}, count_total={})",
        stage.elapsed().as_millis(),
        total_hits,
        count_total
    );

    let was_sampled = total_hits > MAX_SCANNED_HITS;
    if was_sampled {
        let stride = total_hits.div_ceil(MAX_SCANNED_HITS);
        hits = hits.into_iter().step_by(stride).collect();
    }
    let scanned_hits = hits.len();

    let conn = Connection::open(cache.db_path())?;
    let stage = std::time::Instant::now();
    let candidate_sets = lemma_candidates_for_query(&conn, query, mode)?;
    eprintln!(
        "[variants] stage2 candidates: {} ms (per position {:?})",
        stage.elapsed().as_millis(),
        candidate_sets.iter().map(|s| s.len()).collect::<Vec<_>>()
    );

    let stage = std::time::Instant::now();
    let (counts, s) = scan_variants(cache, &hits, &candidate_sets)?;
    eprintln!(
        "[variants] stage3 scan: {} ms (attempted={}, with_blob={}, prefiltered={}, with_match={}, positions={}, fetch={} ms)",
        stage.elapsed().as_millis(),
        s.pages_attempted,
        s.pages_with_blob,
        s.pages_prefiltered,
        s.pages_with_match,
        s.positions_scanned,
        s.fetch_micros / 1000
    );

    let mut variants: Vec<Variant> = counts
        .into_iter()
        .map(|(surface_tuple, freq)| Variant { surface_tuple, freq })
        .collect();
    variants.sort_by(|a, b| b.freq.cmp(&a.freq).then_with(|| a.surface_tuple.cmp(&b.surface_tuple)));

    Ok(VariantsResponse {
        variants,
        total_hits,
        scanned_hits,
        was_sampled,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}
