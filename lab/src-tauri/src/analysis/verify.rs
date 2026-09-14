//! `verify_alignment` (Lab spec §3.3).
//!
//! Checks that the token indices Lab stores mean what the frontend will think
//! they mean: for every page of a book, the number of tokens the backend
//! returns must equal the number [`align::display_token_count`] finds in the
//! page body. The Phase 0 acceptance test runs this over the 25-book sample
//! and expects zero divergences.

use super::align;
use crate::source::BookSource;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// One page where the two sides disagree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Divergence {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub part_label: String,
    pub page_number: String,
    /// What the backend returned.
    pub backend_tokens: usize,
    /// What the frontend tokenizer will find in `body`.
    pub display_tokens: usize,
    /// The first ~120 characters of the body, to make the page findable.
    pub body_head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlignmentReport {
    pub book_id: u64,
    pub pages_checked: usize,
    pub divergences: Vec<Divergence>,
    pub elapsed_ms: u64,
}

impl AlignmentReport {
    pub fn ok(&self) -> bool {
        self.divergences.is_empty()
    }
}

/// Check every page of one book. `progress(done, total)` is forwarded from the
/// source so a long book can report as it goes.
pub fn verify_alignment(
    source: &dyn BookSource,
    book_id: u64,
    progress: &dyn Fn(u64, u64),
) -> Result<AlignmentReport> {
    let t0 = std::time::Instant::now();
    let pages = source.book_pages(book_id, progress)?;
    let mut divergences = Vec::new();
    for p in &pages {
        let display = align::display_token_count(&p.body);
        if display != p.tokens.len() {
            divergences.push(Divergence {
                book_id: p.book_id,
                part_index: p.part_index,
                page_id: p.page_id,
                part_label: p.part_label.clone(),
                page_number: p.page_number.clone(),
                backend_tokens: p.tokens.len(),
                display_tokens: display,
                body_head: p.body.chars().take(120).collect(),
            });
        }
    }
    Ok(AlignmentReport {
        book_id,
        pages_checked: pages.len(),
        divergences,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}
