//! The boundary index: matches that straddle a page break.
//!
//! The main index is page-granular and its positions restart on every page,
//! so a phrase or a proximity pair split by a page break is never a match
//! there. `boundary_index/`, built by the pipeline from corpus 4.3.0, holds
//! one document per pair of consecutive pages of a book: the last 20 tokens
//! of the first page at positions 0–19 and the first 20 of the second at
//! 20–39, in the same `tokens` field of triple ids, with a page shorter than
//! 20 tokens padded on its own side by a token that never matches. The
//! engine runs the same translated query against it with the same
//! positional intersection, and keeps only what straddles the midpoint —
//! what the main index cannot have found — so nothing is counted twice.
//!
//! The scan is a stream, pulled: a thread walks the boundary index in
//! reading order and hands over one straddling match at a time through a
//! bounded channel, and the consumer — a walk merging them among its own
//! hits — pulls only as far as it goes. A walk that stops at its hit cap
//! after a fraction of the main index takes the same fraction of the
//! boundary index with it; dropping the receiver ends the scan. Before this
//! the whole boundary index was scanned up front, serially, for every
//! query, which cost a capped proximity search ten times its main walk.
//!
//! A slot wider than the expansion threshold (a glob such as `ال*`, hundreds
//! of thousands of triples) is not opened as that many posting cursors:
//! like the main index, the scan takes candidates from the bitset hybrid
//! and verifies them on the forward index, rebuilding the 40-token window
//! from the two pages' token ids.
//!
//! Absent beside the main index (an older corpus), everything here is off
//! and the engine behaves as before.
//!
//! Attribution: the primary page is the one holding more of the match, ties
//! to the earlier page — the left page iff `s + e <= 39` for a span `s..=e`,
//! and the same test on the two positions of a proximity pair. Positions map
//! back to page coordinates with the stored left page length: on the left
//! page, `page_len_left - 20 + pos`; on the right, `pos - 20`.

use crate::cache::TokenCache;
use crate::forward::{self, Members};
use crate::positional::{cooccurring_hybrid_stream, intersect_n_stream, PositionalHit, StreamSink};
use crate::search::SearchFilters;
use crate::tokens::PageKey;
use crate::triples::{triple_term, TripleMaps};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;
use tantivy::query::{BooleanQuery, Occur, Query, RangeQuery, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, Schema, Term};
use tantivy::{DocAddress, Index, IndexReader, ReloadPolicy, Searcher};

/// Tokens on each side of the break; the midpoint.
pub const SIDE: u32 = 20;
/// Width of every boundary document.
pub const WIDTH: u32 = 2 * SIDE;
/// The longest span the guarantee covers: one token on one side and the rest on the other.
pub const MAX_SPAN: u32 = SIDE + 1;
/// The directory beside `tantivy_index`.
pub const DIR_NAME: &str = "boundary_index";
/// The sidecar the builder writes beside tantivy's `meta.json`.
pub const META_FILE: &str = "boundary.json";
/// The layout this build reads.
pub const FORMAT: u64 = 1;
/// Hits buffered between the scanning thread and its consumer.
const STREAM_DEPTH: usize = 1024;
/// Candidate boundary documents verified per forward-index batch (hybrid path).
const HYBRID_CHUNK: usize = 2_000;

/// The reading-order key the engine merges by: (death_ah or MAX, text_id, part_index, page_id).
pub type OrderKey = (u64, u64, u64, u64);

/// `boundary.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryMeta {
    pub format: u64,
    pub corpus_version: String,
    pub documents: u64,
    #[serde(default)]
    pub pages: u64,
    #[serde(default)]
    pub books: u64,
    #[serde(default)]
    pub build_seconds: u64,
}

#[derive(Debug, Clone, Copy)]
struct Fields {
    text_id: Field,
    part_index: Field,
    page_id: Field,
    part_index_right: Field,
    page_id_right: Field,
    page_len_left: Field,
    author_id: Field,
    genre_id: Field,
    death_ah: Field,
    century_ah: Field,
    tokens: Field,
}

impl Fields {
    fn resolve(schema: &Schema) -> Result<Self> {
        let f = |name: &str| schema.get_field(name).with_context(|| format!("boundary index schema is missing `{}`", name));
        Ok(Self {
            text_id: f("text_id")?,
            part_index: f("part_index")?,
            page_id: f("page_id")?,
            part_index_right: f("part_index_right")?,
            page_id_right: f("page_id_right")?,
            page_len_left: f("page_len_left")?,
            author_id: f("author_id")?,
            genre_id: f("genre_id")?,
            death_ah: f("death_ah")?,
            century_ah: f("century_ah")?,
            tokens: f("tokens")?,
        })
    }
}

/// The open index.
pub struct BoundaryIndex {
    #[allow(dead_code)]
    index: Index,
    reader: IndexReader,
    fields: Fields,
    meta: BoundaryMeta,
    path: PathBuf,
}

/// Where a match falls in a boundary document, and which page owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attribution {
    /// The first straddling span, in document positions.
    pub start: u32,
    pub end: u32,
    pub primary_is_left: bool,
}

/// A straddling match, mapped back to its two pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossHit {
    pub order_key: OrderKey,
    pub primary: PageKey,
    /// Token indices of the match on the primary page.
    pub primary_positions: Vec<u32>,
    pub secondary: PageKey,
    /// Token indices of the match on the secondary page.
    pub secondary_positions: Vec<u32>,
    pub primary_is_left: bool,
}

/// What is being matched, in the boundary document's positions.
#[derive(Debug, Clone)]
pub enum MatchKind {
    /// Consecutive slots, one per word.
    Phrase,
    /// A chain of terms, each of `lens[k]` consecutive slots, consecutive
    /// terms within `distances[k]` of each other measured between their
    /// first words, in order when `ordered`.
    Proximity { lens: Vec<usize>, distances: Vec<u32>, ordered: bool },
}

/// What a scan may draw on besides the index: the forward index, for
/// verifying the candidates of a wide slot, and the threshold that makes a
/// slot wide.
#[derive(Clone)]
pub struct ScanSources {
    pub cache: Option<Arc<TokenCache>>,
    pub triples: Option<Arc<TripleMaps>>,
    pub threshold: usize,
    /// Page-level AND terms of a proximity search, one set per slot of each:
    /// a hit across a break keeps only if every term is on either of its two
    /// pages, checked on the forward index.
    pub and_terms: Vec<Vec<Vec<u32>>>,
}

/// The page-level check on both pages of a cross hit.
struct AndOnEitherPage {
    cache: Arc<TokenCache>,
    triples: Arc<TripleMaps>,
    terms: Vec<Vec<Members>>,
}

impl AndOnEitherPage {
    fn passes(&self, left: PageKey, right: PageKey) -> bool {
        let Ok(ids) = self.cache.get_ids_batch(&[left, right]) else { return false };
        let page = |k: PageKey| -> Vec<u32> { ids.get(&k).map(|d| d.iter().map(|&x| self.triples.triple_of_def(x)).collect()).unwrap_or_default() };
        let (l, r) = (page(left), page(right));
        self.terms.iter().all(|sets| !forward::phrase_starts(&l, sets).is_empty() || !forward::phrase_starts(&r, sets).is_empty())
    }
}

/// Straddle test for a span `s..=e`: it starts before the midpoint and ends at or past it.
#[inline]
pub fn straddles(s: u32, e: u32) -> bool {
    s < SIDE && e >= SIDE
}

/// Left page iff `s + e <= 39`.
#[inline]
pub fn left_owns(s: u32, e: u32) -> bool {
    s + e <= WIDTH - 1
}

/// Phrase starts in a boundary document: every start where slot k holds `start + k`.
fn phrase_starts(slots: &[Vec<u32>]) -> Vec<u32> {
    let n = slots.len() as u32;
    slots[0]
        .iter()
        .copied()
        .filter(|&s| (1..n).all(|k| slots[k as usize].binary_search(&(s + k)).is_ok()))
        .collect()
}

/// The matcher's decision for one document: the positions to keep and the attribution.
fn decide(kind: &MatchKind, slots: &[Vec<u32>]) -> Option<(Vec<u32>, Attribution)> {
    match kind {
        MatchKind::Phrase => {
            let n = slots.len() as u32;
            let mut out: Vec<u32> = Vec::new();
            let mut attr: Option<Attribution> = None;
            for s in phrase_starts(slots) {
                let e = s + n - 1;
                if !straddles(s, e) {
                    continue;
                }
                if attr.is_none() {
                    attr = Some(Attribution { start: s, end: e, primary_is_left: left_owns(s, e) });
                }
                out.extend(s..=e);
            }
            let attr = attr?;
            out.sort_unstable();
            out.dedup();
            Some((out, attr))
        }
        MatchKind::Proximity { lens, distances, ordered } => {
            // Each term's starts, from its run of slots.
            let mut starts: Vec<Vec<u32>> = Vec::with_capacity(lens.len());
            let mut at = 0;
            for &l in lens {
                starts.push(phrase_starts(&slots[at..at + l]));
                at += l;
            }
            let mut out: Vec<u32> = Vec::new();
            let mut attr: Option<Attribution> = None;
            for t in chain_tuples_pub(&starts, distances, *ordered) {
                // A straddle: at least one term on each side of the break.
                let (lo, hi) = (*t.iter().min().unwrap(), *t.iter().max().unwrap());
                if !(lo < SIDE && hi >= SIDE) {
                    continue;
                }
                if attr.is_none() {
                    attr = Some(Attribution { start: lo, end: hi, primary_is_left: left_owns(lo, hi) });
                }
                for (k, &s) in t.iter().enumerate() {
                    out.extend(s..(s + lens[k] as u32).min(WIDTH));
                }
            }
            let attr = attr?;
            out.sort_unstable();
            out.dedup();
            Some((out, attr))
        }
    }
}

/// The chain's tuples, as `forward` walks them (one start per term).
fn chain_tuples_pub(starts: &[Vec<u32>], distances: &[u32], ordered: bool) -> Vec<Vec<u32>> {
    let mut tuples: Vec<Vec<u32>> = starts.first().map(|s0| s0.iter().map(|&s| vec![s]).collect()).unwrap_or_default();
    for (k, next) in starts.iter().enumerate().skip(1) {
        let d = distances[k - 1];
        let mut grown = Vec::new();
        for t in &tuples {
            let prev = *t.last().unwrap();
            for &n in next {
                if forward::link_ok(prev, n, d, ordered) {
                    let mut u = t.clone();
                    u.push(n);
                    grown.push(u);
                }
            }
        }
        tuples = grown;
        if tuples.is_empty() {
            break;
        }
    }
    tuples
}

/// The same decision from a rebuilt window: each slot's positions are the
/// window indices whose triple its set holds. Padding is 0, in no set.
fn decide_from_window(kind: &MatchKind, window: &[u32], members: &[Members]) -> Option<(Vec<u32>, Attribution)> {
    let slots: Vec<Vec<u32>> = members
        .iter()
        .map(|m| window.iter().enumerate().filter(|(_, &t)| t != 0 && forward::TripleSet::contains(m, t)).map(|(i, _)| i as u32).collect())
        .collect();
    if slots.iter().any(|s| s.is_empty()) {
        return None;
    }
    decide(kind, &slots)
}

impl BoundaryIndex {
    /// `<parent of index_path>/boundary_index`, when it is there and readable.
    /// A directory that is there but broken is reported and treated as absent:
    /// the feature is off, the engine works.
    pub fn open_beside(index_path: &Path) -> Option<Self> {
        let dir = index_path.parent()?.join(DIR_NAME);
        if !dir.is_dir() {
            return None;
        }
        match Self::open(&dir) {
            Ok(b) => {
                eprintln!("[boundary] {} documents, corpus {} ({})", b.meta.documents, b.meta.corpus_version, dir.display());
                Some(b)
            }
            Err(e) => {
                eprintln!("[boundary] {} is unusable and ignored: {:#}", dir.display(), e);
                None
            }
        }
    }

    pub fn open(dir: &Path) -> Result<Self> {
        let meta_path = dir.join(META_FILE);
        let meta: BoundaryMeta = serde_json::from_str(&std::fs::read_to_string(&meta_path).with_context(|| format!("reading {}", meta_path.display()))?)
            .with_context(|| format!("parsing {}", meta_path.display()))?;
        if meta.format != FORMAT {
            anyhow::bail!("boundary index format {} (this build reads {})", meta.format, FORMAT);
        }
        let index = Index::open_in_dir(dir).with_context(|| format!("opening {}", dir.display()))?;
        index.tokenizers().register("whitespace", tantivy::tokenizer::WhitespaceTokenizer::default());
        let fields = Fields::resolve(&index.schema())?;
        let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into().context("boundary index reader")?;
        let searcher = reader.searcher();
        if searcher.segment_readers().len() != 1 {
            anyhow::bail!("boundary index has {} segments; one is required", searcher.segment_readers().len());
        }
        Ok(Self { index, reader, fields, meta, path: dir.to_path_buf() })
    }

    pub fn meta(&self) -> &BoundaryMeta {
        &self.meta
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn document_count(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// The main engine's filters, on this index's fields.
    pub fn filter_query(&self, filters: &SearchFilters) -> Option<Box<dyn Query>> {
        let f = self.fields;
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        if let Some(ids) = &filters.book_ids {
            if !ids.is_empty() {
                let should: Vec<(Occur, Box<dyn Query>)> = ids
                    .iter()
                    .map(|&id| {
                        let q: Box<dyn Query> = Box::new(TermQuery::new(Term::from_field_u64(f.text_id, id), IndexRecordOption::Basic));
                        (Occur::Should, q)
                    })
                    .collect();
                clauses.push((Occur::Must, Box::new(BooleanQuery::new(should))));
            }
        }
        let eq = |field: Field, v: u64| -> Box<dyn Query> {
            Box::new(RangeQuery::new(Bound::Included(Term::from_field_u64(field, v)), Bound::Included(Term::from_field_u64(field, v))))
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
            let lo = filters.death_ah_min.map(|v| Bound::Included(Term::from_field_u64(f.death_ah, v))).unwrap_or(Bound::Unbounded);
            let hi = filters.death_ah_max.map(|v| Bound::Included(Term::from_field_u64(f.death_ah, v))).unwrap_or(Bound::Unbounded);
            clauses.push((Occur::Must, Box::new(RangeQuery::new(lo, hi))));
        }
        if clauses.is_empty() {
            None
        } else {
            Some(Box::new(BooleanQuery::new(clauses)))
        }
    }

    /// The straddling matches of `sets` in reading order, as a stream fed by
    /// its own thread: pull as far as needed, drop it to stop. `sets` are the
    /// query's slots as triple ids, exactly as for the main index. `None`
    /// when nothing can straddle (fewer than the slots a match needs, an
    /// empty slot) or when a wide slot has no forward index to verify on.
    pub fn scan(self: &Arc<Self>, kind: MatchKind, sets: Vec<Vec<u32>>, filters: &SearchFilters, sources: &ScanSources) -> Option<CrossStream> {
        if sets.is_empty() || sets.iter().any(|s| s.is_empty()) {
            return None;
        }
        let wide = sets.iter().any(|s| s.len() > sources.threshold);
        let forward = match (wide, &sources.cache, &sources.triples) {
            (false, _, _) => None,
            (true, Some(c), Some(t)) => Some((c.clone(), t.clone())),
            (true, _, _) => return None,
        };
        // Page-level AND terms need the forward index too; without it the
        // hits could not be checked and none are made.
        let and_check = if sources.and_terms.is_empty() {
            None
        } else {
            match (&sources.cache, &sources.triples) {
                (Some(c), Some(t)) => Some(AndOnEitherPage {
                    cache: c.clone(),
                    triples: t.clone(),
                    terms: sources.and_terms.iter().map(|sets| sets.iter().map(|s| Members::from_ids(s, sources.threshold)).collect()).collect(),
                }),
                _ => return None,
            }
        };
        let filter = self.filter_query(filters);
        let (tx, rx) = sync_channel::<CrossHit>(STREAM_DEPTH);
        let index = Arc::clone(self);
        let threshold = sources.threshold;
        std::thread::Builder::new()
            .name("kashshaf-boundary".into())
            .spawn(move || {
                let searcher = index.reader.searcher();
                let Ok(columns) = Columns::open(&searcher, 0, index.fields) else { return };
                let tx = Gate { tx, and_check };
                let result = match forward {
                    None => index.scan_positional(&searcher, kind, &sets, filter.as_deref(), columns, tx),
                    Some((cache, triples)) => index.scan_hybrid(&searcher, kind, &sets, threshold, filter.as_deref(), columns, cache, triples, tx),
                };
                if let Err(e) = result {
                    eprintln!("[boundary] scan failed: {:#}", e);
                }
            })
            .ok()?;
        Some(CrossStream { rx })
    }

    /// Narrow slots: the positional intersection, one cursor per triple.
    fn scan_positional(&self, searcher: &Searcher, kind: MatchKind, sets: &[Vec<u32>], filter: Option<&dyn Query>, columns: Columns, tx: Gate) -> Result<()> {
        let attribution: RefCell<Option<Attribution>> = RefCell::new(None);
        let matcher = |slots: &[Vec<u32>], _want: bool| -> Option<Vec<u32>> {
            let (positions, attr) = decide(&kind, slots)?;
            *attribution.borrow_mut() = Some(attr);
            Some(positions)
        };
        let mut sink = ChannelSink { tx, attribution: &attribution, columns };
        intersect_n_stream(searcher, self.fields.tokens, sets, &triple_term, &matcher, filter, &mut sink)?;
        Ok(())
    }

    /// A wide slot: candidates from the bitset hybrid, verified on the forward
    /// index by rebuilding each candidate's window from its two pages.
    #[allow(clippy::too_many_arguments)]
    fn scan_hybrid(
        &self,
        searcher: &Searcher,
        kind: MatchKind,
        sets: &[Vec<u32>],
        threshold: usize,
        filter: Option<&dyn Query>,
        columns: Columns,
        cache: Arc<TokenCache>,
        triples: Arc<TripleMaps>,
        tx: Gate,
    ) -> Result<()> {
        let members: Vec<Members> = sets.iter().map(|s| Members::from_ids(s, threshold)).collect();
        let mut on_chunk = |chunk: &[DocAddress]| -> tantivy::Result<bool> {
            if chunk.is_empty() {
                return Ok(true);
            }
            let mut keys: Vec<PageKey> = Vec::with_capacity(chunk.len() * 2);
            for a in chunk {
                keys.push(columns.left_key(a.doc_id));
                keys.push(columns.right_key(a.doc_id));
            }
            let ids = cache.get_ids_batch(&keys).map_err(|e| tantivy::TantivyError::InternalError(e.to_string()))?;
            for a in chunk {
                let (lk, rk) = (columns.left_key(a.doc_id), columns.right_key(a.doc_id));
                let (Some(left), Some(right)) = (ids.get(&lk), ids.get(&rk)) else { continue };
                let left: Vec<u32> = left.iter().map(|&d| triples.triple_of_def(d)).collect();
                let right: Vec<u32> = right.iter().map(|&d| triples.triple_of_def(d)).collect();
                let (w, _) = window(&left, &right);
                let Some((positions, attr)) = decide_from_window(&kind, &w, &members) else { continue };
                let hit = columns.cross_hit(a.doc_id, &positions, attr);
                if !tx.send(hit) {
                    return Ok(false);
                }
            }
            Ok(true)
        };
        cooccurring_hybrid_stream(searcher, self.fields.tokens, sets, &triple_term, threshold, filter, HYBRID_CHUNK, &mut on_chunk)?;
        Ok(())
    }

    /// The boundary documents touching a page: `(left neighbour, right neighbour)`
    /// as `(PageKey, DocAddress)` — the page before it and the page after it.
    pub fn neighbours(&self, page: PageKey) -> Result<(Option<(PageKey, DocAddress)>, Option<(PageKey, DocAddress)>)> {
        let searcher = self.reader.searcher();
        let f = self.fields;
        let one = |part: Field, pg: Field| -> Result<Option<DocAddress>> {
            let q = BooleanQuery::new(vec![
                (Occur::Must, Box::new(TermQuery::new(Term::from_field_u64(f.text_id, page.id), IndexRecordOption::Basic)) as Box<dyn Query>),
                (Occur::Must, Box::new(TermQuery::new(Term::from_field_u64(part, page.part_index), IndexRecordOption::Basic))),
                (Occur::Must, Box::new(TermQuery::new(Term::from_field_u64(pg, page.page_id), IndexRecordOption::Basic))),
            ]);
            let top = searcher.search(&q, &tantivy::collector::TopDocs::with_limit(1))?;
            Ok(top.into_iter().next().map(|(_, a)| a))
        };
        let cols = Columns::open(&searcher, 0, f)?;
        // This page as the right page of a document: the left neighbour.
        let before = one(f.part_index_right, f.page_id_right)?.map(|a| (cols.left_key(a.doc_id), a));
        // This page as the left page: the right neighbour.
        let after = one(f.part_index, f.page_id)?.map(|a| (cols.right_key(a.doc_id), a));
        Ok((before, after))
    }
}

/// Fast-field columns of the (one) segment.
struct Columns {
    text: tantivy::columnar::Column<u64>,
    part: tantivy::columnar::Column<u64>,
    page: tantivy::columnar::Column<u64>,
    part_r: tantivy::columnar::Column<u64>,
    page_r: tantivy::columnar::Column<u64>,
    page_len_l: tantivy::columnar::Column<u64>,
    death: Option<tantivy::columnar::Column<u64>>,
}

impl Columns {
    fn open(searcher: &Searcher, seg_ord: u32, f: Fields) -> Result<Self> {
        let seg = searcher.segment_reader(seg_ord);
        let ff = seg.fast_fields();
        let schema = searcher.schema();
        let name = |field: Field| schema.get_field_name(field);
        Ok(Self {
            text: ff.u64(name(f.text_id))?,
            part: ff.u64(name(f.part_index))?,
            page: ff.u64(name(f.page_id))?,
            part_r: ff.u64(name(f.part_index_right))?,
            page_r: ff.u64(name(f.page_id_right))?,
            page_len_l: ff.u64(name(f.page_len_left))?,
            death: ff.u64(name(f.death_ah)).ok(),
        })
    }
    fn left_key(&self, doc: u32) -> PageKey {
        PageKey::new(self.text.first(doc).unwrap_or(0), self.part.first(doc).unwrap_or(0), self.page.first(doc).unwrap_or(0))
    }
    fn right_key(&self, doc: u32) -> PageKey {
        PageKey::new(self.text.first(doc).unwrap_or(0), self.part_r.first(doc).unwrap_or(0), self.page_r.first(doc).unwrap_or(0))
    }
    /// A document's straddling match as a hit on its pages.
    fn cross_hit(&self, doc: u32, positions: &[u32], attr: Attribution) -> CrossHit {
        let page_len_l = self.page_len_l.first(doc).unwrap_or(SIDE as u64) as u32;
        let (left_pos, right_pos) = split_positions(positions, page_len_l);
        let left = self.left_key(doc);
        let right = self.right_key(doc);
        let death = self.death.as_ref().and_then(|x| x.first(doc)).unwrap_or(u64::MAX);
        let (primary, primary_positions, secondary, secondary_positions) =
            if attr.primary_is_left { (left, left_pos, right, right_pos) } else { (right, right_pos, left, left_pos) };
        CrossHit {
            order_key: (death, primary.id, primary.part_index, primary.page_id),
            primary,
            primary_positions,
            secondary,
            secondary_positions,
            primary_is_left: attr.primary_is_left,
        }
    }
}

/// Map document positions to the two pages, split at the midpoint. A
/// left-side position `p` is token `page_len_left - 20 + p` of the left page
/// (`page_len_left` is the whole page's count, not the side's, which is
/// capped at 20); a right-side one is `p - 20` of the right page.
pub fn split_positions(positions: &[u32], page_len_left: u32) -> (Vec<u32>, Vec<u32>) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    for &p in positions {
        if p < SIDE {
            // Positions below `SIDE - len_left` are padding and cannot occur in a match.
            if p + page_len_left >= SIDE {
                left.push(p + page_len_left - SIDE);
            }
        } else {
            right.push(p - SIDE);
        }
    }
    (left, right)
}

/// The channel to the consumer, behind the page-level AND check when there
/// is one: a hit whose pages lack an AND term is dropped here. `send` is
/// false once the consumer is gone.
struct Gate {
    tx: SyncSender<CrossHit>,
    and_check: Option<AndOnEitherPage>,
}

impl Gate {
    fn send(&self, hit: CrossHit) -> bool {
        if let Some(check) = &self.and_check {
            let (left, right) = if hit.primary_is_left { (hit.primary, hit.secondary) } else { (hit.secondary, hit.primary) };
            if !check.passes(left, right) {
                return true;
            }
        }
        self.tx.send(hit).is_ok()
    }
}

/// The positional scan's sink: every straddling document goes down the
/// channel; a closed channel (the consumer is done) stops the scan.
struct ChannelSink<'a> {
    tx: Gate,
    attribution: &'a RefCell<Option<Attribution>>,
    columns: Columns,
}

impl StreamSink for ChannelSink<'_> {
    fn want_positions(&mut self, _hits_so_far: usize) -> bool {
        true
    }

    fn on_hit(&mut self, hit: PositionalHit) -> bool {
        let Some(attr) = self.attribution.borrow_mut().take() else { return true };
        let cross = self.columns.cross_hit(hit.addr.doc_id, &hit.positions, attr);
        self.tx.send(cross)
    }

    fn tick(&mut self) -> bool {
        true
    }
}

/// Straddling matches in reading order, from a scanning thread. Dropping it
/// ends the scan.
pub struct CrossStream {
    rx: Receiver<CrossHit>,
}

impl CrossStream {
    /// A stream of known hits (tests).
    pub fn from_vec(mut hits: Vec<CrossHit>) -> Self {
        hits.sort_by(|a, b| a.order_key.cmp(&b.order_key));
        let (tx, rx) = sync_channel(hits.len().max(1));
        for h in hits {
            let _ = tx.send(h);
        }
        Self { rx }
    }

    /// Several streams as one, merged by reading order, a match reported by
    /// two of them (two variants of a phrase on the same span) once.
    pub fn merged(mut streams: Vec<CrossStream>) -> Option<CrossStream> {
        match streams.len() {
            0 => None,
            1 => streams.pop(),
            _ => {
                let (tx, rx) = sync_channel::<CrossHit>(STREAM_DEPTH);
                std::thread::Builder::new()
                    .name("kashshaf-boundary-merge".into())
                    .spawn(move || {
                        let mut heads: Vec<Option<CrossHit>> = streams.iter().map(|s| s.rx.recv().ok()).collect();
                        let mut last: Option<CrossHit> = None;
                        loop {
                            let next = (0..heads.len())
                                .filter(|&i| heads[i].is_some())
                                .min_by(|&a, &b| heads[a].as_ref().unwrap().order_key.cmp(&heads[b].as_ref().unwrap().order_key));
                            let Some(i) = next else { break };
                            let hit = heads[i].take().unwrap();
                            heads[i] = streams[i].rx.recv().ok();
                            let same = last.as_ref().map_or(false, |l| {
                                l.primary == hit.primary && l.secondary == hit.secondary && l.primary_positions == hit.primary_positions
                            });
                            if same {
                                continue;
                            }
                            if tx.send(hit.clone()).is_err() {
                                break;
                            }
                            last = Some(hit);
                        }
                    })
                    .ok()?;
                Some(CrossStream { rx })
            }
        }
    }

    /// Every remaining hit, in order.
    pub fn drain(self) -> Vec<CrossHit> {
        self.rx.iter().collect()
    }
}

/// Cross hits interleaved into a stream of main-index hits by reading-order
/// key, pulled from the scan as far as the main hits go: the pages before a
/// main hit go before it, the same page after it, the rest at the end.
pub struct Interleave {
    rx: Option<Receiver<CrossHit>>,
    head: Option<CrossHit>,
}

impl Interleave {
    pub fn new(stream: Option<CrossStream>) -> Self {
        let mut i = Self { rx: stream.map(|s| s.rx), head: None };
        i.pull();
        i
    }

    fn pull(&mut self) {
        self.head = self.rx.as_ref().and_then(|rx| rx.recv().ok());
        if self.head.is_none() {
            self.rx = None;
        }
    }

    /// Nothing more will come.
    pub fn is_empty(&self) -> bool {
        self.head.is_none()
    }

    /// Cross hits ordered strictly before `key`.
    pub fn before(&mut self, key: OrderKey) -> Vec<CrossHit> {
        let mut out = Vec::new();
        while let Some(h) = &self.head {
            if h.order_key >= key {
                break;
            }
            out.push(self.head.take().unwrap());
            self.pull();
        }
        out
    }

    /// Cross hits on the same page as `key`.
    pub fn at(&mut self, key: OrderKey) -> Vec<CrossHit> {
        let mut out = Vec::new();
        while let Some(h) = &self.head {
            if h.order_key != key {
                break;
            }
            out.push(self.head.take().unwrap());
            self.pull();
        }
        out
    }

    /// Everything left: the scan runs to its end.
    pub fn rest(&mut self) -> Vec<CrossHit> {
        let mut out = Vec::new();
        while let Some(h) = self.head.take() {
            out.push(h);
            self.pull();
        }
        out
    }
}

/// A page's window with its neighbours, as the boundary documents hold it:
/// the last `SIDE` tokens of `left` then the first `SIDE` of `right`, with
/// `len_left` real tokens on the left. For the per-page highlight lookup,
/// which reconstructs the two boundary documents touching a page from the
/// forward index rather than reading their positions back.
pub fn window(left: &[u32], right: &[u32]) -> (Vec<u32>, u32) {
    let l = &left[left.len().saturating_sub(SIDE as usize)..];
    let r = &right[..right.len().min(SIDE as usize)];
    let mut out = Vec::with_capacity(WIDTH as usize);
    // Padding is a value no triple set contains: 0 is never a triple id.
    out.extend(std::iter::repeat(0u32).take(SIDE as usize - l.len()));
    out.extend_from_slice(l);
    out.extend_from_slice(r);
    out.extend(std::iter::repeat(0u32).take(SIDE as usize - r.len()));
    (out, l.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn slots(pos: &[&[u32]]) -> Vec<Vec<u32>> {
        pos.iter().map(|p| p.to_vec()).collect()
    }

    #[test]
    fn a_phrase_split_seven_two_belongs_to_the_left_page() {
        // Nine words: seven on the left (13..=19), two on the right (20, 21).
        let s: Vec<Vec<u32>> = (0..9).map(|k| vec![13 + k]).collect();
        let (positions, attr) = decide(&MatchKind::Phrase, &s).unwrap();
        assert_eq!(positions, (13..=21).collect::<Vec<_>>());
        assert!(attr.primary_is_left);
        let (l, r) = split_positions(&positions, 20);
        assert_eq!(l, (13..=19).collect::<Vec<_>>());
        assert_eq!(r, vec![0, 1]);
    }

    #[test]
    fn a_phrase_split_two_seven_belongs_to_the_right_page() {
        let s: Vec<Vec<u32>> = (0..9).map(|k| vec![18 + k]).collect();
        let (_, attr) = decide(&MatchKind::Phrase, &s).unwrap();
        assert!(!attr.primary_is_left);
    }

    #[test]
    fn an_even_split_goes_to_the_earlier_page() {
        let s: Vec<Vec<u32>> = (0..8).map(|k| vec![16 + k]).collect();
        let (_, attr) = decide(&MatchKind::Phrase, &s).unwrap();
        assert!(attr.primary_is_left, "16 + 23 = 39: the left page");
    }

    #[test]
    fn a_phrase_wholly_on_one_side_is_the_main_index_s() {
        let left: Vec<Vec<u32>> = (0..3).map(|k| vec![5 + k]).collect();
        assert!(decide(&MatchKind::Phrase, &left).is_none());
        let right: Vec<Vec<u32>> = (0..3).map(|k| vec![20 + k]).collect();
        assert!(decide(&MatchKind::Phrase, &right).is_none());
        // Ending exactly on the last left token: not a straddle either.
        let edge: Vec<Vec<u32>> = (0..3).map(|k| vec![17 + k]).collect();
        assert!(decide(&MatchKind::Phrase, &edge).is_none());
        // Starting at the midpoint: the right page has it.
        let at: Vec<Vec<u32>> = (0..2).map(|k| vec![20 + k]).collect();
        assert!(decide(&MatchKind::Phrase, &at).is_none());
    }

    #[test]
    fn proximity_needs_one_term_on_each_side() {
        let both_left = slots(&[&[3], &[7]]);
        assert!(decide(&MatchKind::Proximity { lens: vec![1, 1], distances: vec![10], ordered: false }, &both_left).is_none());
        let both_right = slots(&[&[22], &[25]]);
        assert!(decide(&MatchKind::Proximity { lens: vec![1, 1], distances: vec![10], ordered: false }, &both_right).is_none());
        let across = slots(&[&[17], &[24]]);
        let (positions, attr) = decide(&MatchKind::Proximity { lens: vec![1, 1], distances: vec![10], ordered: false }, &across).unwrap();
        assert_eq!(positions, vec![17, 24]);
        assert!(!attr.primary_is_left, "17 + 24 = 41: the right page");
        let too_far = slots(&[&[10], &[24]]);
        assert!(decide(&MatchKind::Proximity { lens: vec![1, 1], distances: vec![10], ordered: false }, &too_far).is_none());
    }

    #[test]
    fn a_three_term_chain_straddles_with_one_term_across() {
        // A at 15, B at 18 on the left; C at 21 on the right: unordered and ordered both straddle.
        let chain = MatchKind::Proximity { lens: vec![1, 1, 1], distances: vec![5, 5], ordered: true };
        let s = slots(&[&[15], &[18], &[21]]);
        let (positions, attr) = decide(&chain, &s).unwrap();
        assert_eq!(positions, vec![15, 18, 21]);
        assert!(attr.primary_is_left, "15 + 21 = 36: the left page holds more");
        // All three on the left: not a straddle.
        assert!(decide(&chain, &slots(&[&[10], &[12], &[15]])).is_none());
        // C before B: unordered straddles, ordered does not.
        let back = slots(&[&[15], &[22], &[18]]);
        assert!(decide(&MatchKind::Proximity { lens: vec![1, 1, 1], distances: vec![8, 8], ordered: false }, &back).is_some());
        assert!(decide(&MatchKind::Proximity { lens: vec![1, 1, 1], distances: vec![8, 8], ordered: true }, &back).is_none());
    }

    #[test]
    fn a_short_page_is_padded_on_its_own_side() {
        // A left page of five tokens sits at positions 15..=19.
        let (w, len_left) = window(&[1, 2, 3, 4, 5], &[6, 7, 8]);
        assert_eq!(len_left, 5);
        assert_eq!(&w[..15], &[0u32; 15]);
        assert_eq!(&w[15..20], &[1, 2, 3, 4, 5]);
        assert_eq!(&w[20..23], &[6, 7, 8]);
        assert_eq!(&w[23..], &[0u32; 17]);
        // Positions map through the real length: 19 is the page's fifth token.
        let (l, r) = split_positions(&[18, 19, 20], 5);
        assert_eq!(l, vec![3, 4]);
        assert_eq!(r, vec![0]);
    }

    #[test]
    fn a_wide_slot_is_decided_from_the_rebuilt_window() {
        // Window: ... 7 8 | 9 ...; slot 0 = {8}, slot 1 = anything in {9, 10, 11} (a "glob").
        let mut left = vec![1u32; 30];
        left.extend([7, 8]);
        let right = vec![9u32, 2, 3];
        let (w, _) = window(&left, &right);
        let m = vec![
            Members::from_ids(&[8], 0),
            Members::from_ids(&[9, 10, 11], 1), // over the threshold: a bitmap
        ];
        let (positions, attr) = decide_from_window(&MatchKind::Phrase, &w, &m).unwrap();
        assert_eq!(positions, vec![19, 20]);
        assert!(attr.primary_is_left);
        let none = vec![Members::from_ids(&[8], 0), Members::from_ids(&[5], 0)];
        assert!(decide_from_window(&MatchKind::Phrase, &w, &none).is_none());
        let _ = HashSet::<u32>::new();
    }

    #[test]
    fn interleave_places_cross_hits_by_reading_order_and_stops_when_dropped() {
        let hit = |key: OrderKey| CrossHit {
            order_key: key,
            primary: PageKey::new(key.1, key.2, key.3),
            primary_positions: vec![0],
            secondary: PageKey::new(key.1, key.2, key.3 + 1),
            secondary_positions: vec![0],
            primary_is_left: true,
        };
        let mut i = Interleave::new(Some(CrossStream::from_vec(vec![hit((1, 1, 0, 7)), hit((1, 1, 0, 3)), hit((2, 5, 0, 1))])));
        assert_eq!(i.before((1, 1, 0, 5)).iter().map(|h| h.order_key).collect::<Vec<_>>(), vec![(1, 1, 0, 3)]);
        assert_eq!(i.at((1, 1, 0, 7)).len(), 1);
        assert!(!i.is_empty());
        assert_eq!(i.rest().len(), 1);
        assert!(i.is_empty());
        // Two streams merge by order, with a repeated span once.
        let a = CrossStream::from_vec(vec![hit((1, 1, 0, 2)), hit((1, 1, 0, 9))]);
        let b = CrossStream::from_vec(vec![hit((1, 1, 0, 2)), hit((1, 1, 0, 5))]);
        let merged = CrossStream::merged(vec![a, b]).unwrap().drain();
        assert_eq!(merged.iter().map(|h| h.order_key.3).collect::<Vec<_>>(), vec![2, 5, 9]);
        // No stream: nothing, at once.
        assert!(Interleave::new(None).is_empty());
    }
}
