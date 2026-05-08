//! Variants computation for the HTTP API server. Mirror of
//! src-tauri/src/variants.rs — same algorithm, same constants, different crate.
//! Keep these two files in sync; if they drift the desktop and web outputs
//! disagree.

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::search::{normalize_root_query, SearchEngine, SearchFilters, SearchMode};

pub const MAX_SCANNED_HITS: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    pub surface_tuple: Vec<String>,
    pub freq: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantsResponse {
    pub variants: Vec<Variant>,
    pub total_hits: usize,
    pub scanned_hits: usize,
    pub was_sampled: bool,
    pub elapsed_ms: u64,
}

pub fn lemma_candidates_for_query(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
) -> Result<Vec<HashMap<u32, String>>> {
    let tokens: Vec<String> = match mode {
        SearchMode::Lemma => query.split_whitespace().map(|s| s.to_string()).collect(),
        SearchMode::Root => normalize_root_query(query)
            .split_whitespace()
            .map(|s| s.to_string())
            .collect(),
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

pub fn scan_variants(
    conn: &Connection,
    hits: &[(u64, u64, u64)],
    candidate_sets: &[HashMap<u32, String>],
) -> Result<HashMap<Vec<String>, u32>> {
    let n = candidate_sets.len();
    if n == 0 || candidate_sets.iter().any(|s| s.is_empty()) {
        return Ok(HashMap::new());
    }

    let union: HashSet<u32> = candidate_sets
        .iter()
        .flat_map(|m| m.keys().copied())
        .collect();

    let mut counts: HashMap<Vec<String>, u32> = HashMap::new();
    let mut stmt =
        conn.prepare("SELECT token_ids FROM page_tokens WHERE book_id = ?1 AND page_id = ?2")?;

    for &(text_id, _part_index, page_id) in hits {
        let blob_opt: Option<Vec<u8>> = stmt
            .query_row(
                rusqlite::params![text_id as i64, page_id as i64],
                |row| row.get(0),
            )
            .ok();
        let Some(blob) = blob_opt else { continue };
        if blob.len() < 4 * n {
            continue;
        }

        let tokens: Vec<u32> = blob
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        if tokens.len() < n {
            continue;
        }

        if !tokens.iter().any(|t| union.contains(t)) {
            continue;
        }

        let last_start = tokens.len() - n;
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
            }
        }
    }
    Ok(counts)
}

pub fn compute_variants(
    engine: &SearchEngine,
    corpus_db_path: &Path,
    query: &str,
    mode: SearchMode,
    filters: &SearchFilters,
) -> Result<VariantsResponse> {
    let start = std::time::Instant::now();

    let (mut hits, _count_total) = engine.collect_all_hits(query, mode, filters)?;
    let total_hits = hits.len();

    let was_sampled = total_hits > MAX_SCANNED_HITS;
    if was_sampled {
        let stride = total_hits.div_ceil(MAX_SCANNED_HITS);
        hits = hits.into_iter().step_by(stride).collect();
    }
    let scanned_hits = hits.len();

    let conn = Connection::open(corpus_db_path)?;
    let candidate_sets = lemma_candidates_for_query(&conn, query, mode)?;
    let counts = scan_variants(&conn, &hits, &candidate_sets)?;

    let mut variants: Vec<Variant> = counts
        .into_iter()
        .map(|(surface_tuple, freq)| Variant { surface_tuple, freq })
        .collect();
    variants.sort_by(|a, b| {
        b.freq
            .cmp(&a.freq)
            .then_with(|| a.surface_tuple.cmp(&b.surface_tuple))
    });

    Ok(VariantsResponse {
        variants,
        total_hits,
        scanned_hits,
        was_sampled,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}
