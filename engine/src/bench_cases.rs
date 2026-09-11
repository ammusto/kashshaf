//! Query-case definitions shared by the local bench (`bin/bench.rs`) and the
//! remote bench (`bench_remote`, feature `remote`). The JSON files under
//! `engine/bench/` deserialize into these.

use crate::search::{SearchMode, SearchTerm};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QuerySpec {
    Term { query: String, mode: SearchMode, #[serde(default)] offset: usize },
    Combined { and_terms: Vec<SearchTerm>, or_terms: Vec<SearchTerm> },
    Proximity { term1: SearchTerm, term2: SearchTerm, distance: usize, #[serde(default)] offset: usize },
    Wildcard { query: String, #[serde(default)] offset: usize },
    Name { forms: Vec<Vec<String>> },
    Variants { query: String, mode: SearchMode },
    PageLoad { pages: Vec<(u64, u64, u64)> },
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueryCase {
    pub name: String,
    #[serde(flatten)]
    pub spec: QuerySpec,
    #[serde(default)]
    pub book_ids: Option<Vec<u64>>,
    /// Per-case override of the engine's exact-counts flag (local bench only).
    #[serde(default)]
    pub exact_counts: Option<bool>,
}

impl QueryCase {
    /// The same case at a later window (offset), for "page 20" measurements.
    pub fn at_offset(&self, offset: usize, suffix: &str) -> Option<QueryCase> {
        let spec = match &self.spec {
            QuerySpec::Term { query, mode, .. } => QuerySpec::Term { query: query.clone(), mode: *mode, offset },
            QuerySpec::Proximity { term1, term2, distance, .. } => {
                QuerySpec::Proximity { term1: term1.clone(), term2: term2.clone(), distance: *distance, offset }
            }
            QuerySpec::Wildcard { query, .. } => QuerySpec::Wildcard { query: query.clone(), offset },
            _ => return None,
        };
        Some(QueryCase { name: format!("{} {}", self.name, suffix), spec, book_ids: self.book_ids.clone(), exact_counts: self.exact_counts })
    }
}

/// Percentile of a sorted sample (nearest rank).
pub fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
