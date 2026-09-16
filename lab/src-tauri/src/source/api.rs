//! `ApiSource`: the corpus over HTTP, for users without a local copy
//! (Lab spec §2.4, §3.1).
//!
//! Single pages come from the routes the server has always had — `/page` and
//! `/page/tokens`. A whole book comes from `GET /book/{id}/tokens` (§5.1): one
//! zstd-compressed NDJSON body, cached on disk (§2.5) so the second panel to
//! ask for the same book pays nothing. A server that does not report
//! `bulk_tokens` is refused with the reason rather than fetched page by page,
//! which would look like a hang.

use super::cache::{BulkCache, DEFAULT_MAX_BYTES};
use super::freq::{FreqLayer, FreqTable};
use super::{unavailable, BookMetadata, BookSource, CandidateQuery, Hits, Layer, NamedId, Page, PageEntry, PageRef, Token, TocNode, TocRow};
use std::sync::{Arc, Mutex};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_API_BASE: &str = "https://api.kashshaf.com";

/// The subset of `/health` Lab needs: which corpus the server serves, and
/// whether it is new enough for the bulk fetch (§10, "Compatibility note").
#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    /// `toc: true` once the server has `toc.db` (spec 1.5 §B2).
    #[serde(default)]
    pub toc: bool,
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
    /// Bulk bodies on disk (spec §2.5). `None` when Lab has no directory of
    /// its own; api mode then works, just without caching.
    cache: Option<BulkCache>,
    lab_dir: Option<std::path::PathBuf>,
    freq: Mutex<[Option<Arc<FreqTable>>; 2]>,
}

/// One NDJSON line of `GET /book/{id}/tokens` (spec §5.1).
#[derive(Debug, Deserialize)]
struct BulkPage {
    part_index: u32,
    page_id: u64,
    part_label: String,
    page_number: String,
    body: String,
    tokens: Vec<Token>,
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
        Self::connect_with_cache(base, kashshaf_common::lab_data_dir().ok().as_deref())
    }

    /// As [`Self::connect`], with the bulk cache under `lab_dir` (spec §2.5).
    /// `None` disables caching, which is what the mode-parity test wants: it
    /// must compare what the server sends, not what a previous run left.
    pub fn connect_with_cache(base: &str, lab_dir: Option<&Path>) -> Result<Self> {
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
        let cache = lab_dir.map(|d| BulkCache::new(d, DEFAULT_MAX_BYTES));
        Ok(Self {
            base,
            client,
            corpus_version,
            health,
            cache,
            lab_dir: lab_dir.map(Path::to_path_buf),
            freq: Mutex::new([None, None]),
        })
    }

    /// The raw zstd body of `GET /book/{id}/tokens`, from the cache when it is
    /// there and from the server otherwise.
    ///
    /// The ETag is `corpus_version + book_id` and the cache key is the same
    /// pair, so a hit is by construction a body for this corpus — there is
    /// nothing to revalidate and no request to make.
    fn bulk_body(&self, book_id: u64) -> Result<Vec<u8>> {
        if let Some(hit) = self.cache.as_ref().and_then(|c| c.get(&self.corpus_version, book_id)) {
            return Ok(hit);
        }
        let url = format!("{}/book/{}/tokens", self.base, book_id);
        let response = self
            .client
            .get(&url)
            // The body is zstd whatever the transport does; asking for an
            // identity transfer encoding keeps a proxy from double-wrapping it.
            .header("Accept-Encoding", "identity")
            .send()
            .with_context(|| format!("GET {}", url))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(anyhow!("book {} is not in the server's corpus", book_id));
        }
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let msg = response.text().unwrap_or_default();
            return Err(anyhow!(
                "the server is limiting bulk requests ({}). Try again shortly, or download the corpus for local mode.",
                msg.trim()
            ));
        }
        let bytes = response.error_for_status()?.bytes()?.to_vec();
        if let Some(c) = &self.cache {
            c.put(&self.corpus_version, book_id, &bytes);
        }
        Ok(bytes)
    }

    /// Decode a bulk body into pages, reporting progress by line.
    fn decode_bulk(&self, book_id: u64, body: &[u8], progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
        let ndjson = zstd::decode_all(body)
            .with_context(|| format!("decompressing the token stream for book {}", book_id))?;
        // The line count is known only after decompression, so progress is
        // reported against it rather than against the compressed bytes.
        let total = ndjson.iter().filter(|b| **b == b'\n').count() as u64;
        let mut pages = Vec::with_capacity(total as usize);
        for (i, line) in ndjson.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let p: BulkPage = serde_json::from_str(&line)
                .with_context(|| format!("book {}, stream line {}", book_id, i + 1))?;
            pages.push(Page {
                book_id,
                part_index: p.part_index,
                page_id: p.page_id,
                part_label: p.part_label,
                page_number: p.page_number,
                body: p.body,
                tokens: p.tokens,
            });
            progress(i as u64 + 1, total);
        }
        Ok(pages)
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

    /// Refuse, with the reason, on a server that predates §5.1 — rather than
    /// falling back to 500 single-page requests, which would look like a hang.
    fn require_bulk(&self) -> Result<()> {
        if self.supports_bulk_tokens() {
            Ok(())
        } else {
            Err(unavailable(
                "Loading a whole book",
                &format!(
                    "this server ({}) does not report bulk_tokens, so it predates GET /book/{{id}}/tokens (spec §5.1)",
                    self.health.version
                ),
            ))
        }
    }

    /// The bulk cache, for the settings panel and the parity test.
    pub fn cache(&self) -> Option<&BulkCache> {
        self.cache.as_ref()
    }

    fn post_json<B: Serialize, T: serde::de::DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        self.client
            .post(format!("{}{}", self.base, path))
            .json(body)
            .send()
            .with_context(|| format!("POST {}", path))?
            .error_for_status()?
            .json()
            .with_context(|| format!("parsing the response to POST {}", path))
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

    /// `/authors` and `/genres` answer with `(id, name)` tuples.
    fn authors(&self) -> Result<Vec<NamedId>> {
        Ok(named(self.get_json("/authors")?))
    }

    fn genres(&self) -> Result<Vec<NamedId>> {
        Ok(named(self.get_json("/genres")?))
    }

    /// §5.2 adds no page-list route: the coordinates come out of the bulk
    /// fetch, whose body the cache then holds, so paging through the reader
    /// afterwards costs nothing.
    fn page_refs(&self, id: u64) -> Result<Vec<PageRef>> {
        self.require_bulk()?;
        Ok(self
            .decode_bulk(id, &self.bulk_body(id)?, &|_, _| {})?
            .into_iter()
            .map(|p| PageRef { book_id: p.book_id, part_index: p.part_index, page_id: p.page_id })
            .collect())
    }

    /// The bulk stream already carries every page's labels, so this is the
    /// same decode with more of each line kept (spec 1.5 C1).
    fn page_entries(&self, id: u64) -> Result<Vec<PageEntry>> {
        self.require_bulk()?;
        Ok(self
            .decode_bulk(id, &self.bulk_body(id)?, &|_, _| {})?
            .into_iter()
            .map(|p| PageEntry {
                book_id: p.book_id,
                part_index: p.part_index,
                page_id: p.page_id,
                page_number: p.page_number,
                part_label: p.part_label,
            })
            .collect())
    }

    fn book_pages(&self, id: u64, progress: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
        self.require_bulk()?;
        self.decode_bulk(id, &self.bulk_body(id)?, progress)
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

    /// §3.4: the shipped snapshot, downloaded once from the corpus CDN into
    /// Lab's cache. The manifest lists `lemma_freq.bin` / `root_freq.bin`
    /// when the corpus build produced them; a corpus without them means
    /// keyness is unavailable online, and this says so.
    fn freq_table(&self, layer: FreqLayer) -> Result<Arc<FreqTable>> {
        let slot = match layer {
            FreqLayer::Lemma => 0,
            FreqLayer::Root => 1,
        };
        if let Some(t) = &self.freq.lock().unwrap()[slot] {
            return Ok(Arc::clone(t));
        }
        let Some(lab_dir) = &self.lab_dir else {
            return Err(unavailable("Corpus frequencies", "Lab has no writable directory to keep the snapshot in"));
        };
        let dir = lab_dir.join("cache");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}-{}", self.corpus_version, layer.file_name()));
        if !path.is_file() {
            let manifest = kashshaf_common::fetch_remote_manifest_blocking()?;
            let Some(entry) = manifest.files.iter().find(|f| f.name == layer.file_name()) else {
                return Err(unavailable(
                    "Corpus frequencies",
                    &format!(
                        "corpus {} does not ship {} (spec §3.4), so keyness needs a local corpus",
                        manifest.corpus_version,
                        layer.file_name()
                    ),
                ));
            };
            if manifest.corpus_version != self.corpus_version {
                return Err(unavailable(
                    "Corpus frequencies",
                    &format!(
                        "the published snapshot is for corpus {} but the server serves {}",
                        manifest.corpus_version, self.corpus_version
                    ),
                ));
            }
            let bytes = self
                .client
                .get(manifest.file_url(&entry.name))
                .send()
                .with_context(|| format!("downloading {}", entry.name))?
                .error_for_status()?
                .bytes()?;
            let tmp = path.with_extension("part");
            std::fs::write(&tmp, &bytes)?;
            if !kashshaf_common::verify_file_hash(&tmp, &entry.hash)? {
                let _ = std::fs::remove_file(&tmp);
                return Err(anyhow!("{} failed hash verification after download", entry.name));
            }
            std::fs::rename(&tmp, &path)?;
        }
        let t = FreqTable::read(&path)?;
        if t.corpus_version != self.corpus_version {
            return Err(unavailable(
                "Corpus frequencies",
                &format!("{} is for corpus {}, the server serves {}", path.display(), t.corpus_version, self.corpus_version),
            ));
        }
        let t = Arc::new(t);
        self.freq.lock().unwrap()[slot] = Some(Arc::clone(&t));
        Ok(t)
    }

    fn search_book(
        &self,
        book_id: u64,
        and_terms: &[crate::commands::search::Term],
        or_terms: &[crate::commands::search::Term],
        limit: usize,
        offset: usize,
    ) -> Result<crate::commands::search::SearchResults> {
        #[derive(Serialize)]
        struct Filters {
            book_ids: Vec<u64>,
        }
        #[derive(Serialize)]
        struct Req<'a> {
            and_terms: &'a [crate::commands::search::Term],
            or_terms: &'a [crate::commands::search::Term],
            filters: Filters,
            limit: usize,
            offset: usize,
        }
        #[derive(Deserialize)]
        struct RespHit {
            part_index: u64,
            page_id: u64,
            #[serde(default)]
            part_label: String,
            #[serde(default)]
            page_number: String,
            #[serde(default)]
            body: String,
            #[serde(default)]
            score: f32,
            #[serde(default)]
            matched_token_indices: Vec<u32>,
        }
        #[derive(Deserialize)]
        struct Resp {
            total_hits: usize,
            results: Vec<RespHit>,
            #[serde(default)]
            elapsed_ms: u64,
            #[serde(default)]
            was_capped: Option<bool>,
        }
        let req = Req {
            and_terms,
            or_terms,
            filters: Filters { book_ids: vec![book_id] },
            limit: limit.min(250),
            offset,
        };
        let r: Resp = self.post_json("/search/combined", &req)?;
        Ok(crate::commands::search::SearchResults {
            hits: r
                .results
                .into_iter()
                .map(|h| crate::commands::search::Hit {
                    part_index: h.part_index as u32,
                    page_id: h.page_id,
                    part_label: h.part_label,
                    page_number: h.page_number,
                    body: h.body,
                    score: h.score,
                    matched: h.matched_token_indices,
                })
                .collect(),
            total: r.total_hits,
            elapsed_ms: r.elapsed_ms,
            capped: r.was_capped.unwrap_or(false),
        })
    }

    /// `GET /book/{id}/toc` (spec 1.5 §B2): the whole tree as JSON, small
    /// enough to fetch per book. A server that predates the route answers
    /// 404, which reaches the caller as the reason the pane is empty.
    fn toc(&self, book_id: u64) -> Result<Vec<TocNode>> {
        self.get_json(&format!("/book/{}/toc", book_id))
            .with_context(|| format!("the table of contents of book {}", book_id))
    }

    fn toc_rows(&self, book_id: u64) -> Result<Vec<TocRow>> {
        Ok(flatten(&self.toc(book_id)?))
    }

    fn toc_status(&self) -> Result<()> {
        if self.health.toc {
            Ok(())
        } else {
            Err(unavailable(
                "The table of contents",
                &format!("this server ({}) does not report toc, so it has no toc.db (spec 1.5 §B)", self.health.version),
            ))
        }
    }

    /// `POST /search/combined` with one `and_term` whose query is the phrase
    /// — the server runs the same engine phrase query local mode does. The
    /// server caps a page of results at 250, so a larger limit pages through
    /// `offset`.
    fn find_pages(&self, q: &CandidateQuery) -> Result<Hits> {
        #[derive(Serialize)]
        struct Term<'a> {
            query: String,
            mode: &'a str,
        }
        #[derive(Serialize)]
        struct Filters<'a> {
            book_ids: &'a [u64],
        }
        #[derive(Serialize)]
        struct Req<'a> {
            and_terms: Vec<Term<'a>>,
            or_terms: Vec<Term<'a>>,
            limit: usize,
            offset: usize,
            #[serde(skip_serializing_if = "Option::is_none")]
            filters: Option<Filters<'a>>,
        }
        #[derive(Deserialize)]
        struct Hit {
            id: u64,
            part_index: u64,
            page_id: u64,
        }
        #[derive(Deserialize)]
        struct Resp {
            total_hits: usize,
            results: Vec<Hit>,
        }
        const SERVER_PAGE: usize = 250;
        let mode = match q.layer {
            Layer::Surface => "surface",
            Layer::Lemma => "lemma",
            Layer::Root => "root",
        };
        let limit = q.limit.max(1);
        let mut hits = Hits::default();
        let mut offset = 0usize;
        loop {
            let want = (limit - hits.pages.len()).min(SERVER_PAGE);
            if want == 0 {
                break;
            }
            let req = Req {
                and_terms: vec![Term { query: q.terms.join(" "), mode }],
                or_terms: vec![],
                limit: want,
                offset,
                filters: q.book_ids.as_deref().map(|b| Filters { book_ids: b }),
            };
            let resp: Resp = self.post_json("/search/combined", &req)?;
            hits.total = resp.total_hits;
            let n = resp.results.len();
            hits.pages.extend(resp.results.into_iter().map(|h| PageRef { book_id: h.id, part_index: h.part_index as u32, page_id: h.page_id }));
            offset += n;
            if n < want || offset >= hits.total {
                break;
            }
        }
        Ok(hits)
    }
}

/// A tree back to rows in reading order, for the api-mode `toc_rows`.
/// `/authors` and `/genres` answer with bare `(id, name)` tuples; the rest of
/// Lab speaks in [`NamedId`].
fn named(rows: Vec<(i64, String)>) -> Vec<NamedId> {
    rows.into_iter()
        .filter(|(_, name)| !name.trim().is_empty())
        .map(|(id, name)| NamedId { id, name })
        .collect()
}

fn flatten(nodes: &[TocNode]) -> Vec<TocRow> {
    fn go(nodes: &[TocNode], out: &mut Vec<TocRow>) {
        for n in nodes {
            out.push(TocRow {
                id: n.id,
                parent: n.parent,
                title: n.title.clone(),
                part_index: n.part_index,
                page_id: n.page_id,
                page_number: n.page_number.clone(),
            });
            go(&n.children, out);
        }
    }
    let mut out = Vec::new();
    go(nodes, &mut out);
    out.sort_by_key(|r| (r.part_index, r.page_id, r.id));
    out
}
