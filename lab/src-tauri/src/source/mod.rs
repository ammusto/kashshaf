//! The book access layer (Lab spec §3.1, §3.2).
//!
//! One trait, two implementations: [`local::LocalSource`] over
//! `kashshaf-engine` and [`api::ApiSource`] over HTTP. Every algorithm in §4
//! takes `&dyn BookSource` and nothing else, so it can be run against an
//! in-memory fake in tests and against either mode at runtime.

pub mod api;
pub mod cache;
pub mod freq;
pub mod local;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use freq::{Freq, FreqLayer, FreqTable};

pub use kashshaf_engine::tokens::{Token, TokenClitic};
pub use kashshaf_engine::toc::{TocNode, TocRow};

/// Book metadata as `metadata.db` stores it. The same shape both modes return
/// and the same shape the TypeScript `BookMetadata` in `@kashshaf/shared`
/// expects, so the bridge is a straight serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookMetadata {
    pub id: u64,
    pub corpus: Option<String>,
    pub title: String,
    pub author_id: Option<i64>,
    pub death_ah: Option<i64>,
    pub century_ah: Option<i64>,
    pub genre_id: Option<i64>,
    pub page_count: Option<i64>,
    pub token_count: Option<i64>,
    pub original_id: Option<String>,
    pub paginated: Option<bool>,
    pub tags: Option<String>,
    pub book_meta: Option<String>,
    pub author_meta: Option<String>,
    pub in_corpus: Option<bool>,
    pub parts: Option<i64>,
    pub metadata_json: Option<String>,
    pub citation_json: Option<String>,
}

/// One page and its tokens (spec §3.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    pub part_label: String,
    pub page_number: String,
    /// Display text with `<title>` tags, as stored.
    pub body: String,
    pub tokens: Vec<Token>,
}

/// Where a page sits in a book, without its text. Reading order is ascending
/// `(part_index, page_id)`, which is how the index is built and what
/// `kashshaf-engine`'s reading-order check verifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PageRef {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
}

impl PageRef {
    /// Just the coordinates, for the many places that compare positions.
    pub fn at(&self) -> (u32, u64) {
        (self.part_index, self.page_id)
    }
}

/// A page of the reader's page list: its coordinates and the labels the
/// book prints on it.
///
/// `PageRef` stays a bare coordinate — it is compared, copied and stored in
/// its thousands — while every *page label* Lab shows (spec 1.5 C1) is built
/// from the printed `page_number` and the part, which live in the index
/// rather than in `page_tokens`. The reader fetches these once per book.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageEntry {
    pub book_id: u64,
    pub part_index: u32,
    pub page_id: u64,
    /// Empty when the index has no document for the page.
    pub page_number: String,
    pub part_label: String,
}

impl PageEntry {
    pub fn as_ref(&self) -> PageRef {
        PageRef { book_id: self.book_id, part_index: self.part_index, page_id: self.page_id }
    }
}

/// Which annotation layer a statistic or a query runs on (spec §4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Surface,
    Lemma,
    Root,
}

/// A phrase/term query used to retrieve reuse candidates (spec §4.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateQuery {
    pub layer: Layer,
    /// Matched as a phrase, in order, on `layer`.
    pub terms: Vec<String>,
    pub limit: usize,
    /// Positions of leniency between the words (amendment 1.4, the
    /// whole-passage fallback). Local mode honours it; the server has no
    /// slop route, so api mode runs the exact phrase.
    #[serde(default)]
    pub slop: u32,
}

/// What a candidate query returns: up to `limit` pages, and how many pages
/// match in all (the phrase's document frequency — how banal it is).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hits {
    pub pages: Vec<PageRef>,
    pub total: usize,
}

/// Everything Lab's algorithms may ask of a corpus.
///
/// Methods that a mode cannot answer return an error naming the reason, never
/// a silently degraded answer (ground rule 5: degrade honestly).
pub trait BookSource: Send + Sync {
    fn corpus_version(&self) -> &str;
    fn books(&self) -> Result<Vec<BookMetadata>>;
    fn book(&self, id: u64) -> Result<Option<BookMetadata>>;
    /// Every page of a book in reading order. `progress(done, total)` is
    /// called as pages are produced so a whole-book run can show progress.
    fn book_pages(&self, id: u64, progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>>;
    /// The page coordinates of a book in reading order, without its text —
    /// what the reader needs to page forward and back.
    fn page_refs(&self, id: u64) -> Result<Vec<PageRef>>;

    /// The same list with each page's printed number and part label, which
    /// every page label in the UI is built from (spec 1.5 C1).
    fn page_entries(&self, id: u64) -> Result<Vec<PageEntry>>;
    fn page(&self, id: u64, part: u32, page: u64) -> Result<Option<Page>>;
    /// Corpus-wide frequencies for one layer (spec §3.4), loaded once and
    /// shared. Keyed by the lemma / root string rather than the id the spec
    /// wrote, because `Token` carries no ids and a string is what both modes
    /// hold. Errors with the reason when the snapshot is unavailable.
    fn freq_table(&self, layer: FreqLayer) -> Result<Arc<FreqTable>>;
    /// Phrase / term search used for reuse candidates (spec §4.3): the same
    /// index query in both modes (engine phrase query locally,
    /// `POST /search/combined` remotely), so the candidate set is the same.
    fn find_pages(&self, q: &CandidateQuery) -> Result<Hits>;

    /// The book's table of contents as a tree (spec 1.5 §B2), from `toc.db`
    /// locally and `GET /book/{id}/toc` in api mode. Errors with the reason
    /// when the corpus predates `toc.db`; never returns an empty tree to mean
    /// "unavailable" — a book with no headings genuinely has none.
    fn toc(&self, book_id: u64) -> Result<Vec<TocNode>>;

    /// The same entries flat, in reading order — what the "which section is
    /// this page in" lookup and the section scopes need.
    fn toc_rows(&self, book_id: u64) -> Result<Vec<TocRow>>;

    /// Whether this source can answer `toc` at all, and why not if it cannot.
    /// Checked once, so the UI can disable the pane without a failed call.
    fn toc_status(&self) -> Result<()>;

    /// Boolean search within one book (spec 1.5 D): the same engine query in
    /// both modes, filtered to the one text.
    fn search_book(
        &self,
        book_id: u64,
        and_terms: &[crate::commands::search::Term],
        or_terms: &[crate::commands::search::Term],
        limit: usize,
        offset: usize,
    ) -> Result<crate::commands::search::SearchResults>;

    /// `Some` for the local corpus: what the operations that only make
    /// sense on disk (building the frequency snapshot) need.
    fn as_local(&self) -> Option<&local::LocalSource> {
        None
    }

    /// Which mode this source is, for the few places that limit a feature
    /// by mode rather than by capability (api-mode reference sets, §2.4).
    fn is_local(&self) -> bool {
        self.as_local().is_some()
    }
}

/// The error a source returns for something its mode genuinely cannot do, so
/// the UI can show the feature disabled with the reason rather than an
/// approximation (spec §2.4).
pub fn unavailable(what: &str, why: &str) -> anyhow::Error {
    anyhow::anyhow!("{} is not available in this mode: {}", what, why)
}
