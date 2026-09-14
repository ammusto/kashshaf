//! `ApiSource`: the corpus over HTTP, for users without a local copy
//! (Lab spec §2.4, §3.1).
//!
//! Phase 0 uses only routes the server already has — `/health`, `/books`,
//! `/page`, `/page/tokens` — so the book browser and the reader work online
//! today. The bulk fetch that Phase 1's statistics need is `GET
//! /book/{id}/tokens` (§5.1); until the server reports `bulk_tokens: true`,
//! [`BookSource::book_pages`] here says so rather than fetching 500 pages one
//! at a time.

use super::{unavailable, BookMetadata, BookSource, CandidateQuery, Layer, Page, PageRef, Token};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub const DEFAULT_API_BASE: &str = "https://api.kashshaf.com";

/// The subset of `/health` Lab needs: which corpus the server serves, and
/// whether it is new enough for the bulk fetch (§10, "Compatibility note").
#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub version: String,
    #[serde(default)]
    pub corpus_version: Option<String>,
    #[serde(default)]
    pub db_schema_version: Option<i64>,
    /// Absent on servers that predate §5.1; absent means "no".
    #[serde(default)]
    pub bulk_tokens: bool,
}

pub struct ApiSource {
    base: String,
    client: reqwest::blocking::Client,
    corpus_version: String,
    health: Health,
}

/// The `/page` response: a `SearchResult`, of which Lab uses the page fields.
#[derive(Debug, Deserialize)]
struct PageResponse {
    part_label: String,
    page_number: String,
    #[serde(default)]
    body: Option<String>,
}

impl ApiSource {
    /// Probe `/health` and keep the answer. Called at startup, so a server
    /// that is down or too old is reported before any panel opens.
    pub fn connect(base: &str) -> Result<Self> {
        let base = base.trim_end_matches('/').to_string();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        let health: Health = client
            .get(format!("{}/health", base))
            .send()
            .with_context(|| format!("contacting {}", base))?
            .error_for_status()?
            .json()
            .context("parsing /health")?;
        let corpus_version = health
            .corpus_version
            .clone()
            .ok_or_else(|| anyhow!("{} does not report a corpus version", base))?;
        Ok(Self { base, client, corpus_version, health })
    }

    pub fn health(&self) -> &Health {
        &self.health
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Whether the server implements the bulk token fetch of §5.1.
    pub fn supports_bulk_tokens(&self) -> bool {
        self.health.bulk_tokens
    }

    fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.client
            .get(format!("{}{}", self.base, path))
            .send()
            .with_context(|| format!("GET {}", path))?
            .error_for_status()?
            .json()
            .with_context(|| format!("parsing the response to GET {}", path))
    }
}

impl BookSource for ApiSource {
    fn corpus_version(&self) -> &str {
        &self.corpus_version
    }

    fn books(&self) -> Result<Vec<BookMetadata>> {
        let all: Vec<BookMetadata> = self.get_json("/books")?;
        Ok(all.into_iter().filter(|b| b.in_corpus.unwrap_or(false)).collect())
    }

    fn book(&self, id: u64) -> Result<Option<BookMetadata>> {
        Ok(self.books()?.into_iter().find(|b| b.id == id))
    }

    fn page_refs(&self, _id: u64) -> Result<Vec<PageRef>> {
        // There is no page-list route, and §5.2 adds none: the page list comes
        // out of the bulk fetch (§5.1) when Phase 1 wires it up. The reader
        // navigates by part/page label in the meantime.
        Err(unavailable(
            "Listing a book's pages",
            "the server route for it is GET /book/{id}/tokens (spec §5.1), which is not implemented yet",
        ))
    }

    fn book_pages(&self, _id: u64, _progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
        Err(unavailable(
            "Loading a whole book",
            if self.supports_bulk_tokens() {
                "Lab does not use the server's bulk token route before Phase 1"
            } else {
                "this server is too old: it does not report bulk_tokens (spec §5.1)"
            },
        ))
    }

    fn page(&self, id: u64, part: u32, page: u64) -> Result<Option<Page>> {
        let q = format!("id={}&part_index={}&page_id={}", id, part, page);
        let meta: Option<PageResponse> = self.get_json(&format!("/page?{}", q))?;
        let Some(meta) = meta else { return Ok(None) };
        let tokens: Vec<Token> = self.get_json(&format!("/page/tokens?{}", q))?;
        Ok(Some(Page {
            book_id: id,
            part_index: part,
            page_id: page,
            part_label: meta.part_label,
            page_number: meta.page_number,
            body: meta.body.unwrap_or_default(),
            tokens,
        }))
    }

    fn freq(&self, _layer: Layer, _id: u32) -> Result<u64> {
        // §3.4: api mode reads frequencies from the shipped snapshot, added in
        // Phase 1 with keyness.
        Err(unavailable(
            "Corpus frequency",
            "it comes from the shipped frequency snapshot (spec §3.4), added with keyness in Phase 1",
        ))
    }

    fn find_pages(&self, _q: &CandidateQuery) -> Result<Vec<PageRef>> {
        Err(unavailable("Candidate retrieval", "not implemented before Phase 3"))
    }
}
