//! Search within the current text (Lab spec 1.5 §D).
//!
//! Kashshaf's boolean search, narrowed to one book: up to three AND terms and
//! three OR terms, each on the surface, lemma or root layer. The engine runs
//! it locally; in api mode `POST /search/combined` does, with `book_ids`
//! filtered to the one text — the same query either way, as §3.1 requires.
//!
//! Clitic expansion (Kashshaf's "ignore clitics") happens in the frontend,
//! which turns one surface term into its `و ف ب ل ك` variants as OR terms,
//! exactly as Kashshaf's bridge does. Nothing here needs to know about it.

use crate::error::LabError;
use crate::state::{source_of, ManagedLabState};
use serde::{Deserialize, Serialize};
use tauri::State;

/// One term of the query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Term {
    pub query: String,
    /// `surface` | `lemma` | `root`.
    pub mode: String,
}

/// One hit, as the results list renders it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hit {
    pub part_index: u32,
    pub page_id: u64,
    /// The printed labels, for the page label of §C1.
    pub part_label: String,
    pub page_number: String,
    pub body: String,
    /// The token `body` starts at when it is the engine's snippet (0.8.0);
    /// none when it is the whole page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet_start_token: Option<u32>,
    pub score: f32,
    /// Token indices the query matched, for the reader's highlight.
    pub matched: Vec<u32>,
    /// The match runs on from this page onto the next, or in from the one
    /// before: `matched` is this page's share, `secondary` the other's
    /// (corpus 4.3.0's boundary index).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub crosses_page: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<HitSecondary>,
}

/// The other page of a hit across a page break, and its share of the match.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HitSecondary {
    pub part_index: u32,
    pub page_id: u64,
    pub part_label: String,
    pub page_number: String,
    pub matched: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub hits: Vec<Hit>,
    pub total: usize,
    pub elapsed_ms: u64,
    /// True when the engine capped the walk — Lab runs with exact counts, so
    /// this should never be set; it is reported rather than assumed.
    pub capped: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchArgs {
    pub book_id: u64,
    #[serde(default)]
    pub and_terms: Vec<Term>,
    #[serde(default)]
    pub or_terms: Vec<Term>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

/// Search one book (spec §D).
#[tauri::command]
pub async fn search_book(state: State<'_, ManagedLabState>, args: SearchArgs) -> Result<SearchResults, LabError> {
    let source = source_of(&state)?;
    tokio::task::spawn_blocking(move || {
        if args.and_terms.is_empty() && args.or_terms.is_empty() {
            return Ok(SearchResults { hits: Vec::new(), total: 0, elapsed_ms: 0, capped: false });
        }
        Ok(source.search_book(
            args.book_id,
            &args.and_terms,
            &args.or_terms,
            args.limit.unwrap_or(200).clamp(1, 2000),
            args.offset.unwrap_or(0),
        )?)
    })
    .await
    .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
}
