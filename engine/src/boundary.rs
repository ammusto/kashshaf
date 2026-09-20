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
//! Absent beside the main index (an older corpus), everything here is off
//! and the engine behaves as before.
//!
//! Attribution: the primary page is the one holding more of the match, ties
//! to the earlier page — the left page iff `s + e <= 39` for a span `s..=e`,
//! and the same test on the two positions of a proximity pair. Positions map
//! back to page coordinates with the stored left page length: on the left
//! page, `page_len_left - 20 + pos`; on the right, `pos - 20`.

use crate::positional::{intersect_n_stream, PositionalHit, StreamSink};
use crate::search::SearchFilters;
use crate::tokens::PageKey;
use crate::triples::triple_term;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
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
#[derive(Debug, Clone, Copy)]
pub enum MatchKind {
    /// Consecutive slots, one per word.
    Phrase,
    /// Two sides of `len1` and `len2` consecutive slots within `max_distance`
    /// of each other, measured between the sides' first words.
    Proximity { len1: usize, len2: usize, max_distance: u32 },
}

/// How far a boundary scan goes.
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_hits: Option<usize>,
    pub budget: Option<Duration>,
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
fn decide(kind: MatchKind, slots: &[Vec<u32>]) -> Option<(Vec<u32>, Attribution)> {
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
        MatchKind::Proximity { len1, len2, max_distance } => {
            let starts1 = phrase_starts(&slots[..len1]);
            let starts2 = phrase_starts(&slots[len1..]);
            let (l1, l2) = (len1 as u32, len2 as u32);
            let mut out: Vec<u32> = Vec::new();
            let mut attr: Option<Attribution> = None;
            for &p in &starts1 {
                for &q in &starts2 {
                    if p.abs_diff(q) > max_distance {
                        continue;
                    }
                    // One side before the midpoint, the other at or past it.
                    if (p < SIDE) == (q < SIDE) {
                        continue;
                    }
                    let (s, e) = (p.min(q), p.max(q));
                    if attr.is_none() {
                        attr = Some(Attribution { start: s, end: e, primary_is_left: left_owns(s, e) });
                    }
                    out.extend(p..(p + l1).min(WIDTH));
                    out.extend(q..(q + l2).min(WIDTH));
                }
            }
            let attr = attr?;
            out.sort_unstable();
            out.dedup();
            Some((out, attr))
        }
    }
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
                eprintln!(
                    "[boundary] {} documents, corpus {} ({})",
                    b.meta.documents,
                    b.meta.corpus_version,
                    dir.display()
                );
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

    /// Every straddling match of `sets` in reading order, mapped to pages.
    /// `sets` are the query's slots as triple ids, exactly as for the main
    /// index. Stops at `limits`; the second value says whether it did.
    pub fn cross_hits(&self, kind: MatchKind, sets: &[Vec<u32>], filters: &SearchFilters, limits: ScanLimits) -> Result<(Vec<CrossHit>, bool)> {
        if sets.is_empty() || sets.iter().any(|s| s.is_empty()) {
            return Ok((Vec::new(), false));
        }
        let searcher = self.reader.searcher();
        let filter = self.filter_query(filters);
        let attribution: RefCell<Option<Attribution>> = RefCell::new(None);
        let matcher = |slots: &[Vec<u32>], _want: bool| -> Option<Vec<u32>> {
            let (positions, attr) = decide(kind, slots)?;
            *attribution.borrow_mut() = Some(attr);
            Some(positions)
        };
        let mut sink = Collect {
            hits: Vec::new(),
            attribution: &attribution,
            columns: Columns::open(&searcher, 0, self.fields)?,
            start: Instant::now(),
            limits,
            stopped: false,
        };
        intersect_n_stream(&searcher, self.fields.tokens, sets, &triple_term, &matcher, filter.as_deref(), &mut sink)?;
        Ok((sink.hits, sink.stopped))
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

struct Collect<'a> {
    hits: Vec<CrossHit>,
    attribution: &'a RefCell<Option<Attribution>>,
    columns: Columns,
    start: Instant,
    limits: ScanLimits,
    stopped: bool,
}

impl StreamSink for Collect<'_> {
    fn want_positions(&mut self, _hits_so_far: usize) -> bool {
        true
    }

    fn on_hit(&mut self, hit: PositionalHit) -> bool {
        let Some(attr) = self.attribution.borrow_mut().take() else { return true };
        let d = hit.addr.doc_id;
        let c = &self.columns;
        let page_len_l = c.page_len_l.first(d).unwrap_or(SIDE as u64) as u32;
        let (left_pos, right_pos) = split_positions(&hit.positions, page_len_l);
        let left = c.left_key(d);
        let right = c.right_key(d);
        let death = c.death.as_ref().and_then(|x| x.first(d)).unwrap_or(u64::MAX);
        let (primary, primary_positions, secondary, secondary_positions) = if attr.primary_is_left {
            (left, left_pos, right, right_pos)
        } else {
            (right, right_pos, left, left_pos)
        };
        self.hits.push(CrossHit {
            order_key: (death, primary.id, primary.part_index, primary.page_id),
            primary,
            primary_positions,
            secondary,
            secondary_positions,
            primary_is_left: attr.primary_is_left,
        });
        if let Some(max) = self.limits.max_hits {
            if self.hits.len() >= max {
                self.stopped = true;
                return false;
            }
        }
        true
    }

    fn tick(&mut self) -> bool {
        if let Some(b) = self.limits.budget {
            if self.start.elapsed() > b {
                self.stopped = true;
                return false;
            }
        }
        true
    }
}

/// Cross hits interleaved into a stream of main-index hits by reading-order
/// key: the pages before a main hit go before it, the same page after it.
pub struct Interleave {
    hits: Vec<CrossHit>,
    next: usize,
}

impl Interleave {
    pub fn new(mut hits: Vec<CrossHit>) -> Self {
        hits.sort_by(|a, b| a.order_key.cmp(&b.order_key));
        Self { hits, next: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.next >= self.hits.len()
    }

    /// Cross hits ordered strictly before `key`.
    pub fn before(&mut self, key: OrderKey) -> impl Iterator<Item = &CrossHit> + '_ {
        let start = self.next;
        while self.next < self.hits.len() && self.hits[self.next].order_key < key {
            self.next += 1;
        }
        self.hits[start..self.next].iter()
    }

    /// Cross hits on the same page as `key`.
    pub fn at(&mut self, key: OrderKey) -> impl Iterator<Item = &CrossHit> + '_ {
        let start = self.next;
        while self.next < self.hits.len() && self.hits[self.next].order_key == key {
            self.next += 1;
        }
        self.hits[start..self.next].iter()
    }

    /// Everything left.
    pub fn rest(&mut self) -> impl Iterator<Item = &CrossHit> + '_ {
        let start = self.next;
        self.next = self.hits.len();
        self.hits[start..].iter()
    }

    pub fn remaining(&self) -> usize {
        self.hits.len() - self.next
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

    fn slots(pos: &[&[u32]]) -> Vec<Vec<u32>> {
        pos.iter().map(|p| p.to_vec()).collect()
    }

    #[test]
    fn a_phrase_split_seven_two_belongs_to_the_left_page() {
        // Nine words: seven on the left (13..=19), two on the right (20, 21).
        let s: Vec<Vec<u32>> = (0..9).map(|k| vec![13 + k]).collect();
        let (positions, attr) = decide(MatchKind::Phrase, &s).unwrap();
        assert_eq!(positions, (13..=21).collect::<Vec<_>>());
        assert!(attr.primary_is_left);
        let (l, r) = split_positions(&positions, 20);
        assert_eq!(l, (13..=19).collect::<Vec<_>>());
        assert_eq!(r, vec![0, 1]);
    }

    #[test]
    fn a_phrase_split_two_seven_belongs_to_the_right_page() {
        let s: Vec<Vec<u32>> = (0..9).map(|k| vec![18 + k]).collect();
        let (_, attr) = decide(MatchKind::Phrase, &s).unwrap();
        assert!(!attr.primary_is_left);
    }

    #[test]
    fn an_even_split_goes_to_the_earlier_page() {
        let s: Vec<Vec<u32>> = (0..8).map(|k| vec![16 + k]).collect();
        let (_, attr) = decide(MatchKind::Phrase, &s).unwrap();
        assert!(attr.primary_is_left, "16 + 23 = 39: the left page");
    }

    #[test]
    fn a_phrase_wholly_on_one_side_is_the_main_index_s() {
        let left: Vec<Vec<u32>> = (0..3).map(|k| vec![5 + k]).collect();
        assert!(decide(MatchKind::Phrase, &left).is_none());
        let right: Vec<Vec<u32>> = (0..3).map(|k| vec![20 + k]).collect();
        assert!(decide(MatchKind::Phrase, &right).is_none());
        // Ending exactly on the last left token: not a straddle either.
        let edge: Vec<Vec<u32>> = (0..3).map(|k| vec![17 + k]).collect();
        assert!(decide(MatchKind::Phrase, &edge).is_none());
        // Starting at the midpoint: the right page has it.
        let at: Vec<Vec<u32>> = (0..2).map(|k| vec![20 + k]).collect();
        assert!(decide(MatchKind::Phrase, &at).is_none());
    }

    #[test]
    fn proximity_needs_one_term_on_each_side() {
        let both_left = slots(&[&[3], &[7]]);
        assert!(decide(MatchKind::Proximity { len1: 1, len2: 1, max_distance: 10 }, &both_left).is_none());
        let both_right = slots(&[&[22], &[25]]);
        assert!(decide(MatchKind::Proximity { len1: 1, len2: 1, max_distance: 10 }, &both_right).is_none());
        let across = slots(&[&[17], &[24]]);
        let (positions, attr) = decide(MatchKind::Proximity { len1: 1, len2: 1, max_distance: 10 }, &across).unwrap();
        assert_eq!(positions, vec![17, 24]);
        assert!(!attr.primary_is_left, "17 + 24 = 41: the right page");
        let too_far = slots(&[&[10], &[24]]);
        assert!(decide(MatchKind::Proximity { len1: 1, len2: 1, max_distance: 10 }, &too_far).is_none());
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
    fn interleave_places_cross_hits_by_reading_order() {
        let hit = |key: OrderKey| CrossHit {
            order_key: key,
            primary: PageKey::new(key.1, key.2, key.3),
            primary_positions: vec![0],
            secondary: PageKey::new(key.1, key.2, key.3 + 1),
            secondary_positions: vec![0],
            primary_is_left: true,
        };
        let mut i = Interleave::new(vec![hit((1, 1, 0, 7)), hit((1, 1, 0, 3)), hit((2, 5, 0, 1))]);
        assert_eq!(i.before((1, 1, 0, 5)).map(|h| h.order_key).collect::<Vec<_>>(), vec![(1, 1, 0, 3)]);
        assert_eq!(i.at((1, 1, 0, 7)).count(), 1);
        assert_eq!(i.remaining(), 1);
        assert_eq!(i.rest().count(), 1);
        assert!(i.is_empty());
    }
}
