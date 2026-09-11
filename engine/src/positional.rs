//! Tier-2 matching directly on Tantivy postings (compound index).
//!
//! `TermSetQuery`'s scorer is a `DocSet` without positions, so the query is
//! built by hand per segment: one `SegmentPostings` (with positions) for every
//! triple term of every query slot, each slot wrapped in a heap-based union
//! cursor. The N-way intersection is a leapfrog driven from the rarest slot;
//! positions are read only when every slot sits on the same doc, and a
//! `Matcher` decides whether the doc qualifies (pair within N tokens for
//! proximity, consecutive positions for phrases). No SQLite involved; cost is
//! proportional to the rarest slot's postings. Exact unless the wall-clock
//! budget or an explicit `stop_after` ends the scan early.

use crate::forward;
use std::collections::BinaryHeap;
use std::time::{Duration, Instant};
use tantivy::postings::{Postings, SegmentPostings};
use tantivy::query::{EnableScoring, Query, Scorer, TermSetQuery, Weight};
use tantivy::schema::{Field, IndexRecordOption, Term};
use tantivy::{DocAddress, DocId, DocSet, Searcher, TERMINATED};

/// Min-heap entry: (doc, cursor index) with reversed ordering.
#[derive(PartialEq, Eq)]
struct HeapEntry {
    doc: DocId,
    idx: usize,
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.doc.cmp(&self.doc).then_with(|| other.idx.cmp(&self.idx))
    }
}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Union of several posting cursors, positioned on the minimum current doc.
///
/// Cursors live in a min-heap keyed by their current doc, so `advance` and
/// `seek` touch only the cursors that actually move (O(m log k) for m moved
/// cursors) instead of scanning all k cursors per step — which for a root
/// with 2,000+ triples was the whole cost.
struct UnionCursor {
    heap: BinaryHeap<HeapEntry>,
    postings: Vec<SegmentPostings>,
    /// Indices (into `postings`) of the cursors sitting on the current doc.
    on_doc: Vec<usize>,
    doc: DocId,
    doc_freq: u64,
}

impl UnionCursor {
    fn new(postings: Vec<SegmentPostings>) -> Self {
        let doc_freq = postings.iter().map(|p| p.doc_freq() as u64).sum();
        let heap = postings
            .iter()
            .enumerate()
            .filter(|(_, p)| p.doc() != TERMINATED)
            .map(|(idx, p)| HeapEntry { doc: p.doc(), idx })
            .collect();
        let mut c = Self { heap, postings, on_doc: Vec::new(), doc: TERMINATED, doc_freq };
        c.settle();
        c
    }

    fn len(&self) -> usize {
        self.postings.len()
    }

    /// Pop every cursor at the heap minimum into `on_doc`; set `doc`.
    fn settle(&mut self) {
        self.on_doc.clear();
        let Some(top) = self.heap.peek() else {
            self.doc = TERMINATED;
            return;
        };
        let d = top.doc;
        while let Some(top) = self.heap.peek() {
            if top.doc != d {
                break;
            }
            let e = self.heap.pop().unwrap();
            self.on_doc.push(e.idx);
        }
        self.doc = d;
    }

    /// Re-insert the cursors that were on the previous doc.
    fn reinsert_on_doc(&mut self) {
        for &idx in &self.on_doc {
            let d = self.postings[idx].doc();
            if d != TERMINATED {
                self.heap.push(HeapEntry { doc: d, idx });
            }
        }
        self.on_doc.clear();
    }

    #[inline]
    fn doc(&self) -> DocId {
        self.doc
    }

    /// Move every cursor sitting on the current doc forward.
    fn advance(&mut self) -> DocId {
        for &idx in &self.on_doc {
            self.postings[idx].advance();
        }
        self.reinsert_on_doc();
        self.settle();
        self.doc
    }

    /// Seek every lagging cursor to `target` (or beyond).
    fn seek(&mut self, target: DocId) -> DocId {
        if self.doc >= target {
            return self.doc;
        }
        for &idx in &self.on_doc {
            self.postings[idx].seek(target);
        }
        self.reinsert_on_doc();
        while let Some(top) = self.heap.peek() {
            if top.doc >= target {
                break;
            }
            let e = self.heap.pop().unwrap();
            let d = self.postings[e.idx].seek(target);
            if d != TERMINATED {
                self.heap.push(HeapEntry { doc: d, idx: e.idx });
            }
        }
        self.settle();
        self.doc
    }

    /// Sorted, deduplicated positions of the current doc across all cursors on it.
    fn positions(&mut self, out: &mut Vec<u32>, buf: &mut Vec<u32>) {
        out.clear();
        for &idx in &self.on_doc {
            self.postings[idx].positions(buf);
            out.extend_from_slice(buf);
        }
        out.sort_unstable();
        out.dedup();
    }
}

/// One verified page: address plus the positions of all qualifying matches
/// (empty for counting-only hits before `full_positions_from`).
pub struct PositionalHit {
    pub addr: DocAddress,
    pub positions: Vec<u32>,
}

#[derive(Debug, Default, Clone)]
pub struct PositionalStats {
    /// Docs where every slot co-occurs (examined by the matcher).
    pub co_occurring: usize,
    pub hits: usize,
    /// Posting cursors opened per slot (summed over segments).
    pub cursors: Vec<usize>,
    /// Summed doc frequency per slot.
    pub doc_freqs: Vec<u64>,
    /// True when the budget or `stop_after` ended the scan before the end.
    pub budget_exhausted: bool,
    pub open_us: u64,
    pub intersect_us: u64,
    pub positions_us: u64,
}

/// Decides whether a co-occurring doc qualifies. Receives the sorted position
/// list of every slot and whether full positions are wanted; returns `None`
/// for no match, `Some(positions)` for a match (empty when not wanted).
pub type Matcher<'a> = &'a dyn Fn(&[Vec<u32>], bool) -> Option<Vec<u32>>;

/// N-way positional intersection, collecting form.
///
/// * `sets[k]` — triple ids for query slot k (already formatted by `term_of`).
/// * `filter` — optional filter query (book ids, fast-field ranges).
/// * `full_positions_from` — hits with index ≥ this get their full position
///   list; earlier hits are counting-only.
/// * `stop_after` — stop once this many hits are known (`offset + limit`);
///   `None` scans to the end for an exact count.
#[allow(clippy::too_many_arguments)]
pub fn intersect_n(
    searcher: &Searcher,
    field: Field,
    sets: &[Vec<u32>],
    term_of: &dyn Fn(u32) -> String,
    matcher: Matcher,
    filter: Option<&dyn Query>,
    full_positions_from: usize,
    stop_after: Option<usize>,
    budget: Duration,
) -> tantivy::Result<(Vec<PositionalHit>, PositionalStats)> {
    struct Collect {
        hits: Vec<PositionalHit>,
        full_positions_from: usize,
        stop_after: Option<usize>,
        start: Instant,
        budget: Duration,
        stopped: bool,
    }
    impl StreamSink for Collect {
        fn want_positions(&mut self, hits_so_far: usize) -> bool {
            hits_so_far >= self.full_positions_from
        }
        fn on_hit(&mut self, hit: PositionalHit) -> bool {
            self.hits.push(hit);
            if let Some(limit) = self.stop_after {
                if self.hits.len() >= limit {
                    self.stopped = true;
                    return false;
                }
            }
            true
        }
        fn tick(&mut self) -> bool {
            if self.start.elapsed() > self.budget {
                self.stopped = true;
                return false;
            }
            true
        }
    }
    let mut sink = Collect { hits: Vec::new(), full_positions_from, stop_after, start: Instant::now(), budget, stopped: false };
    let mut stats = intersect_n_stream(searcher, field, sets, term_of, matcher, filter, &mut sink)?;
    stats.budget_exhausted |= sink.stopped;
    Ok((sink.hits, stats))
}

/// Consumer of [`intersect_n_stream`]. `on_hit` receives every qualifying
/// doc in doc order and returns `false` to stop; `tick` is called every 4096
/// examined docs and also returns `false` to stop; `want_positions` says
/// whether the matcher should produce the full position list for the next
/// hit given the hits so far.
pub trait StreamSink {
    fn want_positions(&mut self, hits_so_far: usize) -> bool;
    fn on_hit(&mut self, hit: PositionalHit) -> bool;
    fn tick(&mut self) -> bool;
}

/// N-way positional intersection, streaming form.
pub fn intersect_n_stream(
    searcher: &Searcher,
    field: Field,
    sets: &[Vec<u32>],
    term_of: &dyn Fn(u32) -> String,
    matcher: Matcher,
    filter: Option<&dyn Query>,
    sink: &mut dyn StreamSink,
) -> tantivy::Result<PositionalStats> {
    let start = Instant::now();
    let n = sets.len();
    let mut stats = PositionalStats { cursors: vec![0; n], doc_freqs: vec![0; n], ..Default::default() };
    if n == 0 || sets.iter().any(|s| s.is_empty()) {
        return Ok(stats);
    }
    let filter_weight: Option<Box<dyn Weight>> = match filter {
        Some(q) => Some(q.weight(EnableScoring::disabled_from_searcher(searcher))?),
        None => None,
    };

    let mut slot_positions: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut buf: Vec<u32> = Vec::new();

    'segments: for (seg_ord, seg) in searcher.segment_readers().iter().enumerate() {
        let t_open = Instant::now();
        let inverted = seg.inverted_index(field)?;
        let mut cursors: Vec<UnionCursor> = Vec::with_capacity(n);
        for (k, ids) in sets.iter().enumerate() {
            let mut v = Vec::with_capacity(ids.len());
            for &t in ids {
                let term = Term::from_field_text(field, &term_of(t));
                if let Some(p) = inverted.read_postings(&term, IndexRecordOption::WithFreqsAndPositions)? {
                    v.push(p);
                }
            }
            let c = UnionCursor::new(v);
            stats.cursors[k] += c.len();
            stats.doc_freqs[k] += c.doc_freq;
            cursors.push(c);
        }
        let mut filter_set = match &filter_weight {
            Some(w) => Some(w.scorer(seg, 1.0)?),
            None => None,
        };
        stats.open_us += t_open.elapsed().as_micros() as u64;
        if cursors.iter().any(|c| c.len() == 0) {
            continue;
        }
        let alive = seg.alive_bitset();

        // Drive from the rarest slot.
        let driver = (0..n).min_by_key(|&k| cursors[k].doc_freq).unwrap();

        let mut checked = 0u32;
        'docs: loop {
            let d = cursors[driver].doc();
            if d == TERMINATED {
                break;
            }
            // Leapfrog: every other slot must reach d; otherwise re-target.
            let mut target = d;
            for k in 0..n {
                if k == driver {
                    continue;
                }
                let e = cursors[k].seek(target);
                if e == TERMINATED {
                    break 'docs;
                }
                if e != target {
                    target = e;
                    break;
                }
            }
            if target != d {
                cursors[driver].seek(target);
                continue;
            }
            // All slots on d.
            let live = alive.map_or(true, |bs| bs.is_alive(d));
            let passes_filter = match &mut filter_set {
                Some(f) => {
                    let fd = if f.doc() < d { f.seek(d) } else { f.doc() };
                    fd == d
                }
                None => true,
            };
            if live && passes_filter {
                stats.co_occurring += 1;
                let t_pos = Instant::now();
                for k in 0..n {
                    let (p, b) = (&mut slot_positions[k], &mut buf);
                    cursors[k].positions(p, b);
                }
                let want = sink.want_positions(stats.hits);
                let matched = matcher(&slot_positions, want);
                stats.positions_us += t_pos.elapsed().as_micros() as u64;
                if let Some(positions) = matched {
                    stats.hits += 1;
                    if !sink.on_hit(PositionalHit { addr: DocAddress::new(seg_ord as u32, d), positions }) {
                        stats.budget_exhausted = true;
                        break 'segments;
                    }
                }
            }
            cursors[driver].advance();

            checked += 1;
            if checked % 4096 == 0 && !sink.tick() {
                stats.budget_exhausted = true;
                break 'segments;
            }
        }
    }
    stats.intersect_us = (start.elapsed().as_micros() as u64).saturating_sub(stats.open_us + stats.positions_us);
    Ok(stats)
}

/// Proximity matcher: some position of slot 0 within `max_distance` of some
/// position of slot 1.
pub fn proximity_matcher(max_distance: u32) -> impl Fn(&[Vec<u32>], bool) -> Option<Vec<u32>> {
    move |p: &[Vec<u32>], want: bool| {
        let (a, b) = (&p[0], &p[1]);
        if !forward::has_pair_within(a, b, max_distance) {
            return None;
        }
        Some(if want { forward::proximity_positions(a, 1, b, 1, max_distance) } else { Vec::new() })
    }
}

/// Phrase matcher: slot k must occur at `start + k` for every k.
pub fn phrase_matcher() -> impl Fn(&[Vec<u32>], bool) -> Option<Vec<u32>> {
    move |p: &[Vec<u32>], want: bool| {
        let n = p.len() as u32;
        let mut found = false;
        let mut out: Vec<u32> = Vec::new();
        for &start in &p[0] {
            let ok = (1..n).all(|k| p[k as usize].binary_search(&(start + k)).is_ok());
            if ok {
                found = true;
                if !want {
                    return Some(Vec::new());
                }
                out.extend(start..start + n);
            }
        }
        if found {
            out.dedup();
            Some(out)
        } else {
            None
        }
    }
}

/// Two-slot proximity intersection (kept as the primary entry point).
#[allow(clippy::too_many_arguments)]
pub fn intersect(
    searcher: &Searcher,
    field: Field,
    set_a: &[u32],
    set_b: &[u32],
    term_of: &dyn Fn(u32) -> String,
    max_distance: u32,
    filter: Option<&dyn Query>,
    full_positions_from: usize,
    stop_after: Option<usize>,
    budget: Duration,
) -> tantivy::Result<(Vec<PositionalHit>, PositionalStats)> {
    let m = proximity_matcher(max_distance);
    intersect_n(
        searcher,
        field,
        &[set_a.to_vec(), set_b.to_vec()],
        term_of,
        &m,
        filter,
        full_positions_from,
        stop_after,
        budget,
    )
}

/// Exact phrase over triple-id sets (one set per position).
#[allow(clippy::too_many_arguments)]
pub fn intersect_phrase(
    searcher: &Searcher,
    field: Field,
    sets: &[Vec<u32>],
    term_of: &dyn Fn(u32) -> String,
    filter: Option<&dyn Query>,
    full_positions_from: usize,
    stop_after: Option<usize>,
    budget: Duration,
) -> tantivy::Result<(Vec<PositionalHit>, PositionalStats)> {
    let m = phrase_matcher();
    intersect_n(searcher, field, sets, term_of, &m, filter, full_positions_from, stop_after, budget)
}


// ---------------------------------------------------------------------------
// Hybrid: positional cursors for narrow slots, a bitset DocSet for wide ones
// ---------------------------------------------------------------------------

/// One phrase slot inside [`cooccurring_hybrid`].
enum Slot {
    /// Narrow slot: union of per-triple posting cursors, positions available.
    Cursor(UnionCursor),
    /// Wide slot: the `TermSetQuery` scorer for the slot. Tantivy builds it
    /// per segment by streaming the term dictionary through an FST of the
    /// slot's ids and OR-ing their `Basic` postings into one `BitSet`, so
    /// the cost is one pass over the postings and one bit per document,
    /// with no per-term cursor kept alive.
    Docs(Box<dyn Scorer>),
}

impl Slot {
    #[inline]
    fn doc(&self) -> DocId {
        match self {
            Slot::Cursor(c) => c.doc(),
            Slot::Docs(d) => d.doc(),
        }
    }

    #[inline]
    fn seek(&mut self, target: DocId) -> DocId {
        match self {
            Slot::Cursor(c) => c.seek(target),
            Slot::Docs(d) => {
                if d.doc() < target {
                    d.seek(target)
                } else {
                    d.doc()
                }
            }
        }
    }

    #[inline]
    fn advance(&mut self) -> DocId {
        match self {
            Slot::Cursor(c) => c.advance(),
            Slot::Docs(d) => d.advance(),
        }
    }

    /// Estimated number of docs: the cursors' summed doc_freq, or the
    /// bitset's size hint (its popcount).
    fn weight_estimate(&self) -> u64 {
        match self {
            Slot::Cursor(c) => c.doc_freq,
            Slot::Docs(d) => d.size_hint() as u64,
        }
    }
}

/// Result of [`cooccurring_hybrid`].
#[derive(Debug, Default)]
pub struct HybridCandidates {
    /// Docs where every slot occurs and the narrow slots are positionally
    /// consistent, in doc order, at most `cap` of them.
    pub candidates: Vec<DocAddress>,
    /// True when a further qualifying doc exists beyond `candidates` (the
    /// cap was reached) or the budget ended the scan.
    pub more: bool,
    /// Which slots were treated as wide (bitset) slots.
    pub wide: Vec<bool>,
    pub stats: PositionalStats,
}

/// Do the narrow slots' positions admit a common phrase start? Every narrow
/// slot `k` must have a position `start + k` for at least one `start`.
fn narrow_slots_consistent(positions: &[Vec<u32>], narrow: &[usize]) -> bool {
    let Some(&k0) = narrow.first() else { return true };
    if narrow.len() == 1 {
        return !positions[k0].is_empty();
    }
    positions[k0].iter().any(|&p| {
        let Some(start) = p.checked_sub(k0 as u32) else { return false };
        narrow[1..].iter().all(|&k| positions[k].binary_search(&(start + k as u32)).is_ok())
    })
}

/// Doc-level phrase candidates for slot sets where at least one slot is too
/// wide for positional cursors — collecting form (tests, diagnostics).
///
/// Slots with more than `threshold` ids become bitset DocSets (see
/// [`Slot::Docs`]); the rest stay union cursors. The leapfrog runs from the
/// slot with the fewest docs. On a co-occurring doc the narrow slots are
/// checked for a consistent phrase start; the wide slots carry no positions,
/// so the caller must verify adjacency on the forward index. Candidates are
/// returned in doc order, capped at `cap`; `more` says whether the count is
/// a lower bound.
#[allow(clippy::too_many_arguments)]
pub fn cooccurring_hybrid(
    searcher: &Searcher,
    field: Field,
    sets: &[Vec<u32>],
    term_of: &dyn Fn(u32) -> String,
    threshold: usize,
    filter: Option<&dyn Query>,
    cap: usize,
    budget: Duration,
) -> tantivy::Result<HybridCandidates> {
    let start = Instant::now();
    let mut candidates: Vec<DocAddress> = Vec::new();
    let mut more = false;
    let (wide, stats) = {
        let mut on_chunk = |chunk: &[DocAddress]| -> tantivy::Result<bool> {
            for &a in chunk {
                if candidates.len() >= cap {
                    more = true;
                    return Ok(false);
                }
                candidates.push(a);
            }
            if start.elapsed() > budget {
                more = true;
                return Ok(false);
            }
            Ok(true)
        };
        cooccurring_hybrid_stream(searcher, field, sets, term_of, threshold, filter, 1, &mut on_chunk)?
    };
    let mut stats = stats;
    if more && start.elapsed() > budget {
        stats.budget_exhausted = true;
    }
    Ok(HybridCandidates { candidates, more, wide, stats })
}

/// Streaming form of [`cooccurring_hybrid`]: qualifying docs are handed to
/// `on_chunk` in doc order, `chunk_size` at a time (the last chunk may be
/// shorter); it returns `false` to stop the scan. Returns which slots were
/// wide and the scan statistics.
#[allow(clippy::too_many_arguments)]
pub fn cooccurring_hybrid_stream(
    searcher: &Searcher,
    field: Field,
    sets: &[Vec<u32>],
    term_of: &dyn Fn(u32) -> String,
    threshold: usize,
    filter: Option<&dyn Query>,
    chunk_size: usize,
    on_chunk: &mut dyn FnMut(&[DocAddress]) -> tantivy::Result<bool>,
) -> tantivy::Result<(Vec<bool>, PositionalStats)> {
    let start = Instant::now();
    let n = sets.len();
    let chunk_size = chunk_size.max(1);
    let mut out = HybridCandidates {
        wide: sets.iter().map(|s| s.len() > threshold).collect(),
        stats: PositionalStats { cursors: vec![0; n], doc_freqs: vec![0; n], ..Default::default() },
        ..Default::default()
    };
    if n == 0 || sets.iter().any(|s| s.is_empty()) {
        return Ok((out.wide, out.stats));
    }
    let mut chunk: Vec<DocAddress> = Vec::with_capacity(chunk_size);
    let narrow: Vec<usize> = (0..n).filter(|&k| !out.wide[k]).collect();
    let filter_weight: Option<Box<dyn Weight>> = match filter {
        Some(q) => Some(q.weight(EnableScoring::disabled_from_searcher(searcher))?),
        None => None,
    };
    // One TermSetQuery weight per wide slot, built once: the FST of the
    // slot's terms lives in the weight, the bitset is per segment.
    let t_build = Instant::now();
    let wide_weights: Vec<Option<Box<dyn Weight>>> = sets
        .iter()
        .enumerate()
        .map(|(k, ids)| -> tantivy::Result<Option<Box<dyn Weight>>> {
            if !out.wide[k] {
                return Ok(None);
            }
            let q = TermSetQuery::new(ids.iter().map(|&t| Term::from_field_text(field, &term_of(t))));
            Ok(Some(q.weight(EnableScoring::disabled_from_searcher(searcher))?))
        })
        .collect::<tantivy::Result<_>>()?;
    out.stats.open_us += t_build.elapsed().as_micros() as u64;

    let mut slot_positions: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut buf: Vec<u32> = Vec::new();

    'segments: for (seg_ord, seg) in searcher.segment_readers().iter().enumerate() {
        let t_open = Instant::now();
        let inverted = seg.inverted_index(field)?;
        let mut slots: Vec<Slot> = Vec::with_capacity(n);
        for (k, ids) in sets.iter().enumerate() {
            if let Some(w) = &wide_weights[k] {
                let scorer = w.scorer(seg, 1.0)?;
                out.stats.doc_freqs[k] += scorer.size_hint() as u64;
                slots.push(Slot::Docs(scorer));
                continue;
            }
            let mut v = Vec::with_capacity(ids.len());
            for &t in ids {
                let term = Term::from_field_text(field, &term_of(t));
                if let Some(p) = inverted.read_postings(&term, IndexRecordOption::WithFreqsAndPositions)? {
                    v.push(p);
                }
            }
            let c = UnionCursor::new(v);
            out.stats.cursors[k] += c.len();
            out.stats.doc_freqs[k] += c.doc_freq;
            slots.push(Slot::Cursor(c));
        }
        let mut filter_set = match &filter_weight {
            Some(w) => Some(w.scorer(seg, 1.0)?),
            None => None,
        };
        out.stats.open_us += t_open.elapsed().as_micros() as u64;
        if slots.iter().any(|s| s.doc() == TERMINATED) {
            continue;
        }
        let alive = seg.alive_bitset();
        // Rarest slot drives; on a tie prefer a positional slot.
        let driver = (0..n).min_by_key(|&k| (slots[k].weight_estimate(), out.wide[k])).unwrap();

        let mut checked = 0u32;
        'docs: loop {
            let d = slots[driver].doc();
            if d == TERMINATED {
                break;
            }
            let mut target = d;
            for k in 0..n {
                if k == driver {
                    continue;
                }
                let e = slots[k].seek(target);
                if e == TERMINATED {
                    break 'docs;
                }
                if e != target {
                    target = e;
                    break;
                }
            }
            if target != d {
                slots[driver].seek(target);
                continue;
            }
            let live = alive.map_or(true, |bs| bs.is_alive(d));
            let passes_filter = match &mut filter_set {
                Some(f) => {
                    let fd = if f.doc() < d { f.seek(d) } else { f.doc() };
                    fd == d
                }
                None => true,
            };
            if live && passes_filter {
                let t_pos = Instant::now();
                for &k in &narrow {
                    if let Slot::Cursor(c) = &mut slots[k] {
                        let (p, b) = (&mut slot_positions[k], &mut buf);
                        c.positions(p, b);
                    }
                }
                let ok = narrow_slots_consistent(&slot_positions, &narrow);
                out.stats.positions_us += t_pos.elapsed().as_micros() as u64;
                if ok {
                    out.stats.co_occurring += 1;
                    out.stats.hits += 1;
                    chunk.push(DocAddress::new(seg_ord as u32, d));
                    if chunk.len() >= chunk_size {
                        let go = on_chunk(&chunk)?;
                        chunk.clear();
                        if !go {
                            out.more = true;
                            break 'segments;
                        }
                    }
                }
            }
            slots[driver].advance();

            checked += 1;
            if checked % 4096 == 0 && chunk.is_empty() && chunk_size > 1 {
                // Give the consumer a chance to check its budget on barren stretches.
                if !on_chunk(&[])? {
                    out.more = true;
                    break 'segments;
                }
            }
        }
    }
    if !chunk.is_empty() && !out.more {
        on_chunk(&chunk)?;
    }
    out.stats.intersect_us =
        (start.elapsed().as_micros() as u64).saturating_sub(out.stats.open_us + out.stats.positions_us);
    Ok((out.wide, out.stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tantivy::schema::{Schema, TextFieldIndexing, TextOptions, FAST, INDEXED, STORED};
    use tantivy::{doc, Index, IndexWriter};

    fn tok(id: u32) -> String {
        format!("{:07}", id)
    }

    fn build() -> (Index, Field, Vec<Vec<u32>>) {
        let mut sb = Schema::builder();
        let text_id = sb.add_u64_field("text_id", INDEXED | FAST | STORED);
        let page_id = sb.add_u64_field("page_id", INDEXED | FAST | STORED);
        let opts = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("whitespace")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        );
        let tokens = sb.add_text_field("tokens", opts);
        let index = Index::create_in_ram(sb.build());
        index.tokenizers().register("whitespace", tantivy::tokenizer::WhitespaceTokenizer::default());

        let mut seed = 12345u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as u32
        };
        let mut pages: Vec<Vec<u32>> = Vec::new();
        for _ in 0..600 {
            let len = 5 + (rnd() % 40) as usize;
            pages.push((0..len).map(|_| 1 + rnd() % 12).collect());
        }
        let mut w: IndexWriter = index.writer_with_num_threads(1, 20_000_000).unwrap();
        for (i, p) in pages.iter().enumerate() {
            let text: Vec<String> = p.iter().map(|&t| tok(t)).collect();
            w.add_document(doc!(text_id => 1u64, page_id => i as u64, tokens => text.join(" "))).unwrap();
        }
        w.commit().unwrap();
        (index, tokens, pages)
    }

    #[test]
    fn proximity_parity_with_forward_scan() {
        let (index, tokens, pages) = build();
        let reader = index.reader().unwrap();
        let searcher = reader.searcher();
        let set_a = vec![1u32, 2];
        let set_b = vec![7u32];
        let d = 3u32;
        let sa: HashSet<u32> = set_a.iter().copied().collect();
        let sb_: HashSet<u32> = set_b.iter().copied().collect();

        let mut expected: Vec<(u32, Vec<u32>)> = Vec::new();
        for (i, p) in pages.iter().enumerate() {
            let a = forward::member_positions(p, &sa);
            let b = forward::member_positions(p, &sb_);
            let m = forward::proximity_positions(&a, 1, &b, 1, d);
            if !m.is_empty() {
                expected.push((i as u32, m));
            }
        }
        assert!(expected.len() > 10);

        let (hits, stats) =
            intersect(&searcher, tokens, &set_a, &set_b, &tok, d, None, 0, None, Duration::from_secs(10)).unwrap();
        assert!(!stats.budget_exhausted);
        assert_eq!(hits.len(), expected.len());
        for (h, (doc, m)) in hits.iter().zip(expected.iter()) {
            assert_eq!(h.addr.doc_id, *doc);
            assert_eq!(&h.positions, m);
        }

        let (hits2, _) =
            intersect(&searcher, tokens, &set_a, &set_b, &tok, d, None, 5, Some(8), Duration::from_secs(10)).unwrap();
        assert_eq!(hits2.len(), 8);
        assert!(hits2[..5].iter().all(|h| h.positions.is_empty()));
        assert!(hits2[5..].iter().all(|h| !h.positions.is_empty()));

        let (hits3, _) =
            intersect(&searcher, tokens, &set_b, &set_a, &tok, d, None, 0, None, Duration::from_secs(10)).unwrap();
        assert_eq!(hits3.len(), expected.len());
        for (h, (doc, m)) in hits3.iter().zip(expected.iter()) {
            assert_eq!(h.addr.doc_id, *doc);
            assert_eq!(&h.positions, m);
        }
    }

    #[test]
    fn phrase_parity_with_forward_scan() {
        let (index, tokens, pages) = build();
        let reader = index.reader().unwrap();
        let searcher = reader.searcher();
        // three-slot phrase with alternatives in each slot
        let sets: Vec<Vec<u32>> = vec![vec![1, 2, 3], vec![4, 5], vec![6, 7, 8, 9]];
        let hsets: Vec<HashSet<u32>> = sets.iter().map(|s| s.iter().copied().collect()).collect();
        let mut expected: Vec<(u32, Vec<u32>)> = Vec::new();
        for (i, p) in pages.iter().enumerate() {
            let m = forward::phrase_positions(p, &hsets);
            if !m.is_empty() {
                expected.push((i as u32, m));
            }
        }
        assert!(expected.len() > 5, "sparse: {}", expected.len());
        let (hits, stats) =
            intersect_phrase(&searcher, tokens, &sets, &tok, None, 0, None, Duration::from_secs(10)).unwrap();
        assert!(!stats.budget_exhausted);
        assert_eq!(hits.len(), expected.len());
        for (h, (doc, m)) in hits.iter().zip(expected.iter()) {
            assert_eq!(h.addr.doc_id, *doc);
            assert_eq!(&h.positions, m);
        }
    }
    /// Hybrid candidates with slot 2 forced wide: the candidate list must be
    /// exactly the docs where the narrow slots admit a common start and the
    /// wide slot occurs somewhere, hence a superset of the exact phrase hits,
    /// and forward-index verification of the candidates must give back the
    /// exact hits.
    #[test]
    fn hybrid_candidates_superset_and_verified_parity() {
        let (index, tokens, pages) = build();
        let reader = index.reader().unwrap();
        let searcher = reader.searcher();
        let sets: Vec<Vec<u32>> = vec![vec![1, 2, 3], vec![4, 5], vec![6, 7, 8, 9]];
        let hsets: Vec<HashSet<u32>> = sets.iter().map(|s| s.iter().copied().collect()).collect();
        let exact: Vec<u32> = pages
            .iter()
            .enumerate()
            .filter(|(_, p)| !forward::phrase_starts(p, &hsets).is_empty())
            .map(|(i, _)| i as u32)
            .collect();
        assert!(exact.len() > 5);

        // threshold 3: slot 2 (4 ids) is wide, slots 0 and 1 stay positional.
        let out =
            cooccurring_hybrid(&searcher, tokens, &sets, &tok, 3, None, usize::MAX, Duration::from_secs(10)).unwrap();
        assert_eq!(out.wide, vec![false, false, true]);
        assert!(!out.more);
        let cands: Vec<u32> = out.candidates.iter().map(|a| a.doc_id).collect();
        assert!(cands.windows(2).all(|w| w[0] < w[1]), "doc order");
        for d in &exact {
            assert!(cands.contains(d), "exact hit {} missing from candidates", d);
        }
        let s2: HashSet<u32> = sets[2].iter().copied().collect();
        let expected_cands: Vec<u32> = pages
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                let starts01 = forward::phrase_starts(p, &hsets[..2]);
                !starts01.is_empty() && p.iter().any(|id| s2.contains(id))
            })
            .map(|(i, _)| i as u32)
            .collect();
        assert_eq!(cands, expected_cands);
        let verified: Vec<u32> = cands
            .iter()
            .copied()
            .filter(|&d| !forward::phrase_starts(&pages[d as usize], &hsets).is_empty())
            .collect();
        assert_eq!(verified, exact);

        // Cap: exactly `cap` candidates and `more` set.
        let capped = cooccurring_hybrid(&searcher, tokens, &sets, &tok, 3, None, 3, Duration::from_secs(10)).unwrap();
        assert_eq!(capped.candidates.len(), 3);
        assert!(capped.more);
        assert_eq!(capped.candidates.iter().map(|a| a.doc_id).collect::<Vec<_>>(), cands[..3].to_vec());

        // Every slot wide: pure bitset intersection, still a superset.
        let all_wide =
            cooccurring_hybrid(&searcher, tokens, &sets, &tok, 0, None, usize::MAX, Duration::from_secs(10)).unwrap();
        assert_eq!(all_wide.wide, vec![true, true, true]);
        let aw: Vec<u32> = all_wide.candidates.iter().map(|a| a.doc_id).collect();
        for d in &exact {
            assert!(aw.contains(d));
        }
        assert!(aw.len() >= cands.len());
    }
}
