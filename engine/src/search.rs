//! Search functionality using Tantivy.
//!
//! One `SearchEngine` is opened per process and shared. It owns a single
//! `IndexReader`, resolves every schema field once, detects at startup whether
//! the index is a single segment in reading order (then pagination uses
//! `ReadingOrderCollector`), and detects which **index kind** it is:
//!
//! * `ThreeField` — `surface_text` / `lemma_text` / `root_text` (corpus ≤ 3.x).
//!   Queries are terms/phrases on the mode's field; highlights come from
//!   postings.
//! * `Compound` — one `tokens` field of zero-padded triple ids (corpus 4.x).
//!   Each query word becomes a *set* of triple ids (`TermSetQuery`, or a
//!   `RegexPhraseQuery` with one alternation per position); highlights and
//!   proximity distances come from the page's token ids (forward index)
//!   through the attached `TokenCache`.

use crate::cache::TokenCache;
use crate::collectors::{AllDocsCollector, ReadingOrderCollector};
use crate::forward;
use crate::forward::Members;
use crate::glob::GlobPattern;
use crate::normalize::{count_arabic_letters, normalize_arabic, normalize_root_query};
use crate::positional::{PositionalHit, StreamSink};
use crate::tokens::PageKey;
use crate::triples::{triple_term, TripleMaps};
use crate::walk::{
    default_max_concurrent_walks, Sink, WalkCache, WalkHit, WalkLimits, WalkStats, WalkStatus, WalkWindow, Walker,
    MAX_VERIFIED_HITS, PREFIX_CACHE_BYTES, PREFIX_CACHE_ENTRIES, WALK_BUDGET_MS,
};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ops::Bound;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tantivy::collector::{Count, TopDocs};
use tantivy::postings::Postings;
use tantivy::query::{
    BooleanQuery, EmptyQuery, Occur, PhraseQuery, Query, QueryParser, RangeQuery, RegexPhraseQuery, RegexQuery,
    TermQuery, TermSetQuery,
};
use tantivy::schema::*;
use tantivy::query::EnableScoring;
use tantivy::{DocAddress, DocId, DocSet, Index, IndexReader, ReloadPolicy, Searcher, SegmentReader, Term, TERMINATED};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Surface,
    #[default]
    Lemma,
    Root,
}

/// Wildcard query validation error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WildcardValidationError {
    pub message: String,
}

/// Which wildcard grammar an index supports. The frontend asks for it
/// (`EngineCapabilities`) and validates with the same rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WildcardGrammar {
    /// Compound index: `*`-only glob, any number of `*` per word, any
    /// position; every wildcard word needs at least 2 literal Arabic
    /// letters; surface mode only.
    Glob,
    /// Three-field index (`RegexQuery` path): one `*` per query, not at the
    /// start of a word, surface mode only.
    Legacy,
}

/// Parsed wildcard query.
///
/// `patterns[i]` is the glob of `terms[i]` (a literal word is a pattern
/// without `*`). The remaining fields describe the **first** wildcard word:
/// `segments` / `anchored_start` / `anchored_end` for the glob grammar, and
/// `prefix` / `suffix` / `wildcard_type` for the legacy regex path.
#[derive(Debug, Clone)]
pub struct WildcardQueryInfo {
    pub has_wildcard: bool,
    pub terms: Vec<String>,
    pub patterns: Vec<GlobPattern>,
    pub wildcard_term_index: usize,
    pub wildcard_type: WildcardType,
    pub prefix: String,
    pub suffix: Option<String>,
    pub segments: Vec<String>,
    pub anchored_start: bool,
    pub anchored_end: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WildcardType {
    None,
    Prefix,
    Internal,
}

pub const WILDCARD_ERR_MODE: &str = "Wildcards only supported in Surface mode";
pub const WILDCARD_ERR_LETTERS: &str = "A wildcard word needs at least 2 letters besides *";
pub const WILDCARD_ERR_ONE: &str = "Only one wildcard (*) allowed per search term";
pub const WILDCARD_ERR_START: &str = "Wildcard cannot be at start of word";

/// Validate a wildcard query under the given grammar. Mirrors
/// `src/utils/wildcardValidation.ts`; keep the two in step.
pub fn validate_wildcard_query(query: &str, mode: SearchMode, grammar: WildcardGrammar) -> Result<(), WildcardValidationError> {
    let trimmed = query.trim();
    if !trimmed.contains('*') {
        return Ok(());
    }
    if mode != SearchMode::Surface {
        return Err(WildcardValidationError { message: WILDCARD_ERR_MODE.to_string() });
    }
    match grammar {
        WildcardGrammar::Glob => {
            for word in trimmed.split_whitespace() {
                if !word.contains('*') {
                    continue;
                }
                let literal: String = word.chars().filter(|&c| c != '*').collect();
                if count_arabic_letters(&literal) < 2 {
                    return Err(WildcardValidationError { message: WILDCARD_ERR_LETTERS.to_string() });
                }
            }
        }
        WildcardGrammar::Legacy => {
            if trimmed.matches('*').count() > 1 {
                return Err(WildcardValidationError { message: WILDCARD_ERR_ONE.to_string() });
            }
            for word in trimmed.split_whitespace() {
                if word.starts_with('*') {
                    return Err(WildcardValidationError { message: WILDCARD_ERR_START.to_string() });
                }
            }
        }
    }
    Ok(())
}

/// Parse a wildcard query into per-word glob patterns.
pub fn parse_wildcard_query(query: &str) -> WildcardQueryInfo {
    let words: Vec<String> = query.trim().split_whitespace().map(|s| s.to_string()).collect();
    let patterns: Vec<GlobPattern> = words.iter().map(|w| GlobPattern::parse(w)).collect();
    let mut result = WildcardQueryInfo {
        has_wildcard: false,
        terms: words.clone(),
        patterns,
        wildcard_term_index: 0,
        wildcard_type: WildcardType::None,
        prefix: String::new(),
        suffix: None,
        segments: Vec::new(),
        anchored_start: true,
        anchored_end: true,
    };
    if let Some((i, word)) = words.iter().enumerate().find(|(_, w)| w.contains('*')) {
        result.has_wildcard = true;
        result.wildcard_term_index = i;
        let first = word.find('*').unwrap();
        let last = word.rfind('*').unwrap();
        result.prefix = word[..first].to_string();
        if last < word.len() - 1 {
            result.wildcard_type = WildcardType::Internal;
            result.suffix = Some(word[last + 1..].to_string());
        } else {
            result.wildcard_type = WildcardType::Prefix;
        }
        let g = &result.patterns[i];
        result.segments = g.segments.clone();
        result.anchored_start = g.anchored_start;
        result.anchored_end = g.anchored_end;
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchTerm {
    pub query: String,
    pub mode: SearchMode,
}

/// Filters. `book_ids` is a term filter on `text_id`; the other fields are
/// range queries on the FAST-only numeric columns (`author_id`, `genre_id`,
/// `century_ah`, `death_ah`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    pub author_id: Option<u64>,
    pub genre_id: Option<u64>,
    pub death_ah_min: Option<u64>,
    pub death_ah_max: Option<u64>,
    pub century_ah: Option<u64>,
    pub book_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: u64,
    pub part_index: u64,
    pub page_id: u64,
    pub author_id: Option<u64>,
    pub genre_id: Option<u64>,
    pub death_ah: Option<u64>,
    pub century_ah: Option<u64>,
    pub part_label: String,
    pub page_number: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body: String,
    pub score: f32,
    pub matched_token_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub query: String,
    pub mode: SearchMode,
    pub total_hits: usize,
    pub results: Vec<SearchResult>,
    pub elapsed_ms: u64,
    /// Set when `total_hits` is a lower bound: the walk stopped at the hit
    /// cap or its budget, or is still running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was_capped: Option<bool>,
    /// Cache key of the walk behind this result (proximity, wide phrases,
    /// verified boolean/name/wildcard); poll `walk_status` with it while
    /// `complete` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk_key: Option<String>,
    /// For walk-backed results: whether the walk had finished when this
    /// window was served (false → `total_hits` will still grow).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageWithMatches {
    pub id: u64,
    pub part_label: String,
    pub page_number: String,
    pub body: String,
    pub matched_token_indices: Vec<u32>,
}

/// Per-host tuning. The desktop and the API server differ only here.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Highlight positions attached to each row of a search result page.
    pub result_highlight_cap: usize,
    /// Highlight positions returned for a single page (reader view).
    pub page_highlight_cap: usize,
    /// Optional cap on the union of positions in combined-search rows.
    pub combined_result_cap: Option<usize>,
    /// Verify at open that a single-segment index really is in reading order
    /// before enabling `ReadingOrderCollector` pagination.
    pub verify_reading_order: bool,
    /// Testing aid: never use `ReadingOrderCollector`.
    pub force_fallback_ordering: bool,
    /// Compound index: route single-word root queries to `root_text` when the
    /// index carries it (the "root hedge"), instead of a triple set.
    pub prefer_root_text: bool,
    /// Which compound proximity implementation to use for single-word sides.
    pub proximity_impl: ProximityImpl,
    /// Kept for the bench flag; walks use `walk_budget_ms` instead.
    pub proximity_budget_ms: u64,
    /// Compound phrases: a slot that expands to more triple ids than this
    /// (a wide wildcard such as `ال*`) is matched with a bitset DocSet and
    /// forward-index adjacency verification instead of positional cursors
    /// (`WILDCARD_EXPANSION_THRESHOLD`). Single-word queries are never affected.
    pub wildcard_expansion_threshold: usize,
    /// Verified hits after which a walk (proximity, wide-slot phrase,
    /// forward-verified boolean/name/wildcard) stops (`MAX_VERIFIED_HITS`).
    pub max_verified_hits: usize,
    /// Safety budget of a walk whose candidates yield few hits (`WALK_BUDGET_MS`).
    pub walk_budget_ms: u64,
    /// Exact counts: walks have no hit cap and no budget and wait for
    /// completion. Desktop setting; always false on the API server.
    pub exact_counts: bool,
    /// Detached walks allowed to run at once (`default_max_concurrent_walks`).
    pub max_concurrent_walks: usize,
    /// Prefix cache bounds: entries and approximate bytes, whichever first.
    pub prefix_cache_entries: usize,
    pub prefix_cache_bytes: usize,
}

/// Compound-index proximity implementations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProximityImpl {
    /// Tier 1 (default): stream candidates, verify on the forward index,
    /// stop at the window or the candidate cap.
    Forward,
    /// Tier 2: positional intersection on Tantivy postings; exact, no SQLite;
    /// falls back to `Forward` when either side is a phrase.
    Positional,
}

/// Kept for callers of the 0.5.0 API: the verified-hit cap of a walk
/// (`EngineConfig::max_verified_hits`).
pub const PROXIMITY_MAX_VERIFY: usize = MAX_VERIFIED_HITS;

/// Default for `EngineConfig::wildcard_expansion_threshold`. A positional
/// union cursor holds one `SegmentPostings` (block buffers plus a position
/// reader, on the order of a kilobyte) per triple id; above this many ids a
/// phrase slot is a single bitset built by `TermSetQuery` in one pass over
/// the postings and adjacency is verified on the forward index.
pub const WILDCARD_EXPANSION_THRESHOLD: usize = 5_000;

/// Served walk windows memoized per engine.
const WALK_PAGE_MEMO_ENTRIES: usize = 128;
/// Glob expansions memoized per engine.
const GLOB_CACHE_ENTRIES: usize = 64;

/// Outcome of a walk-backed (or exact) compound phrase / wildcard search.
struct Walked {
    total: usize,
    results: Vec<SearchResult>,
    was_capped: bool,
    walk_key: Option<String>,
    complete: bool,
}

/// What the frontend needs to know about the engine it talks to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineCapabilities {
    pub index_kind: IndexKind,
    pub wildcard_grammar: WildcardGrammar,
    pub exact_counts: bool,
    pub max_verified_hits: usize,
    pub walk_budget_ms: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            result_highlight_cap: 5,
            page_highlight_cap: 100,
            combined_result_cap: None,
            verify_reading_order: true,
            force_fallback_ordering: false,
            prefer_root_text: true,
            proximity_impl: ProximityImpl::Positional,
            proximity_budget_ms: 1_500,
            wildcard_expansion_threshold: WILDCARD_EXPANSION_THRESHOLD,
            max_verified_hits: MAX_VERIFIED_HITS,
            walk_budget_ms: WALK_BUDGET_MS,
            exact_counts: false,
            max_concurrent_walks: default_max_concurrent_walks(),
            prefix_cache_entries: PREFIX_CACHE_ENTRIES,
            prefix_cache_bytes: PREFIX_CACHE_BYTES,
        }
    }
}

impl EngineConfig {
    /// The API server historically returned more highlight positions per row.
    pub fn api_server() -> Self {
        Self {
            result_highlight_cap: 20,
            page_highlight_cap: 100,
            combined_result_cap: Some(50),
            ..Self::default()
        }
    }
}

/// Three-field index only: Tantivy's expansion cap for the wildcard
/// `RegexPhraseQuery`. The compound index has no expansion limit; wide slots
/// go through the bitset path instead (`WILDCARD_SLOT_THRESHOLD`).
pub const WILDCARD_MAX_EXPANSIONS: u32 = 200_000;
/// Upper bound on triple alternations per phrase slot in compound mode.
pub const PHRASE_MAX_EXPANSIONS: u32 = 200_000;
/// Compound proximity candidates fetched per chunk from the token cache.
const FORWARD_BATCH: usize = 2_000;

/// Where the time went in one compound-mode proximity query. Returned by
/// [`SearchEngine::proximity_search_with_stats`] and printed by the bench;
/// also written to stderr when `KASHSHAF_PROX_DEBUG` is set.
#[derive(Debug, Default, Clone, Serialize)]
pub struct ProximityStats {
    /// Window served from a cached walk started by an earlier request.
    pub from_cache: bool,
    /// Duration of the whole walk (0 while it is still running).
    pub walk_ms: u64,
    /// Cache key of the walk (compound paths).
    pub walk_key: Option<String>,
    /// The walk had finished when the window was served (true for non-walk paths).
    pub complete: bool,
    pub path: &'static str,
    /// Candidate pages matching the boolean (bag-of-words) query.
    pub candidates_total: usize,
    /// Candidates actually fetched and verified.
    pub candidates_scanned: usize,
    pub verified_hits: usize,
    pub set1_size: usize,
    pub set2_size: usize,
    /// Tantivy query + collector.
    pub tantivy_us: u64,
    /// Fast-field key extraction.
    pub keys_us: u64,
    pub cache_hits: usize,
    pub open_us: u64,
    pub fetch_us: u64,
    pub decode_us: u64,
    pub blob_bytes: u64,
    /// def→triple mapping + membership scan + distance check.
    pub scan_us: u64,
    /// Stored-document fetch for the returned window.
    pub doc_fetch_us: u64,
    pub total_us: u64,
}

impl ProximityStats {
    pub fn per_candidate_us(&self) -> f64 {
        if self.candidates_scanned == 0 {
            0.0
        } else {
            (self.fetch_us + self.decode_us + self.scan_us + self.open_us) as f64 / self.candidates_scanned as f64
        }
    }
}

fn prox_debug() -> bool {
    std::env::var_os("KASHSHAF_PROX_DEBUG").is_some()
}

/// Which text fields the index carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexKind {
    ThreeField,
    Compound,
}

/// Resolved schema fields.
#[derive(Debug, Clone, Copy)]
struct Fields {
    text_id: Field,
    part_index: Field,
    page_id: Field,
    author_id: Field,
    genre_id: Field,
    death_ah: Field,
    century_ah: Field,
    part_label: Field,
    page_number: Field,
    body: Field,
    surface: Option<Field>,
    lemma: Option<Field>,
    root: Option<Field>,
    tokens: Option<Field>,
}

impl Fields {
    fn resolve(schema: &Schema) -> Result<(Self, IndexKind)> {
        let f = |name: &str| -> Result<Field> {
            schema
                .get_field(name)
                .with_context(|| format!("index schema is missing field `{}`", name))
        };
        let opt = |name: &str| schema.get_field(name).ok();
        let fields = Self {
            text_id: f("text_id")?,
            part_index: f("part_index")?,
            page_id: f("page_id")?,
            author_id: f("author_id")?,
            genre_id: f("genre_id")?,
            death_ah: f("death_ah")?,
            century_ah: f("century_ah")?,
            part_label: f("part_label")?,
            page_number: f("page_number")?,
            body: f("body")?,
            surface: opt("surface_text"),
            lemma: opt("lemma_text"),
            root: opt("root_text"),
            tokens: opt("tokens"),
        };
        let kind = if fields.tokens.is_some() {
            IndexKind::Compound
        } else if fields.surface.is_some() && fields.lemma.is_some() && fields.root.is_some() {
            IndexKind::ThreeField
        } else {
            anyhow::bail!("index has neither a `tokens` field nor surface/lemma/root text fields");
        };
        Ok((fields, kind))
    }
}

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    kind: IndexKind,
    config: EngineConfig,
    /// Cached verified prefixes of proximity / phrase / wildcard walks.
    walks: WalkCache,
    /// Result rows of walk windows already served (doc-store reads are the
    /// remaining cost of a cached page).
    walk_pages: std::sync::Mutex<lru::LruCache<String, Arc<Vec<SearchResult>>>>,
    /// Glob expansions (`ال*` is 355k ids and ~80 ms to scan; every page of
    /// a phrase needs it).
    glob_cache: std::sync::Mutex<lru::LruCache<String, Arc<Vec<u32>>>>,
    /// Runtime override of `config.exact_counts` (desktop toggle).
    exact_counts: AtomicBool,
    /// Single segment whose doc ids are monotonic in reading order.
    reading_order: bool,
    triples: Option<Arc<TripleMaps>>,
    cache: Option<Arc<TokenCache>>,
}

/// Reading-order key: (death_ah or MAX, text_id, part_index, page_id).
type OrderKey = (u64, u64, u64, u64);

/// Opened fast-field columns of one segment.
struct SegmentColumns {
    death: Option<tantivy::columnar::Column<u64>>,
    text: Option<tantivy::columnar::Column<u64>>,
    part: Option<tantivy::columnar::Column<u64>>,
    page: Option<tantivy::columnar::Column<u64>>,
}

impl SegmentColumns {
    #[inline]
    fn get(col: &Option<tantivy::columnar::Column<u64>>, doc: DocId, default: u64) -> u64 {
        col.as_ref().and_then(|c| c.first(doc)).unwrap_or(default)
    }
    fn order_key(&self, doc: DocId) -> OrderKey {
        (
            Self::get(&self.death, doc, u64::MAX),
            Self::get(&self.text, doc, 0),
            Self::get(&self.part, doc, 0),
            Self::get(&self.page, doc, 0),
        )
    }
    fn page_key(&self, doc: DocId) -> PageKey {
        PageKey::new(Self::get(&self.text, doc, 0), Self::get(&self.part, doc, 0), Self::get(&self.page, doc, 0))
    }
}

fn sort_results_by_reading_order(results: &mut [SearchResult]) {
    results.sort_by_key(|r| (r.death_ah.unwrap_or(u64::MAX), r.id, r.part_index, r.page_id));
}

fn u64_of(doc: &TantivyDocument, f: Field) -> Option<u64> {
    doc.get_first(f).and_then(|v| v.as_u64())
}

fn str_of(doc: &TantivyDocument, f: Field) -> String {
    doc.get_first(f).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn regex_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '.' | '+' | '*' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => format!("\\{}", c),
            _ => c.to_string(),
        })
        .collect()
}

fn map_expansion_error(e: anyhow::Error, what: &str) -> anyhow::Error {
    let msg = e.to_string();
    if msg.contains("expansions") || msg.contains("too many") {
        anyhow!(
            "`{}` matches too many distinct words. Add more letters and try again.",
            what
        )
    } else {
        e
    }
}

/// A query word resolved to the sets of ids that satisfy it, one per position.
/// `Sets` is empty for an empty query; a position with an empty set matches nothing.
type Sets = Vec<Vec<u32>>;

/// The FST regex compiler caps an automaton at 1000 states. An alternation of
/// zero-padded ids compiles to (roughly) its prefix trie, so a slot is routed
/// through `RegexPhraseQuery` only while the summed trie size of all slots
/// stays under this budget; otherwise the phrase becomes a `TermSetQuery` per
/// slot (bag of words) plus forward-index adjacency verification.
const REGEX_STATE_BUDGET: usize = 900;

/// Number of nodes in the prefix trie of the zero-padded id strings — an
/// upper bound on the DFA states the alternation needs.
fn trie_nodes(ids: &[u32]) -> usize {
    let mut strings: Vec<String> = ids.iter().map(|&t| triple_term(t)).collect();
    strings.sort_unstable();
    let mut nodes = 0usize;
    let mut prev: &str = "";
    for s in &strings {
        let common = prev.bytes().zip(s.bytes()).take_while(|(a, b)| a == b).count();
        nodes += s.len() - common;
        prev = s;
    }
    nodes
}

/// How a resolved term is matched.
struct Plan {
    query: Box<dyn Query>,
    /// Some(sets) when the index query is only a superset (bag of words) and
    /// the page must be verified against the forward index.
    verify: Option<Vec<HashSet<u32>>>,
}

fn any_needs_verify(plans: &[Plan]) -> bool {
    plans.iter().any(|p| p.verify.is_some())
}

impl SearchEngine {
    pub fn open(index_path: &Path) -> Result<Self> {
        Self::open_with_corpus(index_path, None, EngineConfig::default())
    }

    pub fn open_with_config(index_path: &Path, config: EngineConfig) -> Result<Self> {
        Self::open_with_corpus(index_path, None, config)
    }

    /// Open the index; for a compound index `corpus_db` is required to load
    /// the triple maps. Attach a `TokenCache` afterwards with
    /// [`Self::set_token_cache`] for forward-index highlighting.
    pub fn open_with_corpus(index_path: &Path, corpus_db: Option<&Path>, config: EngineConfig) -> Result<Self> {
        let index = Index::open_in_dir(index_path)
            .with_context(|| format!("opening tantivy index at {:?}", index_path))?;
        index
            .tokenizers()
            .register("whitespace", tantivy::tokenizer::WhitespaceTokenizer::default());
        let schema = index.schema();
        let (fields, kind) = Fields::resolve(&schema)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .context("building index reader")?;

        let searcher = reader.searcher();
        let single_segment = searcher.segment_readers().len() == 1;
        let reading_order = if config.force_fallback_ordering {
            eprintln!("[index] reading-order pagination disabled by config (fallback ordering)");
            false
        } else if !single_segment {
            eprintln!(
                "[index] {} segments: reading-order pagination disabled (death_ah ordering fallback)",
                searcher.segment_readers().len()
            );
            false
        } else if config.verify_reading_order {
            let t0 = std::time::Instant::now();
            let ok = verify_reading_order(&searcher)?;
            eprintln!(
                "[index] single segment, reading order {} ({} docs checked in {} ms)",
                if ok { "verified" } else { "NOT monotonic — fallback ordering" },
                searcher.num_docs(),
                t0.elapsed().as_millis()
            );
            ok
        } else {
            true
        };

        let triples = match (kind, corpus_db) {
            (IndexKind::Compound, Some(db)) => {
                let t = TripleMaps::load(db)?
                    .ok_or_else(|| anyhow!("compound index needs a corpus.db with a `triples` table (schema 4)"))?;
                eprintln!("[triples] ~{} MB resident", t.approx_bytes() / 1_000_000);
                Some(Arc::new(t))
            }
            (IndexKind::Compound, None) => {
                anyhow::bail!("compound index requires corpus.db (use SearchEngine::open_with_corpus)")
            }
            (IndexKind::ThreeField, _) => None,
        };
        eprintln!(
            "[index] kind = {:?}{}",
            kind,
            if fields.root.is_some() && kind == IndexKind::Compound { " (+ root_text hedge)" } else { "" }
        );

        Ok(Self {
            index,
            reader,
            fields,
            kind,
            walks: WalkCache::with_limits(config.prefix_cache_entries, config.prefix_cache_bytes, config.max_concurrent_walks),
            walk_pages: std::sync::Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(WALK_PAGE_MEMO_ENTRIES).unwrap())),
            glob_cache: std::sync::Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(GLOB_CACHE_ENTRIES).unwrap())),
            exact_counts: AtomicBool::new(config.exact_counts),
            config,
            reading_order,
            triples,
            cache: None,
        })
    }

    /// Exact counts on/off at runtime (desktop toggle). Cached walks are
    /// keyed on the flag, so both variants can coexist.
    pub fn set_exact_counts(&self, on: bool) {
        self.exact_counts.store(on, Ordering::SeqCst);
    }

    pub fn exact_counts(&self) -> bool {
        self.exact_counts.load(Ordering::SeqCst)
    }

    pub fn wildcard_grammar(&self) -> WildcardGrammar {
        match self.kind {
            IndexKind::Compound => WildcardGrammar::Glob,
            IndexKind::ThreeField => WildcardGrammar::Legacy,
        }
    }

    pub fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            index_kind: self.kind,
            wildcard_grammar: self.wildcard_grammar(),
            exact_counts: self.exact_counts(),
            max_verified_hits: self.config.max_verified_hits,
            walk_budget_ms: self.config.walk_budget_ms,
        }
    }

    /// Block until every cached walk has finished (benchmarks, tests).
    pub fn wait_walks(&self) {
        self.walks.wait_all();
    }

    /// Progress of a cached walk by its `SearchResults::walk_key`.
    pub fn walk_status(&self, key: &str) -> Option<WalkStatus> {
        self.walks.status(key)
    }

    /// Walk threads, queue and prefix-cache size.
    pub fn walk_stats(&self) -> WalkStats {
        self.walks.stats()
    }

    pub fn clear_walk_cache(&self) {
        self.walks.clear();
        self.walk_pages.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    /// Served window of a walk, memoized once the walk has produced it in
    /// full (the prefix is append-only, so a full window never changes).
    fn walk_window_results(&self, searcher: &Searcher, key: &str, offset: usize, limit: usize, w: &WalkWindow) -> Result<Vec<SearchResult>> {
        let memo_key = format!("{}|{}|{}", key, offset, limit);
        if let Some(rows) = self.walk_pages.lock().unwrap_or_else(|p| p.into_inner()).get(&memo_key).cloned() {
            return Ok((*rows).clone());
        }
        let rows = self.walk_results(searcher, w)?;
        if w.done || w.hits.len() == limit {
            self.walk_pages.lock().unwrap_or_else(|p| p.into_inner()).put(memo_key, Arc::new(rows.clone()));
        }
        Ok(rows)
    }

    /// Glob expansion through the per-engine cache.
    fn triples_for_glob_cached(&self, g: &GlobPattern) -> Arc<Vec<u32>> {
        if !g.is_wildcard() {
            return Arc::new(self.triples().triples_for_surface(&g.raw));
        }
        if let Some(v) = self.glob_cache.lock().unwrap_or_else(|p| p.into_inner()).get(&g.raw).cloned() {
            return v;
        }
        let v = Arc::new(self.triples().triples_for_glob(g));
        self.glob_cache.lock().unwrap_or_else(|p| p.into_inner()).put(g.raw.clone(), v.clone());
        v
    }

    fn walk_limits(&self) -> WalkLimits {
        if self.exact_counts() {
            WalkLimits::exact()
        } else {
            WalkLimits::capped(self.config.max_verified_hits, self.config.walk_budget_ms)
        }
    }

    /// Cache key of a walk: the query, its filters and the exact flag.
    fn walk_key<T: Serialize>(&self, kind: &str, parts: &T, filters: &SearchFilters) -> String {
        let mut f = filters.clone();
        if let Some(ids) = f.book_ids.as_mut() {
            ids.sort_unstable();
            ids.dedup();
        }
        format!(
            "{}|exact={}|{}|{}",
            kind,
            self.exact_counts(),
            serde_json::to_string(parts).unwrap_or_default(),
            serde_json::to_string(&f).unwrap_or_default()
        )
    }

    /// Search results for one window of a walk.
    fn walk_results(&self, searcher: &Searcher, w: &WalkWindow) -> Result<Vec<SearchResult>> {
        let addrs: Vec<DocAddress> = w.hits.iter().map(|h| h.addr).collect();
        let mut results = self.results_from(searcher, &addrs)?;
        for (r, h) in results.iter_mut().zip(w.hits.iter()) {
            r.matched_token_indices = h.positions.clone();
        }
        if !self.reading_order {
            sort_results_by_reading_order(&mut results);
        }
        Ok(results)
    }

    /// Walk that streams the query's `DocSet` in reading order and verifies
    /// every page on the forward index. `verify` returns the highlight
    /// positions of a qualifying page, `None` otherwise.
    fn verified_walker(
        &self,
        searcher: &Searcher,
        query: Box<dyn Query>,
        verify: Arc<dyn Fn(&[u32]) -> Option<Vec<u32>> + Send + Sync>,
    ) -> Result<Walker> {
        let Some(cache) = self.cache.clone() else {
            anyhow::bail!("forward-index verification requires an attached TokenCache");
        };
        let triples = self.triples.clone().expect("compound index has triple maps");
        let searcher = searcher.clone();
        let reading_order = self.reading_order;
        Ok(Box::new(move |sink: &mut Sink| -> Result<()> {
            let process_chunk = |chunk: &[DocAddress], sink: &mut Sink| -> Result<bool> {
                let keys = page_keys(&searcher, chunk);
                let pages = page_triples_with(&cache, &triples, &keys)?;
                sink.add_candidates(chunk.len());
                for (addr, key) in chunk.iter().zip(keys.iter()) {
                    let Some(ids) = pages.get(key) else { continue };
                    if let Some(positions) = verify(ids) {
                        if !sink.push(WalkHit { addr: *addr, positions }) {
                            return Ok(false);
                        }
                    }
                }
                Ok(sink.tick())
            };
            if reading_order {
                let weight = query.weight(EnableScoring::disabled_from_searcher(&searcher))?;
                for (seg_ord, seg) in searcher.segment_readers().iter().enumerate() {
                    let mut scorer = weight.scorer(seg, 1.0)?;
                    let alive = seg.alive_bitset();
                    let mut chunk: Vec<DocAddress> = Vec::with_capacity(FORWARD_BATCH);
                    loop {
                        let mut doc = scorer.doc();
                        while doc != TERMINATED && chunk.len() < FORWARD_BATCH {
                            if alive.map_or(true, |b| b.is_alive(doc)) {
                                chunk.push(DocAddress::new(seg_ord as u32, doc));
                            }
                            doc = scorer.advance();
                        }
                        if chunk.is_empty() {
                            break;
                        }
                        if !process_chunk(&chunk, sink)? {
                            return Ok(());
                        }
                        chunk.clear();
                        if doc == TERMINATED {
                            break;
                        }
                    }
                }
            } else {
                let (_, candidates) = candidates_sorted(&searcher, &*query)?;
                for chunk in candidates.chunks(FORWARD_BATCH) {
                    if !process_chunk(chunk, sink)? {
                        return Ok(());
                    }
                }
            }
            Ok(())
        }))
    }

    /// Cached, capped forward-verified window of `query`.
    fn verified_window(
        &self,
        searcher: &Searcher,
        key: String,
        query: Box<dyn Query>,
        limit: usize,
        offset: usize,
        verify: Arc<dyn Fn(&[u32]) -> Option<Vec<u32>> + Send + Sync>,
    ) -> Result<WalkWindow> {
        self.walks
            .window(key, offset, limit, self.walk_limits(), || self.verified_walker(searcher, query, verify))
    }

    /// Attach the token cache used for forward-index highlighting and
    /// compound-mode proximity/wildcard verification.
    pub fn set_token_cache(&mut self, cache: Arc<TokenCache>) {
        self.cache = Some(cache);
    }

    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    /// The compound index's triple maps, and where they were loaded from
    /// (`None` on a three-field index).
    pub fn triple_maps(&self) -> Option<&TripleMaps> {
        self.triples.as_deref()
    }

    /// The attached token cache, if [`Self::set_token_cache`] was called.
    pub fn token_cache(&self) -> Option<&TokenCache> {
        self.cache.as_deref()
    }

    pub fn kind(&self) -> IndexKind {
        self.kind
    }

    pub fn has_root_hedge(&self) -> bool {
        self.kind == IndexKind::Compound && self.fields.root.is_some()
    }

    /// True when pagination runs through `ReadingOrderCollector`.
    pub fn reading_order(&self) -> bool {
        self.reading_order
    }

    pub fn segment_count(&self) -> usize {
        self.reader.searcher().segment_readers().len()
    }

    pub fn doc_count(&self) -> Result<u64> {
        Ok(self.reader.searcher().num_docs())
    }

    // ------------------------------------------------------------------
    // Normalization helpers
    // ------------------------------------------------------------------

    fn normalize_for(mode: SearchMode, query: &str) -> String {
        match mode {
            SearchMode::Root => normalize_root_query(query),
            SearchMode::Surface => normalize_arabic(query),
            SearchMode::Lemma => query.to_string(),
        }
    }

    fn words_of(normalized: &str) -> Vec<String> {
        normalized.split_whitespace().map(|s| s.to_string()).collect()
    }

    fn term_words(&self, term: &SearchTerm) -> Vec<String> {
        Self::words_of(&Self::normalize_for(term.mode, &term.query))
    }

    // ------------------------------------------------------------------
    // Three-field query building
    // ------------------------------------------------------------------

    fn field_for(&self, mode: SearchMode) -> Field {
        match mode {
            SearchMode::Surface => self.fields.surface,
            SearchMode::Lemma => self.fields.lemma,
            SearchMode::Root => self.fields.root,
        }
        .expect("three-field index has all text fields")
    }

    /// Phrase for 2+ words, term for 1, query-parser fallback for none.
    fn text_query(&self, field: Field, words: &[String], raw: &str) -> Result<Box<dyn Query>> {
        match words.len() {
            0 => {
                let qp = QueryParser::for_index(&self.index, vec![field]);
                Ok(qp.parse_query(raw)?)
            }
            1 => Ok(Box::new(TermQuery::new(
                Term::from_field_text(field, &words[0]),
                IndexRecordOption::Basic,
            ))),
            _ => Ok(Box::new(PhraseQuery::new(
                words.iter().map(|w| Term::from_field_text(field, w)).collect(),
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Compound query building
    // ------------------------------------------------------------------

    fn triples(&self) -> &TripleMaps {
        self.triples.as_ref().expect("compound index has triple maps")
    }

    /// Resolve each word of a term to its triple-id set.
    fn term_sets(&self, term: &SearchTerm) -> Sets {
        let t = self.triples();
        self.term_words(term)
            .iter()
            .map(|w| match term.mode {
                SearchMode::Surface => t.triples_for_surface(w),
                SearchMode::Lemma => t.triples_for_lemma(w),
                SearchMode::Root => t.triples_for_root(w),
            })
            .collect()
    }

    fn set_query(&self, set: &[u32]) -> Box<dyn Query> {
        let tokens = self.fields.tokens.expect("compound index");
        if set.is_empty() {
            return Box::new(EmptyQuery);
        }
        Box::new(TermSetQuery::new(set.iter().map(|&t| Term::from_field_text(tokens, &triple_term(t)))))
    }

    /// Plan for a resolved compound term: `TermSetQuery` for one position;
    /// for phrases a `RegexPhraseQuery` (alternation per position) when every
    /// slot is small, otherwise a bag-of-words `BooleanQuery` that must be
    /// verified on the forward index.
    fn compound_plan(&self, sets: &[Vec<u32>]) -> Result<Plan> {
        let tokens = self.fields.tokens.expect("compound index");
        match sets.len() {
            0 => Ok(Plan { query: Box::new(EmptyQuery), verify: None }),
            1 => Ok(Plan { query: self.set_query(&sets[0]), verify: None }),
            _ => {
                if sets.iter().any(|s| s.is_empty()) {
                    return Ok(Plan { query: Box::new(EmptyQuery), verify: None });
                }
                let states: usize = sets.iter().map(|s| trie_nodes(s)).sum();
                if states <= REGEX_STATE_BUDGET {
                    let patterns: Vec<String> = sets
                        .iter()
                        .map(|s| {
                            let alts: Vec<String> = s.iter().map(|&t| triple_term(t)).collect();
                            format!("({})", alts.join("|"))
                        })
                        .collect();
                    let mut q = RegexPhraseQuery::new(tokens, patterns);
                    q.set_max_expansions(PHRASE_MAX_EXPANSIONS);
                    return Ok(Plan { query: Box::new(q), verify: None });
                }
                let clauses: Vec<(Occur, Box<dyn Query>)> =
                    sets.iter().map(|s| (Occur::Must, self.set_query(s))).collect();
                Ok(Plan {
                    query: Box::new(BooleanQuery::new(clauses)),
                    verify: Some(Self::hash_sets(sets)),
                })
            }
        }
    }

    /// Any-mode term → plan, choosing the path for the index kind.
    /// In compound mode with the root hedge, single-word root queries use
    /// `root_text` (no positions) instead of a triple set.
    fn build_term_plan(&self, term: &SearchTerm) -> Result<Plan> {
        match self.kind {
            IndexKind::ThreeField => {
                let words = self.term_words(term);
                Ok(Plan {
                    query: self.text_query(self.field_for(term.mode), &words, &Self::normalize_for(term.mode, &term.query))?,
                    verify: None,
                })
            }
            IndexKind::Compound => {
                if term.mode == SearchMode::Root && self.config.prefer_root_text {
                    if let Some(root_field) = self.fields.root {
                        let words = self.term_words(term);
                        if words.len() == 1 {
                            return Ok(Plan {
                                query: Box::new(TermQuery::new(
                                    Term::from_field_text(root_field, &words[0]),
                                    IndexRecordOption::Basic,
                                )),
                                verify: None,
                            });
                        }
                    }
                }
                self.compound_plan(&self.term_sets(term))
            }
        }
    }

    fn build_term_query(&self, term: &SearchTerm) -> Result<Box<dyn Query>> {
        Ok(self.build_term_plan(term)?.query)
    }

    // ------------------------------------------------------------------
    // Filters
    // ------------------------------------------------------------------

    /// AND the text query with every filter present.
    fn with_filters(&self, text_query: Box<dyn Query>, filters: &SearchFilters) -> Box<dyn Query> {
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, text_query)];
        let f = self.fields;

        if let Some(ids) = &filters.book_ids {
            if !ids.is_empty() {
                let should: Vec<(Occur, Box<dyn Query>)> = ids
                    .iter()
                    .map(|&id| {
                        let q: Box<dyn Query> =
                            Box::new(TermQuery::new(Term::from_field_u64(f.text_id, id), IndexRecordOption::Basic));
                        (Occur::Should, q)
                    })
                    .collect();
                clauses.push((Occur::Must, Box::new(BooleanQuery::new(should))));
            }
        }
        let eq = |field: Field, v: u64| -> Box<dyn Query> {
            Box::new(RangeQuery::new(
                Bound::Included(Term::from_field_u64(field, v)),
                Bound::Included(Term::from_field_u64(field, v)),
            ))
        };
        if let Some(a) = filters.author_id {
            clauses.push((Occur::Must, eq(f.author_id, a)));
        }
        if let Some(g) = filters.genre_id {
            clauses.push((Occur::Must, eq(f.genre_id, g)));
        }
        if let Some(c) = filters.century_ah {
            clauses.push((Occur::Must, eq(f.century_ah, c)));
        }
        if filters.death_ah_min.is_some() || filters.death_ah_max.is_some() {
            let lo = filters
                .death_ah_min
                .map(|v| Bound::Included(Term::from_field_u64(f.death_ah, v)))
                .unwrap_or(Bound::Unbounded);
            let hi = filters
                .death_ah_max
                .map(|v| Bound::Included(Term::from_field_u64(f.death_ah, v)))
                .unwrap_or(Bound::Unbounded);
            clauses.push((Occur::Must, Box::new(RangeQuery::new(lo, hi))));
        }

        if clauses.len() == 1 {
            clauses.pop().unwrap().1
        } else {
            Box::new(BooleanQuery::new(clauses))
        }
    }

    fn page_query(&self, id: u64, part_index: u64, page_id: u64) -> BooleanQuery {
        let f = self.fields;
        BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(f.text_id, id), IndexRecordOption::Basic)),
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(f.part_index, part_index), IndexRecordOption::Basic)),
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(f.page_id, page_id), IndexRecordOption::Basic)),
            ),
        ])
    }

    fn find_page(&self, searcher: &Searcher, id: u64, part_index: u64, page_id: u64) -> Result<Option<DocAddress>> {
        let top = searcher.search(&self.page_query(id, part_index, page_id), &TopDocs::with_limit(1))?;
        Ok(top.into_iter().next().map(|(_, a)| a))
    }

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------

    /// `(total_hits, addresses)` for the requested window in reading order.
    fn paged(&self, searcher: &Searcher, query: &dyn Query, limit: usize, offset: usize) -> Result<(usize, Vec<DocAddress>)> {
        if self.reading_order {
            let (total, docs) = searcher.search(query, &ReadingOrderCollector { offset, limit })?;
            return Ok((total, docs));
        }
        let (total, top) = searcher.search(
            query,
            &(
                Count,
                TopDocs::with_limit((limit + offset).max(1)).order_by_u64_field("death_ah", tantivy::Order::Asc),
            ),
        )?;
        let addrs: Vec<DocAddress> = top.into_iter().map(|(_, a): (u64, DocAddress)| a).collect();
        let mut keyed: Vec<(OrderKey, DocAddress)> = self.order_keys(searcher, &addrs).into_iter().zip(addrs).collect();
        keyed.sort_by_key(|(k, _)| *k);
        Ok((total, keyed.into_iter().skip(offset).take(limit).map(|(_, a)| a).collect()))
    }

    /// Up to `cap` candidates in reading order, plus the total match count.
    fn candidates(&self, searcher: &Searcher, query: &dyn Query, cap: usize) -> Result<(usize, Vec<DocAddress>)> {
        if self.reading_order {
            let (total, docs) = searcher.search(query, &ReadingOrderCollector { offset: 0, limit: cap })?;
            return Ok((total, docs));
        }
        let (total, top) = searcher.search(
            query,
            &(Count, TopDocs::with_limit(cap.max(1)).order_by_u64_field("death_ah", tantivy::Order::Asc)),
        )?;
        let addrs: Vec<DocAddress> = top.into_iter().map(|(_, a): (u64, DocAddress)| a).collect();
        let mut keyed: Vec<(OrderKey, DocAddress)> = self.order_keys(searcher, &addrs).into_iter().zip(addrs).collect();
        keyed.sort_by_key(|(k, _)| *k);
        Ok((total, keyed.into_iter().map(|(_, a)| a).collect()))
    }

    /// Fast-field columns of one segment, opened once and reused. Opening a
    /// column (`fast_fields().u64(name)`) is not free on a 5.7M-doc segment, so
    /// never do it per document.
    fn columns(&self, searcher: &Searcher, seg_ord: u32) -> SegmentColumns {
        segment_columns(searcher, seg_ord)
    }

    /// Reading-order keys for many addresses (columns opened once per segment).
    fn order_keys(&self, searcher: &Searcher, addrs: &[DocAddress]) -> Vec<OrderKey> {
        let mut cols: HashMap<u32, SegmentColumns> = HashMap::new();
        addrs
            .iter()
            .map(|a| {
                let c = cols.entry(a.segment_ord).or_insert_with(|| self.columns(searcher, a.segment_ord));
                c.order_key(a.doc_id)
            })
            .collect()
    }

    /// Page keys of documents via fast fields (no doc-store read).
    fn keys_of(&self, searcher: &Searcher, addrs: &[DocAddress]) -> Vec<PageKey> {
        page_keys(searcher, addrs)
    }

    fn extract_result(&self, doc: &TantivyDocument, score: f32, matched: Vec<u32>) -> SearchResult {
        let f = self.fields;
        SearchResult {
            id: u64_of(doc, f.text_id).unwrap_or(0),
            part_index: u64_of(doc, f.part_index).unwrap_or(0),
            page_id: u64_of(doc, f.page_id).unwrap_or(0),
            author_id: u64_of(doc, f.author_id),
            genre_id: u64_of(doc, f.genre_id),
            death_ah: u64_of(doc, f.death_ah),
            century_ah: u64_of(doc, f.century_ah),
            part_label: str_of(doc, f.part_label),
            page_number: str_of(doc, f.page_number),
            body: str_of(doc, f.body),
            score,
            matched_token_indices: matched,
        }
    }

    fn results_from(&self, searcher: &Searcher, addrs: &[DocAddress]) -> Result<Vec<SearchResult>> {
        let mut out = Vec::with_capacity(addrs.len());
        for addr in addrs {
            let doc: TantivyDocument = searcher.doc(*addr)?;
            out.push(self.extract_result(&doc, 0.0, Vec::new()));
        }
        Ok(out)
    }

    // ------------------------------------------------------------------
    // Forward-index highlighting (compound mode)
    // ------------------------------------------------------------------

    /// Decoded token ids of pages, mapped to triple ids.
    fn page_triples(&self, keys: &[PageKey]) -> Result<HashMap<PageKey, Vec<u32>>> {
        let Some(cache) = &self.cache else {
            return Ok(HashMap::new());
        };
        page_triples_with(cache, self.triples(), keys)
    }

    fn hash_sets(sets: &[Vec<u32>]) -> Vec<HashSet<u32>> {
        sets.iter().map(|s| s.iter().copied().collect()).collect()
    }

    /// Union of highlight positions of several resolved terms on each page.
    fn forward_highlights(&self, keys: &[PageKey], terms: &[Sets], cap: usize) -> Result<HashMap<PageKey, Vec<u32>>> {
        let pages = self.page_triples(keys)?;
        let hashed: Vec<Vec<HashSet<u32>>> = terms.iter().map(|s| Self::hash_sets(s)).collect();
        let mut out = HashMap::with_capacity(keys.len());
        for key in keys {
            let Some(ids) = pages.get(key) else {
                out.insert(*key, Vec::new());
                continue;
            };
            let mut positions: Vec<u32> = Vec::new();
            for sets in &hashed {
                match sets.len() {
                    0 => {}
                    1 => positions.extend(forward::member_positions(ids, &sets[0])),
                    _ => positions.extend(forward::phrase_positions(ids, sets)),
                }
            }
            positions.sort_unstable();
            positions.dedup();
            positions.truncate(cap);
            out.insert(*key, positions);
        }
        Ok(out)
    }

    /// Root-hedge terms have no positions in the index; resolve them to
    /// triple sets for highlighting.
    fn highlight_sets(&self, term: &SearchTerm) -> Sets {
        self.term_sets(term)
    }

    fn attach_highlights(&self, results: &mut [SearchResult], map: &HashMap<PageKey, Vec<u32>>) {
        for r in results.iter_mut() {
            if let Some(p) = map.get(&PageKey::new(r.id, r.part_index, r.page_id)) {
                r.matched_token_indices = p.clone();
            }
        }
    }

    // ------------------------------------------------------------------
    // Public search API
    // ------------------------------------------------------------------

    /// Enumerate every matching page hit for a query, unscored and unpaginated.
    pub fn collect_all_hits(&self, query: &str, mode: SearchMode, filters: &SearchFilters) -> Result<(Vec<(u64, u64, u64)>, usize)> {
        let searcher = self.reader.searcher();
        let term = SearchTerm { query: query.to_string(), mode };
        let text_query = self.build_term_query(&term)?;
        let final_query = self.with_filters(text_query, filters);
        let (triples, count_total) = searcher.search(&*final_query, &(AllDocsCollector, Count))?;
        Ok((triples, count_total))
    }

    pub fn search(&self, query: &str, mode: SearchMode, filters: &SearchFilters, limit: usize, offset: usize) -> Result<SearchResults> {
        let start = std::time::Instant::now();
        let term = SearchTerm { query: query.to_string(), mode };
        let mut r = self.combined_search(std::slice::from_ref(&term), &[], filters, limit, offset)?;
        r.query = query.to_string();
        r.mode = mode;
        r.elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(r)
    }

    pub fn get_page_by_label(&self, id: u64, part_label: &str, page_number: &str) -> Result<Option<SearchResult>> {
        let searcher = self.reader.searcher();
        let f = self.fields;
        let query = BooleanQuery::new(vec![
            (Occur::Must, Box::new(TermQuery::new(Term::from_field_u64(f.text_id, id), IndexRecordOption::Basic))),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_text(f.part_label, part_label), IndexRecordOption::Basic)),
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_text(f.page_number, page_number), IndexRecordOption::Basic)),
            ),
        ]);
        let top = searcher.search(&query, &TopDocs::with_limit(1))?;
        match top.into_iter().next() {
            Some((score, addr)) => {
                let doc: TantivyDocument = searcher.doc(addr)?;
                let mut r = self.extract_result(&doc, score, Vec::new());
                r.id = id;
                r.part_label = part_label.to_string();
                r.page_number = page_number.to_string();
                Ok(Some(r))
            }
            None => Ok(None),
        }
    }

    pub fn get_page(&self, id: u64, part_index: u64, page_id: u64) -> Result<Option<SearchResult>> {
        let searcher = self.reader.searcher();
        let top = searcher.search(&self.page_query(id, part_index, page_id), &TopDocs::with_limit(1))?;
        match top.into_iter().next() {
            Some((score, addr)) => {
                let doc: TantivyDocument = searcher.doc(addr)?;
                let mut r = self.extract_result(&doc, score, Vec::new());
                r.id = id;
                r.part_index = part_index;
                r.page_id = page_id;
                Ok(Some(r))
            }
            None => Ok(None),
        }
    }

    pub fn get_match_positions(&self, id: u64, part_index: u64, page_id: u64, query: &str, mode: SearchMode) -> Result<Vec<u32>> {
        let term = SearchTerm { query: query.to_string(), mode };
        let cap = self.config.page_highlight_cap;
        match self.kind {
            IndexKind::Compound => {
                let key = PageKey::new(id, part_index, page_id);
                let mut m = self.forward_highlights(&[key], &[self.highlight_sets(&term)], cap)?;
                Ok(m.remove(&key).unwrap_or_default())
            }
            IndexKind::ThreeField => {
                let searcher = self.reader.searcher();
                let words = self.term_words(&term);
                if words.is_empty() {
                    return Ok(Vec::new());
                }
                let Some(addr) = self.find_page(&searcher, id, part_index, page_id)? else {
                    return Ok(Vec::new());
                };
                let seg = searcher.segment_reader(addr.segment_ord);
                Ok(self.postings_positions(seg, addr.doc_id, self.field_for(mode), &words, cap))
            }
        }
    }

    pub fn get_page_with_matches(&self, id: u64, part_index: u64, page_id: u64, query: &str, mode: SearchMode) -> Result<Option<PageWithMatches>> {
        let Some(page) = self.get_page(id, part_index, page_id)? else {
            return Ok(None);
        };
        let matched = if query.is_empty() {
            Vec::new()
        } else {
            self.get_match_positions(id, part_index, page_id, query, mode)?
        };
        Ok(Some(PageWithMatches {
            id: page.id,
            part_label: page.part_label,
            page_number: page.page_number,
            body: page.body,
            matched_token_indices: matched,
        }))
    }

    pub fn get_match_positions_combined(&self, id: u64, part_index: u64, page_id: u64, terms: &[SearchTerm]) -> Result<Vec<u32>> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        match self.kind {
            IndexKind::Compound => {
                let key = PageKey::new(id, part_index, page_id);
                let sets: Vec<Sets> = terms.iter().map(|t| self.highlight_sets(t)).collect();
                let mut m = self.forward_highlights(&[key], &sets, usize::MAX)?;
                Ok(m.remove(&key).unwrap_or_default())
            }
            IndexKind::ThreeField => {
                let searcher = self.reader.searcher();
                let Some(addr) = self.find_page(&searcher, id, part_index, page_id)? else {
                    return Ok(Vec::new());
                };
                let seg = searcher.segment_reader(addr.segment_ord);
                let mut positions: Vec<u32> = Vec::new();
                for term in terms {
                    let words = self.term_words(term);
                    positions.extend(self.postings_positions(seg, addr.doc_id, self.field_for(term.mode), &words, 50));
                }
                positions.sort_unstable();
                positions.dedup();
                Ok(positions)
            }
        }
    }

    pub fn get_match_positions_multi(&self, id: u64, part_index: u64, page_id: u64, terms: &[SearchTerm]) -> Result<Vec<Vec<u32>>> {
        let mut out = Vec::with_capacity(terms.len());
        for t in terms {
            out.push(self.get_match_positions(id, part_index, page_id, &t.query, t.mode)?);
        }
        Ok(out)
    }

    pub fn combined_search(&self, and_terms: &[SearchTerm], or_terms: &[SearchTerm], filters: &SearchFilters, limit: usize, offset: usize) -> Result<SearchResults> {
        let start = std::time::Instant::now();
        if and_terms.is_empty() && or_terms.is_empty() {
            return Ok(SearchResults {
                query: String::new(),
                mode: SearchMode::Lemma,
                total_hits: 0,
                results: Vec::new(),
                elapsed_ms: 0,
                was_capped: None,
                walk_key: None,
                complete: None,
            });
        }
        let searcher = self.reader.searcher();

        // Single compound phrase whose slots are too wide for RegexPhraseQuery:
        // exact positional phrase instead of capped verification.
        if self.kind == IndexKind::Compound
            && self.config.proximity_impl == ProximityImpl::Positional
            && and_terms.len() == 1
            && or_terms.is_empty()
        {
            let sets = self.term_sets(&and_terms[0]);
            if sets.len() > 1 && !sets.iter().any(|s| s.is_empty()) {
                let states: usize = sets.iter().map(|s| trie_nodes(s)).sum();
                if states > REGEX_STATE_BUDGET {
                    let key = self.walk_key("phrase", &and_terms[0], filters);
                    return self.phrase_positional(&searcher, &and_terms[0], key, sets, filters, limit, offset, start);
                }
            }
        }

        let mut and_plans = Vec::with_capacity(and_terms.len());
        for t in and_terms {
            and_plans.push(self.build_term_plan(t)?);
        }
        let mut or_plans = Vec::with_capacity(or_terms.len());
        for t in or_terms {
            or_plans.push(self.build_term_plan(t)?);
        }
        let needs_verify = any_needs_verify(&and_plans) || any_needs_verify(&or_plans);
        // Forward-index sets for verification (all terms, so the boolean can be
        // evaluated exactly on the page).
        let and_sets: Vec<Vec<HashSet<u32>>> = if needs_verify {
            and_terms.iter().map(|t| Self::hash_sets(&self.term_sets(t))).collect()
        } else {
            Vec::new()
        };
        let or_sets: Vec<Vec<HashSet<u32>>> = if needs_verify {
            or_terms.iter().map(|t| Self::hash_sets(&self.term_sets(t))).collect()
        } else {
            Vec::new()
        };

        let mut and_queries: Vec<Box<dyn Query>> = and_plans.into_iter().map(|p| p.query).collect();
        let mut or_queries: Vec<Box<dyn Query>> = or_plans.into_iter().map(|p| p.query).collect();
        let text_query: Box<dyn Query> = if and_queries.len() == 1 && or_queries.is_empty() {
            and_queries.pop().unwrap()
        } else if and_queries.is_empty() && or_queries.len() == 1 {
            or_queries.pop().unwrap()
        } else {
            let mut must: Vec<(Occur, Box<dyn Query>)> = and_queries.into_iter().map(|q| (Occur::Must, q)).collect();
            if !or_queries.is_empty() {
                let should: Vec<(Occur, Box<dyn Query>)> = or_queries.into_iter().map(|q| (Occur::Should, q)).collect();
                must.push((Occur::Must, Box::new(BooleanQuery::new(should))));
            }
            Box::new(BooleanQuery::new(must))
        };
        let final_query = self.with_filters(text_query, filters);

        let cap = self.config.result_highlight_cap;
        if needs_verify {
            // Bag-of-words plan: a cached, capped walk verifies every page on
            // the forward index and records its highlight positions.
            let hl_cap = self.config.combined_result_cap.unwrap_or(cap.max(50));
            let verify: Arc<dyn Fn(&[u32]) -> Option<Vec<u32>> + Send + Sync> = Arc::new(move |ids: &[u32]| {
                let matches = |sets: &Vec<HashSet<u32>>| !sets.is_empty() && !forward::phrase_starts(ids, sets).is_empty();
                if !(and_sets.iter().all(matches) && (or_sets.is_empty() || or_sets.iter().any(matches))) {
                    return None;
                }
                let mut positions: Vec<u32> = Vec::new();
                for sets in and_sets.iter().chain(or_sets.iter()) {
                    match sets.len() {
                        0 => {}
                        1 => positions.extend(forward::member_positions(ids, &sets[0])),
                        _ => positions.extend(forward::phrase_positions(ids, sets)),
                    }
                }
                positions.sort_unstable();
                positions.dedup();
                positions.truncate(hl_cap);
                Some(positions)
            });
            let key = self.walk_key("combined", &(and_terms, or_terms), filters);
            let w = self.verified_window(&searcher, key.clone(), final_query, limit, offset, verify)?;
            let results = self.walk_window_results(&searcher, &key, offset, limit, &w)?;
            let complete = w.done;
            let join = |ts: &[SearchTerm], sep: &str| ts.iter().map(|t| t.query.as_str()).collect::<Vec<_>>().join(sep);
            let query_display = if !and_terms.is_empty() && !or_terms.is_empty() {
                format!("({}) AND ({})", join(and_terms, " AND "), join(or_terms, " OR "))
            } else if !and_terms.is_empty() {
                join(and_terms, " AND ")
            } else {
                join(or_terms, " OR ")
            };
            return Ok(SearchResults {
                query: query_display,
                mode: and_terms.first().or(or_terms.first()).map(|t| t.mode).unwrap_or_default(),
                total_hits: w.total,
                results,
                elapsed_ms: start.elapsed().as_millis() as u64,
                was_capped: if w.was_capped { Some(true) } else { None },
                walk_key: Some(key),
                complete: Some(complete),
            });
        }
        let (total_hits, addrs) = self
            .paged(&searcher, &*final_query, limit, offset)
            .map_err(|e| map_expansion_error(e, "the phrase"))?;
        let was_capped = false;
        let mut results = self.results_from(&searcher, &addrs)?;

        let all_terms: Vec<&SearchTerm> = and_terms.iter().chain(or_terms.iter()).collect();
        match self.kind {
            IndexKind::Compound => {
                let keys = self.keys_of(&searcher, &addrs);
                let sets: Vec<Sets> = all_terms.iter().map(|t| self.highlight_sets(t)).collect();
                let map = self.forward_highlights(&keys, &sets, self.config.combined_result_cap.unwrap_or(cap.max(50)))?;
                self.attach_highlights(&mut results, &map);
            }
            IndexKind::ThreeField => {
                for (r, addr) in results.iter_mut().zip(addrs.iter()) {
                    let seg = searcher.segment_reader(addr.segment_ord);
                    let mut matched: Vec<u32> = Vec::new();
                    for term in &all_terms {
                        let words = self.term_words(term);
                        matched.extend(self.postings_positions(seg, addr.doc_id, self.field_for(term.mode), &words, cap));
                    }
                    matched.sort_unstable();
                    matched.dedup();
                    if let Some(c) = self.config.combined_result_cap {
                        matched.truncate(c);
                    }
                    r.matched_token_indices = matched;
                }
            }
        }
        if !self.reading_order {
            sort_results_by_reading_order(&mut results);
        }

        let join = |ts: &[SearchTerm], sep: &str| ts.iter().map(|t| t.query.as_str()).collect::<Vec<_>>().join(sep);
        let query_display = if !and_terms.is_empty() && !or_terms.is_empty() {
            format!("({}) AND ({})", join(and_terms, " AND "), join(or_terms, " OR "))
        } else if !and_terms.is_empty() {
            join(and_terms, " AND ")
        } else {
            join(or_terms, " OR ")
        };
        let mode = and_terms.first().or(or_terms.first()).map(|t| t.mode).unwrap_or_default();

        Ok(SearchResults {
            query: query_display,
            mode,
            total_hits,
            results,
            elapsed_ms: start.elapsed().as_millis() as u64,
            was_capped: if was_capped { Some(true) } else { None },
            walk_key: None,
            complete: None,
        })
    }

    pub fn proximity_search(&self, term1: &SearchTerm, term2: &SearchTerm, max_distance: usize, filters: &SearchFilters, limit: usize, offset: usize) -> Result<SearchResults> {
        Ok(self.proximity_search_with_stats(term1, term2, max_distance, filters, limit, offset)?.0)
    }

    /// Proximity search returning per-stage timings (compound path).
    pub fn proximity_search_with_stats(&self, term1: &SearchTerm, term2: &SearchTerm, max_distance: usize, filters: &SearchFilters, limit: usize, offset: usize) -> Result<(SearchResults, ProximityStats)> {
        let start = std::time::Instant::now();
        let searcher = self.reader.searcher();
        let text_query = BooleanQuery::new(vec![
            (Occur::Must, self.build_term_query(term1)?),
            (Occur::Must, self.build_term_query(term2)?),
        ]);
        let final_query = self.with_filters(Box::new(text_query), filters);

        let (results, total_matches, was_capped, mut stats) = match self.kind {
            IndexKind::Compound => {
                let mut sets1 = self.highlight_sets(term1);
                let mut sets2 = self.highlight_sets(term2);
                let single_words = sets1.len() == 1 && sets2.len() == 1;
                let key = self.walk_key("prox", &(term1, term2, max_distance), filters);
                if self.config.proximity_impl == ProximityImpl::Positional && single_words {
                    let (s1, s2) = (sets1.pop().unwrap(), sets2.pop().unwrap());
                    self.proximity_positional(&searcher, key, s1, s2, filters, max_distance, limit, offset)?
                } else {
                    self.proximity_forward(&searcher, key, final_query, sets1, sets2, max_distance, limit, offset)?
                }
            }
            IndexKind::ThreeField => {
                let mut r = self.proximity_postings(&searcher, &*final_query, term1, term2, max_distance, limit, offset)?;
                r.3.complete = true;
                r
            }
        };
        stats.total_us = start.elapsed().as_micros() as u64;
        if prox_debug() {
            eprintln!(
                "[prox] {} from_cache={} walk_ms={} cand_total={} scanned={} hits={} sets={}/{} tantivy={}ms keys={}ms open={}ms fetch={}ms decode={}ms scan={}ms docs={}ms total={}ms ({:.1} us/cand, {} cache hits, {} KB blobs)",
                stats.path,
                stats.from_cache,
                stats.walk_ms,
                stats.candidates_total,
                stats.candidates_scanned,
                stats.verified_hits,
                stats.set1_size,
                stats.set2_size,
                stats.tantivy_us / 1000,
                stats.keys_us / 1000,
                stats.open_us / 1000,
                stats.fetch_us / 1000,
                stats.decode_us / 1000,
                stats.scan_us / 1000,
                stats.doc_fetch_us / 1000,
                stats.total_us / 1000,
                stats.per_candidate_us(),
                stats.cache_hits,
                stats.blob_bytes / 1024
            );
        }

        Ok((
            SearchResults {
                query: format!("{} ~{} {}", term1.query, max_distance, term2.query),
                mode: term1.mode,
                total_hits: total_matches,
                results,
                elapsed_ms: start.elapsed().as_millis() as u64,
                was_capped: if was_capped { Some(true) } else { None },
                walk_key: stats.walk_key.clone(),
                complete: if stats.walk_key.is_some() { Some(stats.complete) } else { None },
            },
            stats,
        ))
    }

    /// Compound proximity, tier 2: positional intersection on the `tokens`
    /// postings (see `positional.rs`). Exact count unless the wall-clock
    /// budget runs out. Single-word sides only (the caller checks).
    /// Filter-only query (book ids, fast-field ranges) or `None` when no filter is set.
    fn filter_query(&self, filters: &SearchFilters) -> Option<Box<dyn Query>> {
        let has_filter = filters.book_ids.as_ref().map_or(false, |v| !v.is_empty())
            || filters.author_id.is_some()
            || filters.genre_id.is_some()
            || filters.century_ah.is_some()
            || filters.death_ah_min.is_some()
            || filters.death_ah_max.is_some();
        if has_filter {
            Some(self.with_filters(Box::new(tantivy::query::AllQuery), filters))
        } else {
            None
        }
    }

    /// Compound phrase whose slot alternations are too wide for
    /// `RegexPhraseQuery`: a cached, capped walk — positional phrase
    /// intersection when every slot is at most `wildcard_expansion_threshold`
    /// ids, otherwise the hybrid cursor/bitset scan verified on the forward
    /// index.
    #[allow(clippy::too_many_arguments)]
    fn phrase_positional(&self, searcher: &Searcher, term: &SearchTerm, key: String, sets: Vec<Vec<u32>>, filters: &SearchFilters, limit: usize, offset: usize, start: std::time::Instant) -> Result<SearchResults> {
        let w = self.phrase_positional_core(searcher, key, sets, filters, limit, offset)?;
        Ok(SearchResults {
            query: term.query.clone(),
            mode: term.mode,
            total_hits: w.total,
            results: w.results,
            elapsed_ms: start.elapsed().as_millis() as u64,
            was_capped: if w.was_capped { Some(true) } else { None },
            walk_key: w.walk_key,
            complete: Some(w.complete),
        })
    }

    /// (total hits, result window, was_capped) for a compound phrase given
    /// its per-slot triple sets, through the walk cache.
    fn phrase_positional_core(&self, searcher: &Searcher, key: String, sets: Vec<Vec<u32>>, filters: &SearchFilters, limit: usize, offset: usize) -> Result<Walked> {
        let key_for_memo = key.clone();
        let tokens = self.fields.tokens.expect("compound index");
        let threshold = self.config.wildcard_expansion_threshold;
        let filter_query = self.filter_query(filters);
        let pos_cap = self.config.result_highlight_cap.max(50);
        let wide = sets.iter().any(|s| s.len() > threshold);
        let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
        let w = self.walks.window(key, offset, limit, self.walk_limits(), || -> Result<Walker> {
            let searcher = searcher.clone();
            if !wide {
                Ok(Box::new(move |sink: &mut Sink| -> Result<()> {
                    let matcher = crate::positional::phrase_matcher();
                    let mut adapter = WalkStreamSink { sink, positions_cap: pos_cap };
                    let ps = crate::positional::intersect_n_stream(
                        &searcher,
                        tokens,
                        &sets,
                        &triple_term,
                        &matcher,
                        filter_query.as_deref(),
                        &mut adapter,
                    )?;
                    sink.add_candidates(ps.co_occurring);
                    if prox_debug() {
                        eprintln!(
                            "[phrase] positional walk slots={} cursors={:?} doc_freqs={:?} co_occurring={} hits={} open={}ms intersect={}ms positions={}ms",
                            ps.cursors.len(), ps.cursors, ps.doc_freqs, ps.co_occurring, ps.hits, ps.open_us / 1000, ps.intersect_us / 1000, ps.positions_us / 1000
                        );
                    }
                    Ok(())
                }))
            } else {
                let Some(cache) = self.cache.clone() else {
                    anyhow::bail!("wide-slot phrases require an attached TokenCache");
                };
                let triples = self.triples.clone().expect("compound index has triple maps");
                let members: Vec<Members> = sets.iter().map(|s| Members::from_ids(s, threshold)).collect();
                let n = sets.len() as u32;
                Ok(Box::new(move |sink: &mut Sink| -> Result<()> {
                    let t0 = std::time::Instant::now();
                    let mut verify_us = 0u64;
                    let mut checked = 0usize;
                    let mut on_chunk = |chunk: &[DocAddress]| -> tantivy::Result<bool> {
                        if chunk.is_empty() {
                            return Ok(sink.tick());
                        }
                        let tv = std::time::Instant::now();
                        let keys = page_keys(&searcher, chunk);
                        let pages = page_triples_with(&cache, &triples, &keys)
                            .map_err(|e| tantivy::TantivyError::InternalError(e.to_string()))?;
                        sink.add_candidates(chunk.len());
                        for (addr, key) in chunk.iter().zip(keys.iter()) {
                            let Some(ids) = pages.get(key) else { continue };
                            checked += 1;
                            let starts = forward::phrase_starts(ids, &members);
                            if starts.is_empty() {
                                continue;
                            }
                            let positions = phrase_positions_from_starts(&starts, n, pos_cap);
                            if !sink.push(WalkHit { addr: *addr, positions }) {
                                verify_us += tv.elapsed().as_micros() as u64;
                                return Ok(false);
                            }
                        }
                        verify_us += tv.elapsed().as_micros() as u64;
                        Ok(sink.tick())
                    };
                    let (wide_slots, hs) = crate::positional::cooccurring_hybrid_stream(
                        &searcher,
                        tokens,
                        &sets,
                        &triple_term,
                        threshold,
                        filter_query.as_deref(),
                        FORWARD_BATCH,
                        &mut on_chunk,
                    )?;
                    if prox_debug() {
                        eprintln!(
                            "[phrase] hybrid walk slots={} wide={:?} sizes={:?} cursors={:?} doc_freqs={:?} co_occurring={} checked={} hits={} | open={}ms intersect={}ms positions={}ms verify={}ms total={}ms",
                            sets.len(), wide_slots, sizes, hs.cursors, hs.doc_freqs, hs.co_occurring, checked, sink.hits_so_far(),
                            hs.open_us / 1000, hs.intersect_us / 1000, hs.positions_us / 1000, verify_us / 1000, t0.elapsed().as_millis()
                        );
                    }
                    Ok(())
                }))
            }
        })?;
        let results = self.walk_window_results(searcher, &key_for_memo, offset, limit, &w)?;
        Ok(Walked { total: w.total, results, was_capped: w.was_capped, walk_key: Some(key_for_memo), complete: w.done })
    }

    /// Compound proximity, single-word sides: positional intersection on the
    /// `tokens` postings as a cached, capped walk.
    #[allow(clippy::too_many_arguments)]
    fn proximity_positional(&self, searcher: &Searcher, key: String, set1: Vec<u32>, set2: Vec<u32>, filters: &SearchFilters, max_distance: usize, limit: usize, offset: usize) -> Result<(Vec<SearchResult>, usize, bool, ProximityStats)> {
        let mut stats = ProximityStats { path: "positional-walk", set1_size: set1.len(), set2_size: set2.len(), ..Default::default() };
        let key_for_memo = key.clone();
        let tokens = self.fields.tokens.expect("compound index");
        let filter_query = self.filter_query(filters);
        let pos_cap = self.config.page_highlight_cap;
        let t0 = std::time::Instant::now();
        let w = self.walks.window(key, offset, limit, self.walk_limits(), || -> Result<Walker> {
            let searcher = searcher.clone();
            Ok(Box::new(move |sink: &mut Sink| -> Result<()> {
                let matcher = crate::positional::proximity_matcher(max_distance as u32);
                let sets = [set1, set2];
                let mut adapter = WalkStreamSink { sink, positions_cap: pos_cap };
                let ps = crate::positional::intersect_n_stream(
                    &searcher,
                    tokens,
                    &sets,
                    &triple_term,
                    &matcher,
                    filter_query.as_deref(),
                    &mut adapter,
                )?;
                sink.add_candidates(ps.co_occurring);
                if prox_debug() {
                    eprintln!(
                        "[prox] positional walk cursors {:?} doc_freqs {:?} co_occurring {} hits {} open={}ms intersect={}ms positions={}ms stopped={}",
                        ps.cursors, ps.doc_freqs, ps.co_occurring, ps.hits, ps.open_us / 1000, ps.intersect_us / 1000, ps.positions_us / 1000, ps.budget_exhausted
                    );
                }
                Ok(())
            }))
        })?;
        stats.tantivy_us = t0.elapsed().as_micros() as u64;
        stats.candidates_total = w.candidates;
        stats.candidates_scanned = w.candidates;
        stats.verified_hits = w.total;
        stats.from_cache = w.from_cache;
        stats.walk_ms = w.walk_elapsed_ms;
        stats.complete = w.done;
        let td = std::time::Instant::now();
        let results = self.walk_window_results(searcher, &key_for_memo, offset, limit, &w)?;
        stats.doc_fetch_us = td.elapsed().as_micros() as u64;
        stats.walk_key = Some(key_for_memo);
        Ok((results, w.total, w.was_capped, stats))
    }

    /// Three-field proximity: over-fetch candidates ordered by death_ah and
    /// measure distances between postings positions (100 per side).
    fn proximity_postings(&self, searcher: &Searcher, query: &dyn Query, term1: &SearchTerm, term2: &SearchTerm, max_distance: usize, limit: usize, offset: usize) -> Result<(Vec<SearchResult>, usize, bool, ProximityStats)> {
        let mut stats = ProximityStats { path: "postings", ..Default::default() };
        let overfetch_limit = ((limit + offset) * 50).max(5000);
        let field1 = self.field_for(term1.mode);
        let field2 = self.field_for(term2.mode);
        let terms1: HashSet<String> = self.term_words(term1).into_iter().collect();
        let terms2: HashSet<String> = self.term_words(term2).into_iter().collect();
        stats.set1_size = terms1.len();
        stats.set2_size = terms2.len();

        let t0 = std::time::Instant::now();
        let (total_candidates, candidates) = self.candidates(searcher, query, overfetch_limit)?;
        stats.tantivy_us = t0.elapsed().as_micros() as u64;
        stats.candidates_total = total_candidates;
        let was_capped = total_candidates > candidates.len();

        let mut results = Vec::new();
        let mut skipped = 0usize;
        let mut total_matches = 0usize;
        for addr in candidates {
            stats.candidates_scanned += 1;
            let seg = searcher.segment_reader(addr.segment_ord);
            let ts = std::time::Instant::now();
            let pos1 = self.term_positions(seg, addr.doc_id, field1, &terms1, 100);
            let pos2 = self.term_positions(seg, addr.doc_id, field2, &terms2, 100);
            let mut matched: Vec<u32> = Vec::new();
            for &p1 in &pos1 {
                for &p2 in &pos2 {
                    if p1.abs_diff(p2) as usize <= max_distance {
                        matched.push(p1);
                        matched.push(p2);
                    }
                }
            }
            stats.scan_us += ts.elapsed().as_micros() as u64;
            if matched.is_empty() {
                continue;
            }
            total_matches += 1;
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if results.len() >= limit {
                continue;
            }
            let td = std::time::Instant::now();
            let doc: TantivyDocument = searcher.doc(addr)?;
            stats.doc_fetch_us += td.elapsed().as_micros() as u64;
            matched.sort_unstable();
            matched.dedup();
            matched.truncate(50);
            results.push(self.extract_result(&doc, 0.0, matched));
        }
        stats.verified_hits = total_matches;
        if !self.reading_order {
            sort_results_by_reading_order(&mut results);
        }
        // The postings path reports a lower bound whenever the over-fetch window
        // did not cover every candidate (this was undocumented before 0.5.0).
        Ok((results, total_matches, was_capped, stats))
    }

    /// Compound proximity with a phrase side: stream the candidate `DocSet`
    /// in reading order and measure the distance on the forward index, as a
    /// cached, capped walk.
    #[allow(clippy::too_many_arguments)]
    fn proximity_forward(&self, searcher: &Searcher, key: String, query: Box<dyn Query>, sets1: Sets, sets2: Sets, max_distance: usize, limit: usize, offset: usize) -> Result<(Vec<SearchResult>, usize, bool, ProximityStats)> {
        let mut stats = ProximityStats { path: "forward-walk", ..Default::default() };
        let sets1 = Self::hash_sets(&sets1);
        let sets2 = Self::hash_sets(&sets2);
        stats.set1_size = sets1.iter().map(|s| s.len()).sum();
        stats.set2_size = sets2.iter().map(|s| s.len()).sum();
        let len1 = sets1.len() as u32;
        let len2 = sets2.len() as u32;
        let pos_cap = self.config.page_highlight_cap;
        let verify: Arc<dyn Fn(&[u32]) -> Option<Vec<u32>> + Send + Sync> = Arc::new(move |ids: &[u32]| {
            let starts1 = forward::phrase_starts(ids, &sets1);
            let starts2 = forward::phrase_starts(ids, &sets2);
            if !forward::has_pair_within(&starts1, &starts2, max_distance as u32) {
                return None;
            }
            let mut positions = forward::proximity_positions(&starts1, len1, &starts2, len2, max_distance as u32);
            positions.truncate(pos_cap);
            Some(positions)
        });
        let t0 = std::time::Instant::now();
        let key_for_memo = key.clone();
        let w = self.verified_window(searcher, key, query, limit, offset, verify)?;
        stats.tantivy_us = t0.elapsed().as_micros() as u64;
        stats.candidates_total = w.candidates;
        stats.candidates_scanned = w.candidates;
        stats.verified_hits = w.total;
        stats.from_cache = w.from_cache;
        stats.walk_ms = w.walk_elapsed_ms;
        stats.complete = w.done;
        let td = std::time::Instant::now();
        let results = self.walk_window_results(searcher, &key_for_memo, offset, limit, &w)?;
        stats.doc_fetch_us = td.elapsed().as_micros() as u64;
        stats.walk_key = Some(key_for_memo);
        Ok((results, w.total, w.was_capped, stats))
    }

    /// Name search: each form is a list of surface patterns (proclitic
    /// expansion already applied). OR within a form, AND across forms.
    pub fn name_search(&self, patterns_by_form: &[Vec<String>], filters: &SearchFilters, limit: usize, offset: usize) -> Result<SearchResults> {
        let start = std::time::Instant::now();
        let empty = || SearchResults {
            query: String::new(),
            mode: SearchMode::Surface,
            total_hits: 0,
            results: Vec::new(),
            elapsed_ms: 0,
            was_capped: None,
            walk_key: None,
            complete: None,
        };
        if patterns_by_form.is_empty() || patterns_by_form.iter().all(|p| p.is_empty()) {
            return Ok(empty());
        }
        let searcher = self.reader.searcher();

        let mut form_queries: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        let mut pattern_terms: Vec<SearchTerm> = Vec::new();
        // per form: per pattern: per position sets (for verification)
        let mut form_sets: Vec<Vec<Vec<HashSet<u32>>>> = Vec::new();
        let mut needs_verify = false;
        for patterns in patterns_by_form {
            let mut pattern_queries: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            let mut sets_for_form: Vec<Vec<HashSet<u32>>> = Vec::new();
            for pattern in patterns {
                let term = SearchTerm { query: pattern.clone(), mode: SearchMode::Surface };
                if self.term_words(&term).is_empty() {
                    continue;
                }
                let plan = self.build_term_plan(&term)?;
                needs_verify |= plan.verify.is_some();
                pattern_queries.push((Occur::Should, plan.query));
                if self.kind == IndexKind::Compound {
                    sets_for_form.push(Self::hash_sets(&self.term_sets(&term)));
                }
                pattern_terms.push(term);
            }
            if !pattern_queries.is_empty() {
                form_queries.push((Occur::Must, Box::new(BooleanQuery::new(pattern_queries))));
                form_sets.push(sets_for_form);
            }
        }
        if form_queries.is_empty() {
            return Ok(empty());
        }
        let text_query: Box<dyn Query> = if form_queries.len() == 1 {
            form_queries.pop().unwrap().1
        } else {
            Box::new(BooleanQuery::new(form_queries))
        };
        let final_query = self.with_filters(text_query, filters);

        let cap = self.config.result_highlight_cap;
        let query_display = patterns_by_form
            .iter()
            .filter(|p| !p.is_empty())
            .map(|p| p.first().map(|s| s.as_str()).unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" AND ");
        if needs_verify {
            let hl_cap = cap.max(50);
            let verify: Arc<dyn Fn(&[u32]) -> Option<Vec<u32>> + Send + Sync> = Arc::new(move |ids: &[u32]| {
                let ok = form_sets
                    .iter()
                    .all(|patterns| patterns.iter().any(|sets| !forward::phrase_starts(ids, sets).is_empty()));
                if !ok {
                    return None;
                }
                // Highlight with the first form's patterns, as before.
                let mut positions: Vec<u32> = Vec::new();
                if let Some(first) = form_sets.first() {
                    for sets in first {
                        match sets.len() {
                            0 => {}
                            1 => positions.extend(forward::member_positions(ids, &sets[0])),
                            _ => positions.extend(forward::phrase_positions(ids, sets)),
                        }
                    }
                }
                positions.sort_unstable();
                positions.dedup();
                positions.truncate(hl_cap);
                Some(positions)
            });
            let key = self.walk_key("name", &patterns_by_form, filters);
            let w = self.verified_window(&searcher, key.clone(), final_query, limit, offset, verify)?;
            let results = self.walk_window_results(&searcher, &key, offset, limit, &w)?;
            return Ok(SearchResults {
                query: query_display,
                mode: SearchMode::Surface,
                total_hits: w.total,
                results,
                elapsed_ms: start.elapsed().as_millis() as u64,
                was_capped: if w.was_capped { Some(true) } else { None },
                walk_key: Some(key),
                complete: Some(w.done),
            });
        }
        let (total_hits, addrs) = self.paged(&searcher, &*final_query, limit, offset)?;
        let was_capped = false;
        let mut results = self.results_from(&searcher, &addrs)?;

        match self.kind {
            IndexKind::Compound => {
                let keys = self.keys_of(&searcher, &addrs);
                // Highlight with the first form's patterns, as before.
                let first_form_len = patterns_by_form.first().map(|p| p.len()).unwrap_or(0);
                let sets: Vec<Sets> = pattern_terms.iter().take(first_form_len).map(|t| self.highlight_sets(t)).collect();
                let map = self.forward_highlights(&keys, &sets, cap.max(50))?;
                self.attach_highlights(&mut results, &map);
            }
            IndexKind::ThreeField => {
                let surface = self.fields.surface.unwrap();
                for (r, addr) in results.iter_mut().zip(addrs.iter()) {
                    if let Some(patterns) = patterns_by_form.first() {
                        r.matched_token_indices =
                            self.name_pattern_positions(searcher.segment_reader(addr.segment_ord), addr.doc_id, surface, patterns, cap);
                    }
                }
            }
        }
        if !self.reading_order {
            sort_results_by_reading_order(&mut results);
        }

        Ok(SearchResults {
            query: query_display,
            mode: SearchMode::Surface,
            total_hits,
            results,
            elapsed_ms: start.elapsed().as_millis() as u64,
            was_capped: if was_capped { Some(true) } else { None },
            walk_key: None,
            complete: None,
        })
    }

    pub fn get_name_match_positions(&self, id: u64, part_index: u64, page_id: u64, patterns: &[String]) -> Result<Vec<u32>> {
        match self.kind {
            IndexKind::Compound => {
                let key = PageKey::new(id, part_index, page_id);
                let sets: Vec<Sets> = patterns
                    .iter()
                    .map(|p| self.highlight_sets(&SearchTerm { query: p.clone(), mode: SearchMode::Surface }))
                    .collect();
                let mut m = self.forward_highlights(&[key], &sets, usize::MAX)?;
                Ok(m.remove(&key).unwrap_or_default())
            }
            IndexKind::ThreeField => {
                let searcher = self.reader.searcher();
                let Some(addr) = self.find_page(&searcher, id, part_index, page_id)? else {
                    return Ok(Vec::new());
                };
                Ok(self.name_pattern_positions(searcher.segment_reader(addr.segment_ord), addr.doc_id, self.fields.surface.unwrap(), patterns, 50))
            }
        }
    }

    /// Wildcard search without an explicit token cache (uses the attached one).
    pub fn wildcard_search(&self, query: &str, filters: &SearchFilters, limit: usize, offset: usize) -> Result<SearchResults> {
        self.wildcard_search_with_cache(query, filters, limit, offset, self.cache.as_deref())
    }

    /// Wildcard search.
    ///
    /// Three-field (legacy grammar): `RegexQuery` on `surface_text` for a
    /// single term, a `RegexPhraseQuery` for phrases; highlights from the
    /// token cache by surface matching.
    ///
    /// Compound (glob grammar): every wildcard word expands to the triple ids
    /// whose normalized surface matches its `*`-glob (`TripleMaps::
    /// triples_for_glob`); there is no distinct-word refusal. A single word
    /// is a `TermSetQuery` (exact count). A phrase is a `RegexPhraseQuery`
    /// while its alternations fit the FST budget (exact), otherwise a cached,
    /// capped walk: positional intersection when every slot is at most
    /// `wildcard_expansion_threshold` ids, else the hybrid cursor/bitset scan
    /// verified on the forward index. Highlights are token membership in the
    /// slot's triple set, from the forward index.
    pub fn wildcard_search_with_cache(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
        cache: Option<&TokenCache>,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();
        if let Err(e) = validate_wildcard_query(query, SearchMode::Surface, self.wildcard_grammar()) {
            return Err(anyhow!("{}", e.message));
        }
        let normalized = normalize_arabic(query);
        let info = parse_wildcard_query(&normalized);
        if !info.has_wildcard {
            return self.search(query, SearchMode::Surface, filters, limit, offset);
        }
        let searcher = self.reader.searcher();
        let cache = cache.or(self.cache.as_deref());

        let walked = match self.kind {
            IndexKind::ThreeField => {
                let what = format!("{}*{}", info.prefix, info.suffix.as_deref().unwrap_or(""));
                let text_query = self.wildcard_query_three_field(&info)?;
                let final_query = self.with_filters(text_query, filters);
                let (total, addrs) = self
                    .paged(&searcher, &*final_query, limit, offset)
                    .map_err(|e| map_expansion_error(e, &what))?;
                let mut results = self.results_from(&searcher, &addrs)?;
                match cache {
                    Some(cache) => {
                        let keys: Vec<PageKey> = results.iter().map(|r| PageKey::new(r.id, r.part_index, r.page_id)).collect();
                        let positions = cache.wildcard_phrase_positions_batch(
                            &keys,
                            &info.prefix,
                            info.suffix.as_deref(),
                            info.wildcard_term_index,
                            &info.terms,
                        )?;
                        self.attach_highlights(&mut results, &positions);
                    }
                    None => {
                        if let Some(surface) = self.fields.surface {
                            let cap = self.config.result_highlight_cap;
                            for (r, addr) in results.iter_mut().zip(addrs.iter()) {
                                let seg = searcher.segment_reader(addr.segment_ord);
                                r.matched_token_indices = if info.terms.len() == 1 {
                                    self.wildcard_positions(seg, addr.doc_id, surface, &info, cap)
                                } else {
                                    self.wildcard_phrase_positions_approx(seg, addr.doc_id, surface, &info, cap)
                                };
                            }
                        }
                    }
                }
                Walked { total, results, was_capped: false, walk_key: None, complete: true }
            }
            IndexKind::Compound => self.wildcard_compound(&searcher, &normalized, &info, filters, limit, offset)?,
        };
        let Walked { total, mut results, was_capped, walk_key, complete } = walked;
        if !self.reading_order {
            sort_results_by_reading_order(&mut results);
        }
        Ok(SearchResults {
            query: query.to_string(),
            mode: SearchMode::Surface,
            total_hits: total,
            results,
            elapsed_ms: start.elapsed().as_millis() as u64,
            was_capped: if was_capped { Some(true) } else { None },
            complete: if walk_key.is_some() { Some(complete) } else { None },
            walk_key,
        })
    }

    /// Per-slot triple sets of a compound wildcard query: the glob expansion
    /// of every wildcard word, exact surface lookups for the literal words.
    fn wildcard_sets(&self, info: &WildcardQueryInfo) -> Sets {
        info.patterns.iter().map(|g| (*self.triples_for_glob_cached(g)).clone()).collect()
    }

    /// Highlights by membership of each page's triple ids in the slot sets.
    fn wildcard_highlights(&self, keys: &[PageKey], sets: &[Vec<u32>], cap: usize) -> Result<HashMap<PageKey, Vec<u32>>> {
        let pages = self.page_triples(keys)?;
        let threshold = self.config.wildcard_expansion_threshold;
        let members: Vec<Members> = sets.iter().map(|s| Members::from_ids(s, threshold)).collect();
        let mut out = HashMap::with_capacity(keys.len());
        for key in keys {
            let Some(ids) = pages.get(key) else {
                out.insert(*key, Vec::new());
                continue;
            };
            let mut positions = match members.len() {
                0 => Vec::new(),
                1 => forward::member_positions(ids, &members[0]),
                _ => forward::phrase_positions(ids, &members),
            };
            positions.truncate(cap);
            out.insert(*key, positions);
        }
        Ok(out)
    }

    /// Compound wildcard: (total, window, was_capped). See
    /// [`Self::wildcard_search_with_cache`] for the path choice.
    fn wildcard_compound(&self, searcher: &Searcher, normalized: &str, info: &WildcardQueryInfo, filters: &SearchFilters, limit: usize, offset: usize) -> Result<Walked> {
        let sets = self.wildcard_sets(info);
        let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
        if sets.iter().any(|s| s.is_empty()) {
            if prox_debug() {
                eprintln!("[wildcard] empty slot sizes={:?}", sizes);
            }
            return Ok(Walked { total: 0, results: Vec::new(), was_capped: false, walk_key: None, complete: true });
        }
        // Every id adds at least one trie node, so a phrase whose ids alone
        // exceed the budget skips the (sort-heavy) trie count.
        let ids_total: usize = sizes.iter().sum();
        let states: usize = if sets.len() > 1 && ids_total <= REGEX_STATE_BUDGET { sets.iter().map(|s| trie_nodes(s)).sum() } else { ids_total };
        if sets.len() == 1 || states <= REGEX_STATE_BUDGET {
            let plan = self.compound_plan(&sets)?;
            debug_assert!(plan.verify.is_none());
            let final_query = self.with_filters(plan.query, filters);
            let (total, addrs) = self.paged(searcher, &*final_query, limit, offset)?;
            let mut results = self.results_from(searcher, &addrs)?;
            let keys = self.keys_of(searcher, &addrs);
            let map = self.wildcard_highlights(&keys, &sets, self.config.page_highlight_cap)?;
            self.attach_highlights(&mut results, &map);
            if prox_debug() {
                eprintln!(
                    "[wildcard] path={} sizes={:?} trie_nodes={} total={}",
                    if sets.len() == 1 { "termset" } else { "regex_phrase" },
                    sizes,
                    states,
                    total
                );
            }
            return Ok(Walked { total, results, was_capped: false, walk_key: None, complete: true });
        }
        if prox_debug() {
            eprintln!("[wildcard] path=walk sizes={:?} trie_nodes={} threshold={}", sizes, states, self.config.wildcard_expansion_threshold);
        }
        let key = self.walk_key("wildcard", &normalized, filters);
        self.phrase_positional_core(searcher, key, sets, filters, limit, offset)
    }

    /// Exact highlight positions for a wildcard query on one page.
    pub fn wildcard_match_positions(&self, cache: &TokenCache, id: u64, part_index: u64, page_id: u64, query: &str) -> Result<Vec<u32>> {
        let info = parse_wildcard_query(&normalize_arabic(query));
        let key = PageKey::new(id, part_index, page_id);
        match self.kind {
            IndexKind::Compound => {
                let sets = self.wildcard_sets(&info);
                let mut m = self.wildcard_highlights(&[key], &sets, usize::MAX)?;
                Ok(m.remove(&key).unwrap_or_default())
            }
            IndexKind::ThreeField => {
                let mut m = cache.wildcard_phrase_positions_batch(&[key], &info.prefix, info.suffix.as_deref(), info.wildcard_term_index, &info.terms)?;
                Ok(m.remove(&key).unwrap_or_default())
            }
        }
    }

    fn wildcard_regex(info: &WildcardQueryInfo, term: &str, index: usize) -> String {
        if index != info.wildcard_term_index {
            return regex_escape(term);
        }
        match info.wildcard_type {
            WildcardType::Prefix => format!("{}.*", regex_escape(&info.prefix)),
            WildcardType::Internal => format!("{}.*{}", regex_escape(&info.prefix), regex_escape(info.suffix.as_deref().unwrap_or(""))),
            WildcardType::None => regex_escape(term),
        }
    }

    /// Three-field wildcard query: `RegexQuery` for one word, `RegexPhraseQuery`
    /// with one pattern per word for phrases.
    fn wildcard_query_three_field(&self, info: &WildcardQueryInfo) -> Result<Box<dyn Query>> {
        let field = self.fields.surface.expect("three-field index");
        if info.terms.len() == 1 {
            let pattern = Self::wildcard_regex(info, &info.terms[0], 0);
            return Ok(Box::new(RegexQuery::from_pattern(&pattern, field)?));
        }
        let patterns: Vec<String> = info.terms.iter().enumerate().map(|(i, t)| Self::wildcard_regex(info, t, i)).collect();
        let mut q = RegexPhraseQuery::new(field, patterns);
        q.set_max_expansions(WILDCARD_MAX_EXPANSIONS);
        Ok(Box::new(q))
    }

    // ------------------------------------------------------------------
    // Position extraction from postings (three-field index)
    // ------------------------------------------------------------------

    fn positions_in_doc(inverted: &tantivy::InvertedIndexReader, term: &Term, doc_id: u32, out: &mut Vec<u32>) {
        let Ok(Some(mut postings)) = inverted.read_postings(term, IndexRecordOption::WithFreqsAndPositions) else {
            return;
        };
        let current = postings.doc();
        if current == tantivy::TERMINATED || current > doc_id {
            return;
        }
        let found = if current == doc_id { doc_id } else { postings.seek(doc_id) };
        if found == doc_id {
            let mut buf = Vec::new();
            postings.positions(&mut buf);
            out.extend(buf);
        }
    }

    /// Term positions for a single word, phrase positions for several.
    fn postings_positions(&self, seg: &SegmentReader, doc_id: u32, field: Field, words: &[String], cap: usize) -> Vec<u32> {
        match words.len() {
            0 => Vec::new(),
            1 => {
                let set: HashSet<String> = words.iter().cloned().collect();
                self.term_positions(seg, doc_id, field, &set, cap)
            }
            _ => self.phrase_positions(seg, doc_id, field, words, cap),
        }
    }

    fn term_positions(&self, seg: &SegmentReader, doc_id: u32, field: Field, query_terms: &HashSet<String>, cap: usize) -> Vec<u32> {
        let mut positions = Vec::new();
        let Ok(inverted) = seg.inverted_index(field) else {
            return positions;
        };
        for t in query_terms {
            Self::positions_in_doc(&inverted, &Term::from_field_text(field, t), doc_id, &mut positions);
            if positions.len() >= cap {
                break;
            }
        }
        positions.sort_unstable();
        positions.dedup();
        positions.truncate(cap);
        positions
    }

    fn phrase_positions(&self, seg: &SegmentReader, doc_id: u32, field: Field, phrase_terms: &[String], cap: usize) -> Vec<u32> {
        if phrase_terms.is_empty() {
            return Vec::new();
        }
        if phrase_terms.len() == 1 {
            let set: HashSet<String> = phrase_terms.iter().cloned().collect();
            return self.term_positions(seg, doc_id, field, &set, cap);
        }
        let Ok(inverted) = seg.inverted_index(field) else {
            return Vec::new();
        };
        let mut per_term: Vec<Vec<u32>> = Vec::with_capacity(phrase_terms.len());
        for t in phrase_terms {
            let mut p = Vec::new();
            Self::positions_in_doc(&inverted, &Term::from_field_text(field, t), doc_id, &mut p);
            if p.is_empty() {
                return Vec::new();
            }
            per_term.push(p);
        }
        let mut matched = Vec::new();
        for &start in &per_term[0] {
            let ok = per_term.iter().enumerate().skip(1).all(|(k, ps)| ps.contains(&(start + k as u32)));
            if ok {
                for k in 0..phrase_terms.len() {
                    matched.push(start + k as u32);
                }
            }
            if matched.len() >= cap {
                break;
            }
        }
        matched.sort_unstable();
        matched.dedup();
        matched.truncate(cap);
        matched
    }

    fn name_pattern_positions(&self, seg: &SegmentReader, doc_id: u32, field: Field, patterns: &[String], cap: usize) -> Vec<u32> {
        let mut all: HashSet<u32> = HashSet::new();
        for pattern in patterns {
            let words = Self::words_of(&normalize_arabic(pattern));
            all.extend(self.postings_positions(seg, doc_id, field, &words, cap));
            if all.len() >= cap {
                break;
            }
        }
        let mut out: Vec<u32> = all.into_iter().collect();
        out.sort_unstable();
        out.truncate(cap);
        out
    }

    /// Single-term wildcard highlight from postings: exact terms plus every
    /// dictionary term matching the pattern (bounded scan).
    fn wildcard_positions(&self, seg: &SegmentReader, doc_id: u32, field: Field, info: &WildcardQueryInfo, cap: usize) -> Vec<u32> {
        let mut all: Vec<u32> = Vec::new();
        let Ok(inverted) = seg.inverted_index(field) else {
            return all;
        };
        for (i, t) in info.terms.iter().enumerate() {
            if i == info.wildcard_term_index {
                continue;
            }
            Self::positions_in_doc(&inverted, &Term::from_field_text(field, t), doc_id, &mut all);
        }
        if info.has_wildcard {
            let prefix_bytes = info.prefix.as_bytes();
            let suffix = info.suffix.as_deref();
            let dict = inverted.terms();
            if let Ok(mut stream) = dict.range().ge(prefix_bytes).into_stream() {
                while stream.advance() {
                    let key = stream.key();
                    if !key.starts_with(prefix_bytes) {
                        break;
                    }
                    let Ok(term_str) = std::str::from_utf8(key) else { continue };
                    if let Some(suf) = suffix {
                        if !term_str.ends_with(suf) {
                            continue;
                        }
                    }
                    Self::positions_in_doc(&inverted, &Term::from_field_text(field, term_str), doc_id, &mut all);
                    if all.len() >= cap * 10 {
                        break;
                    }
                }
            }
        }
        all.sort_unstable();
        all.dedup();
        all.truncate(cap);
        all
    }

    /// Phrase highlight approximation without a token cache.
    fn wildcard_phrase_positions_approx(&self, seg: &SegmentReader, doc_id: u32, field: Field, info: &WildcardQueryInfo, cap: usize) -> Vec<u32> {
        let Ok(inverted) = seg.inverted_index(field) else {
            return Vec::new();
        };
        let n = info.terms.len() as u32;
        let mut starts: Option<HashSet<u32>> = None;
        for (i, t) in info.terms.iter().enumerate() {
            if i == info.wildcard_term_index {
                continue;
            }
            let mut p = Vec::new();
            Self::positions_in_doc(&inverted, &Term::from_field_text(field, t), doc_id, &mut p);
            let these: HashSet<u32> = p.into_iter().filter_map(|pos| pos.checked_sub(i as u32)).collect();
            starts = Some(match starts {
                None => these,
                Some(prev) => prev.intersection(&these).copied().collect(),
            });
        }
        let mut out: Vec<u32> = starts.unwrap_or_default().into_iter().flat_map(|s| s..s + n).collect();
        out.sort_unstable();
        out.dedup();
        out.truncate(cap);
        out
    }
}

fn segment_columns(searcher: &Searcher, seg_ord: u32) -> SegmentColumns {
    let ff = searcher.segment_reader(seg_ord).fast_fields();
    SegmentColumns {
        death: ff.u64("death_ah").ok(),
        text: ff.u64("text_id").ok(),
        part: ff.u64("part_index").ok(),
        page: ff.u64("page_id").ok(),
    }
}

/// Page keys of documents via fast fields (columns opened once per segment).
fn page_keys(searcher: &Searcher, addrs: &[DocAddress]) -> Vec<PageKey> {
    let mut cols: HashMap<u32, SegmentColumns> = HashMap::new();
    addrs
        .iter()
        .map(|a| {
            let c = cols.entry(a.segment_ord).or_insert_with(|| segment_columns(searcher, a.segment_ord));
            c.page_key(a.doc_id)
        })
        .collect()
}

/// Triple ids of many pages from the token cache (definition ids mapped
/// through the triple maps).
fn page_triples_with(cache: &TokenCache, t: &TripleMaps, keys: &[PageKey]) -> Result<HashMap<PageKey, Vec<u32>>> {
    let ids = cache.get_ids_batch(keys)?;
    Ok(ids
        .into_iter()
        .map(|(k, defs)| (k, defs.iter().map(|&d| t.triple_of_def(d)).collect()))
        .collect())
}

/// Every match of `query` in reading order (multi-segment fallback: collect
/// and sort by the reading-order key).
fn candidates_sorted(searcher: &Searcher, query: &dyn Query) -> Result<(usize, Vec<DocAddress>)> {
    let (total, top) = searcher.search(
        query,
        &(Count, TopDocs::with_limit(usize::MAX.min(10_000_000)).order_by_u64_field("death_ah", tantivy::Order::Asc)),
    )?;
    let addrs: Vec<DocAddress> = top.into_iter().map(|(_, a): (u64, DocAddress)| a).collect();
    let mut cols: HashMap<u32, SegmentColumns> = HashMap::new();
    let mut keyed: Vec<(OrderKey, DocAddress)> = addrs
        .into_iter()
        .map(|a| {
            let c = cols.entry(a.segment_ord).or_insert_with(|| segment_columns(searcher, a.segment_ord));
            (c.order_key(a.doc_id), a)
        })
        .collect();
    keyed.sort_by_key(|(k, _)| *k);
    Ok((total, keyed.into_iter().map(|(_, a)| a).collect()))
}

/// Adapter from the positional stream to a walk sink.
struct WalkStreamSink<'a> {
    sink: &'a mut Sink,
    positions_cap: usize,
}

impl StreamSink for WalkStreamSink<'_> {
    fn want_positions(&mut self, _hits_so_far: usize) -> bool {
        true
    }

    fn on_hit(&mut self, hit: PositionalHit) -> bool {
        let mut positions = hit.positions;
        positions.truncate(self.positions_cap);
        self.sink.push(WalkHit { addr: hit.addr, positions })
    }

    fn tick(&mut self) -> bool {
        self.sink.tick()
    }
}

/// Positions of a phrase match given its start positions.
fn phrase_positions_from_starts(starts: &[u32], n: u32, cap: usize) -> Vec<u32> {
    let mut positions: Vec<u32> = starts.iter().flat_map(|&s| s..s + n).collect();
    positions.dedup();
    positions.truncate(cap);
    positions
}

/// Walk the (single) segment's live docs and check the reading-order key never decreases.
fn verify_reading_order(searcher: &Searcher) -> Result<bool> {
    for seg in searcher.segment_readers() {
        let ff = seg.fast_fields();
        let death = ff.u64("death_ah")?;
        let text = ff.u64("text_id")?;
        let part = ff.u64("part_index")?;
        let page = ff.u64("page_id")?;
        let mut prev: Option<OrderKey> = None;
        for doc in 0..seg.max_doc() {
            if seg.is_deleted(doc) {
                continue;
            }
            let key: OrderKey = (
                death.first(doc).unwrap_or(u64::MAX),
                text.first(doc).unwrap_or(0),
                part.first(doc).unwrap_or(0),
                page.first(doc).unwrap_or(0),
            );
            if let Some(p) = prev {
                if key < p {
                    return Ok(false);
                }
            }
            prev = Some(key);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_validation_glob() {
        let g = WildcardGrammar::Glob;
        assert!(validate_wildcard_query("كتاب", SearchMode::Lemma, g).is_ok());
        for ok in ["أب*", "*رف", "أح*مد", "*قول*", "مع*رف*", "م*رف", "ال*", "ابو *الله", "أب* كت*", "ا*ب"] {
            assert!(validate_wildcard_query(ok, SearchMode::Surface, g).is_ok(), "{}", ok);
        }
        for bad in ["ا*", "*", "**", "ابن *", "*ب*"] {
            let e = validate_wildcard_query(bad, SearchMode::Surface, g).unwrap_err();
            assert_eq!(e.message, WILDCARD_ERR_LETTERS, "{}", bad);
        }
        assert_eq!(validate_wildcard_query("أب*", SearchMode::Lemma, g).unwrap_err().message, WILDCARD_ERR_MODE);
    }

    #[test]
    fn wildcard_validation_legacy() {
        let g = WildcardGrammar::Legacy;
        assert!(validate_wildcard_query("أب*", SearchMode::Surface, g).is_ok());
        assert!(validate_wildcard_query("أح*مد", SearchMode::Surface, g).is_ok());
        assert!(validate_wildcard_query("م*رف", SearchMode::Surface, g).is_ok());
        assert_eq!(validate_wildcard_query("*منصور", SearchMode::Surface, g).unwrap_err().message, WILDCARD_ERR_START);
        assert_eq!(validate_wildcard_query("أب* كت*", SearchMode::Surface, g).unwrap_err().message, WILDCARD_ERR_ONE);
        assert_eq!(validate_wildcard_query("أب*", SearchMode::Lemma, g).unwrap_err().message, WILDCARD_ERR_MODE);
    }

    #[test]
    fn wildcard_parse() {
        let info = parse_wildcard_query("ابن ال*");
        assert!(info.has_wildcard);
        assert_eq!(info.wildcard_term_index, 1);
        assert_eq!(info.wildcard_type, WildcardType::Prefix);
        assert_eq!(info.prefix, "ال");
        assert_eq!(info.segments, vec!["ال"]);
        assert!(info.anchored_start && !info.anchored_end);
        assert_eq!(info.patterns.len(), 2);
        assert!(!info.patterns[0].is_wildcard());
        let info = parse_wildcard_query("اح*مد");
        assert_eq!(info.wildcard_type, WildcardType::Internal);
        assert_eq!(info.suffix.as_deref(), Some("مد"));
        assert_eq!(info.segments, vec!["اح", "مد"]);
        let info = parse_wildcard_query("مع*رف* *قول*");
        assert_eq!(info.wildcard_term_index, 0);
        assert_eq!(info.segments, vec!["مع", "رف"]);
        assert!(info.anchored_start && !info.anchored_end);
        assert!(info.patterns[1].is_wildcard());
        assert!(!info.patterns[1].anchored_start && !info.patterns[1].anchored_end);
        let info = parse_wildcard_query("*ية");
        assert!(!info.anchored_start && info.anchored_end);
        assert_eq!(info.prefix, "");
        assert_eq!(info.suffix.as_deref(), Some("ية"));
    }

    #[test]
    fn regex_escape_escapes_metachars() {
        assert_eq!(regex_escape("a.b*"), "a\\.b\\*");
    }

    #[test]
    fn trie_nodes_counts_shared_prefixes() {
        // 0000001 and 0000002 share 6 chars: 7 + 1 nodes
        assert_eq!(trie_nodes(&[1, 2]), 8);
        assert_eq!(trie_nodes(&[1]), 7);
        // 1000000 shares nothing with 0000001
        assert_eq!(trie_nodes(&[1, 1_000_000]), 14);
        assert!(trie_nodes(&(1..=2000).collect::<Vec<u32>>()) > REGEX_STATE_BUDGET);
    }
}
