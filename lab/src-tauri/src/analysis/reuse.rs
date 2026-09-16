//! Text reuse (Lab spec §4.3).
//!
//! Pure functions over token sequences: banality by corpus lemma rank,
//! anchor selection, candidate retrieval through `BookSource::find_pages`,
//! local alignment (Smith–Waterman with affine gaps) on lemma ids with a
//! root fallback, proximity-mode merging, three-layer scoring and type
//! assignment. Every threshold is a field of [`Params`] with the §4.3
//! default; the commands layer only adds storage, progress and cancel.
//!
//! Three readings of the spec are fixed here and worth knowing:
//!
//! - **The banality penalty is measured against the corpus baseline.** §4.3
//!   writes `banality_factor = 1 − min(1, banal_share / banality_scale)` with
//!   `banal_share` the banal fraction of the aligned region. Measured on the
//!   sample corpus (`tests/banality_probe.rs`), the top-300 lemmas are 61.9%
//!   of running text and the median page is 60% banal, so that formula gives
//!   factor 0 — "formulaic", score 0 — to ordinary prose. The share is
//!   therefore taken *in excess of* the corpus share of the top
//!   `banality_rank` lemmas (`Params::banality_baseline`, derived from the
//!   frequency table by [`corpus_banal_share`]): a region as banal as the
//!   corpus is not penalised; one made entirely of top-300 lemmas is.
//! - **Anchors are chosen by phrase document frequency** (amendment 1.4,
//!   fix 3), not by token banality: every lemma trigram of the passage is
//!   counted on the index — rarest-by-rank first, up to `count_budget` of
//!   them — and the `k` lowest non-zero counts are the anchors; token rank
//!   only breaks ties. A passage under `fallback_max_tokens` tokens, or one
//!   with no usable anchor, goes to the index whole: lemma phrase with
//!   `fallback_slop`, then surface phrase.
//! - **Banality is rank only by default.** A token is banal when its lemma
//!   rank in the corpus frequency table is ≤ `banality_rank`, or when it is
//!   covered by a phrase in `banal_phrases`. The shipped lexicon has no banal
//!   phrases (the isnād formula list is *not* used here), so out of the box the
//!   penalty is the rank alone — which is the claim §4.3 makes and the report
//!   measures.
//! - **`formulaic` is decided before `verbatim`.** A basmala is verbatim on
//!   every layer; if surface agreement were tested first the penalty would
//!   never show in the type. So `banality_factor < 0.3` wins, then the
//!   agreement rules in the spec's order, then `weak`.

use crate::source::{BookSource, CandidateQuery, FreqTable, Page, PageRef, Token};
#[cfg(test)]
use crate::source::Hits;
use anyhow::Result;
use kashshaf_engine::normalize_arabic;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;

/// How candidate pages are found.
///
/// The two differ only in retrieval. Alignment, scoring, typing and zones
/// are the same code on the same parameters either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RetrievalMode {
    /// Choose a handful of rare phrases and look them up on the index. The
    /// only thing that works against 5.7M pages, and the source of both
    /// standing failure modes: a passage whose window contributes no rare
    /// phrase shared with the other book is never retrieved, and the
    /// alignment floor has to be high because a short coincidence across
    /// seven thousand books is certain.
    #[default]
    Corpus,
    /// Read the target book into memory and look up *every* n-gram of the
    /// query window. Only available when the run names its target, because
    /// it costs one pass over that book and an index of it.
    ///
    /// Neither constraint above survives: nothing is selected, so nothing is
    /// missed for not being selected, and a four-token coincidence between
    /// two books is not the same claim as one across the corpus.
    Exhaustive,
}

/// One key length and what it is allowed to spend.
///
/// `df_cap` has to come down as `gram` does: a bigram is commoner than the
/// trigrams inside it, so the ceiling that keeps a trigram retrievable lets
/// far too much through for a bigram.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnchorSlot {
    pub gram: usize,
    pub anchors: usize,
    pub df_cap: usize,
}

/// Everything §4.3 lets the user set, with its default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Params {
    /// Lemma rank at or below which a token is banal (300).
    pub banality_rank: u32,
    /// Anchors per passage (6), never fewer than `min_anchors` (3) when the
    /// passage has that many non-banal trigrams.
    pub anchors: usize,
    pub min_anchors: usize,
    /// Anchor hits a page needs to be a candidate (2; 1 when the passage has
    /// fewer than `small_passage` non-banal tokens).
    pub anchor_hits: usize,
    pub small_passage: usize,
    /// Candidate cap (500), keeping the highest hit counts.
    pub max_candidates: usize,
    pub gap_open: i32,
    pub gap_extend: i32,
    pub match_lemma: i32,
    pub match_root: i32,
    pub mismatch: i32,
    pub proximity: bool,
    pub proximity_window: usize,
    /// Aligned pairs a match needs (6).
    pub min_aligned: usize,
    pub w_lemma: f64,
    pub w_root: f64,
    pub w_surface: f64,
    pub banality_scale: f64,
    /// Corpus share of the top `banality_rank` lemmas, subtracted from a
    /// region's banal share before the penalty (see the module header).
    /// `None` means 0 — the spec's formula as written — and the commands fill
    /// it from the frequency table at the start of a run.
    pub banality_baseline: Option<f64>,
    /// Display threshold on `score` (0.35). Matches below it are still
    /// returned and stored so the UI can lower the bar without re-running.
    pub threshold: f64,
    /// Tokens inside a Qurʾān or isnād zone are not used as anchors. Off by
    /// default since anchors are chosen by document frequency (amendment
    /// 1.4): a Qurʾānic trigram that hundreds of pages quote sorts itself
    /// last, and a passage that is mostly Qurʾān still retrieves.
    pub exclude_zones_from_anchoring: bool,
    /// Trigrams whose document frequency is looked up per passage (24),
    /// rarest-by-rank first.
    pub count_budget: usize,
    /// Passages shorter than this (12) go to the index whole.
    pub fallback_max_tokens: usize,
    /// Slop of the whole-passage lemma phrase (2).
    pub fallback_slop: u32,
    /// One hit on an anchor this rare (document frequency ≤ 50) makes a
    /// page a candidate by itself; commoner anchors need `anchor_hits`.
    pub rare_df: usize,
    /// Book mode (§4.3 batch): window and stride in tokens.
    pub window: usize,
    pub stride: usize,
    /// How an anchor is built and matched (the three strategies of the
    /// retrieval study).
    ///
    /// `anchor_gram` is the length of the lemma n-gram, 3 by default.
    /// `anchor_slop` is the leniency allowed between its words; 0 is an
    /// exact phrase. `anchor_df_cap` is the document frequency above which a
    /// candidate anchor is discarded -- it has to come down as the n-gram
    /// gets shorter, because a bigram is commoner than a trigram and a lemma
    /// commoner still. `anchor_skip`, when non-zero, abandons n-grams
    /// altogether: the rarest lemmas of the window are paired and a page
    /// counts if it holds both within that many tokens.
    pub anchor_gram: usize,
    pub anchor_slop: u32,
    pub anchor_df_cap: usize,
    pub anchor_skip: u32,
    /// Books the run may match against; empty is the whole corpus. Applied
    /// at the index, so a pairwise run reads only the target's pages.
    /// Document frequency is still counted corpus-wide: how banal a phrase
    /// is does not depend on which book you are asking about.
    pub target_books: Vec<u64>,
    /// The type table's four cutoffs (§4.3), in the order they are asked:
    /// below `type_formulaic` banality the match is formulaic, then
    /// `type_verbatim` surface agreement, `type_inflected` lemma agreement,
    /// `type_paraphrase` root agreement, else weak.
    ///
    /// They decide every match's type and nothing else reads them, so a
    /// question like "why is this pair 14% paraphrase where that one is 5%"
    /// is a question about these four numbers.
    pub type_formulaic: f64,
    pub type_verbatim: f64,
    pub type_inflected: f64,
    pub type_paraphrase: f64,
    /// Corpus or exhaustive retrieval; see [`RetrievalMode`]. Exhaustive is
    /// refused unless `target_books` names at most `exhaustive_max_books`.
    pub retrieval: RetrievalMode,
    /// Books a pairwise run may index in memory (4).
    ///
    /// The index is every lemma bigram and trigram of every page, so it is
    /// linear in the text: a few hundred pages is nothing, a hundred books
    /// is a corpus and the point of the mode has gone.
    pub exhaustive_max_books: usize,
    /// Which n-gram lengths the exhaustive index holds (2 and 3).
    pub exhaustive_grams: Vec<usize>,
    /// Candidate pages kept per window in exhaustive mode (200).
    ///
    /// Every page sharing one n-gram is a candidate, which for a common
    /// bigram is most of a book, so they are ranked by how many n-grams they
    /// share and cut. This is a bound on work, not a claim about relevance:
    /// a real parallel shares many.
    pub exhaustive_max_candidates: usize,
    /// The aligned floor in exhaustive mode (4), against `min_aligned`'s 6.
    pub exhaustive_min_aligned: usize,
    /// Extractor confidence at which a chain becomes an isnād zone (0.5).
    ///
    /// The confidence formula scores `min(links, 5) / 5` for length, so a
    /// two-link samāʿ chain -- the whole of ṭabaqāt and Sufi biography --
    /// tops out around 0.5 however clean it is. At the 0.6 both callers used
    /// to hardcode, those chains were found by the extractor and then
    /// dropped before they could become a zone, which is why reuse reported
    /// them as matches.
    pub isnad_zone_confidence: f64,
    /// Pages either side of a candidate page that the alignment may run
    /// over (1). A quotation that crosses a page break in the quoted book is
    /// one passage in that book and has to be one alignment here; a page is
    /// a printing accident, not a unit of composition. 0 restores the old
    /// behaviour, one page at a time.
    /// Anchor budget split by key length, in place of `anchors` on one
    /// key. Empty keeps the single key `anchor_gram` describes.
    ///
    /// A merged pool cannot do this: the pick sorts by document frequency
    /// ascending, and a trigram is always rarer than the bigrams inside it,
    /// so every slot would go to trigrams and the shorter key would never
    /// retrieve anything. The slots have to be reserved.
    pub anchor_slots: Vec<AnchorSlot>,
    pub target_neighbours: usize,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            banality_rank: 300,
            anchors: 6,
            min_anchors: 3,
            anchor_hits: 2,
            small_passage: 40,
            max_candidates: 500,
            gap_open: -3,
            gap_extend: -1,
            match_lemma: 2,
            match_root: 1,
            mismatch: -2,
            proximity: true,
            proximity_window: 40,
            min_aligned: 6,
            w_lemma: 0.5,
            w_root: 0.3,
            w_surface: 0.2,
            banality_scale: 0.5,
            banality_baseline: None,
            threshold: 0.35,
            exclude_zones_from_anchoring: false,
            count_budget: 24,
            fallback_max_tokens: 12,
            fallback_slop: 2,
            rare_df: 50,
            window: 60,
            stride: 30,
            anchor_gram: 3,
            anchor_slop: 0,
            anchor_df_cap: 0,
            anchor_skip: 0,
            // Six trigram anchors, as before, and four bigram ones on top.
            // Not four and four: the budget is the trigram budget, and
            // splitting it takes two anchors away from the key that works to
            // pay for the key that only helps sometimes, which measures
            // worse than leaving it alone. The second key is added, not
            // carved out. df_cap 0 means the old ceiling, max_candidates;
            // a bigram needs a much lower one because it is commoner.
            anchor_slots: vec![AnchorSlot { gram: 3, anchors: 6, df_cap: 0 }, AnchorSlot { gram: 2, anchors: 4, df_cap: 200 }],
            target_books: Vec::new(),
            retrieval: RetrievalMode::Corpus,
            exhaustive_max_books: 4,
            exhaustive_grams: vec![2, 3],
            exhaustive_max_candidates: 200,
            exhaustive_min_aligned: 4,
            type_formulaic: 0.3,
            type_verbatim: 0.9,
            type_inflected: 0.85,
            type_paraphrase: 0.7,
            isnad_zone_confidence: 0.5,
            target_neighbours: 1,
        }
    }
}

impl Params {
    /// The document-frequency ceiling for a candidate anchor.
    /// Whether this run reads the target book instead of querying for it.
    pub fn exhaustive(&self) -> bool {
        self.retrieval == RetrievalMode::Exhaustive
            && !self.target_books.is_empty()
            && self.target_books.len() <= self.exhaustive_max_books.max(1)
    }

    /// Aligned pairs a match needs, which is a different claim in each mode.
    pub fn aligned_floor(&self) -> usize {
        if self.exhaustive() { self.exhaustive_min_aligned.max(2) } else { self.min_aligned.max(1) }
    }

    /// The index-side book restriction, `None` for the whole corpus.
    pub fn book_filter(&self) -> Option<Vec<u64>> {
        if self.target_books.is_empty() { None } else { Some(self.target_books.clone()) }
    }

    pub fn df_cap(&self) -> usize {
        if self.anchor_df_cap > 0 { self.anchor_df_cap } else { self.max_candidates.max(1) }
    }
}

/// A span label from §4.2 / §4.4 carried into reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Quran,
    Isnad,
}

impl Zone {
    pub fn as_str(self) -> &'static str {
        match self {
            Zone::Quran => "quran",
            Zone::Isnad => "isnad",
        }
    }
}

/// Shared string → id table so the query and every candidate page compare
/// by integer.
#[derive(Default)]
pub struct Interner {
    map: HashMap<String, u32>,
}

impl Interner {
    pub fn id(&mut self, s: &str) -> u32 {
        let n = self.map.len() as u32;
        *self.map.entry(s.to_string()).or_insert(n)
    }

    /// The id of a string already interned, if any.
    pub fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// A token sequence on the three layers, with what §4.3's preprocessing adds.
#[derive(Debug, Clone, Default)]
pub struct Seq {
    pub lemma: Vec<Option<u32>>,
    pub root: Vec<Option<u32>>,
    pub surface: Vec<u32>,
    /// Corpus lemma rank; `u32::MAX` when the lemma is not in the table
    /// (rarer than anything ranked).
    pub rank: Vec<u32>,
    pub banal: Vec<bool>,
    pub zone: Vec<Option<Zone>>,
}

impl Seq {
    /// `zones` may be shorter than `tokens` (missing = no zone).
    pub fn build(
        tokens: &[Token],
        intern: &mut Interner,
        freq: &FreqTable,
        params: &Params,
        banal_phrases: &[Vec<String>],
        zones: &[Option<Zone>],
    ) -> Self {
        let n = tokens.len();
        let mut s = Seq {
            lemma: Vec::with_capacity(n),
            root: Vec::with_capacity(n),
            surface: Vec::with_capacity(n),
            rank: Vec::with_capacity(n),
            banal: vec![false; n],
            zone: (0..n).map(|i| zones.get(i).copied().flatten()).collect(),
        };
        let norm: Vec<String> = tokens.iter().map(|t| normalize_arabic(&t.surface)).collect();
        for (i, t) in tokens.iter().enumerate() {
            s.lemma.push(if t.lemma.is_empty() { None } else { Some(intern.id(&t.lemma)) });
            s.root.push(t.root.as_deref().filter(|r| !r.is_empty()).map(|r| intern.id(r)));
            s.surface.push(intern.id(&norm[i]));
            let rank = if t.lemma.is_empty() { u32::MAX } else { freq.get(&t.lemma).rank.unwrap_or(u32::MAX) };
            s.rank.push(rank);
            s.banal[i] = rank <= params.banality_rank;
        }
        for phrase in banal_phrases {
            if phrase.is_empty() || phrase.len() > n {
                continue;
            }
            for i in 0..=n - phrase.len() {
                if phrase.iter().zip(&norm[i..]).all(|(p, w)| p == w) {
                    for b in &mut s.banal[i..i + phrase.len()] {
                        *b = true;
                    }
                }
            }
        }
        s
    }

    pub fn len(&self) -> usize {
        self.lemma.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lemma.is_empty()
    }

    pub fn non_banal(&self) -> usize {
        self.banal.iter().filter(|b| !**b).count()
    }

    /// Restrict to a range, keeping ids (so it stays comparable).
    pub fn slice(&self, r: Range<usize>) -> Seq {
        Seq {
            lemma: self.lemma[r.clone()].to_vec(),
            root: self.root[r.clone()].to_vec(),
            surface: self.surface[r.clone()].to_vec(),
            rank: self.rank[r.clone()].to_vec(),
            banal: self.banal[r.clone()].to_vec(),
            zone: self.zone[r].to_vec(),
        }
    }
}

// ---------------------------------------------------------------- anchors ---

/// A lemma trigram used to retrieve candidates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Anchor {
    /// Leniency this anchor is matched with; see `Params::anchor_slop`.
    #[serde(default)]
    pub slop: u32,
    /// Offset of the trigram in the query.
    pub start: usize,
    pub terms: Vec<String>,
    /// Sum of the three lemma ranks; larger = rarer (the tiebreaker).
    pub rank_sum: u64,
    /// Pages the trigram occurs on, from the index.
    pub df: usize,
}

/// The candidate trigrams of a passage (every lemma trigram outside a zone,
/// each once), rarest-by-rank first — the order they are counted in.
fn trigrams(q: &Seq, tokens: &[Token], params: &Params) -> Vec<Anchor> {
    let n = params.anchor_gram.clamp(1, 5);
    let mut seen: HashMap<Vec<u32>, usize> = HashMap::new();
    let mut out: Vec<Anchor> = Vec::new();
    if q.len() < n {
        return out;
    }
    for i in 0..=q.len() - n {
        let ok = (i..i + n).all(|j| q.lemma[j].is_some() && (!params.exclude_zones_from_anchoring || q.zone[j].is_none()));
        if !ok {
            continue;
        }
        let key: Vec<u32> = (i..i + n).map(|j| q.lemma[j].unwrap()).collect();
        if seen.contains_key(&key) {
            continue;
        }
        seen.insert(key, out.len());
        let rank_sum = (i..i + n).map(|j| rank_value(q.rank[j])).sum();
        out.push(Anchor {
            slop: params.anchor_slop,
            start: i,
            terms: tokens[i..i + n].iter().map(|t| t.lemma.clone()).collect(),
            rank_sum,
            df: 0,
        });
    }
    out.sort_by(|a, b| b.rank_sum.cmp(&a.rank_sum).then_with(|| a.start.cmp(&b.start)));
    out
}

/// Pairs of the window's rarest lemmas, to be matched anywhere within
/// `anchor_skip` tokens of one another.
///
/// The n-gram is an adjacency claim, and adjacency is what a citing text
/// breaks: `قال أبو عبيد: المربد كل شيء` puts the frame's last word next to
/// the quotation's first, so the rarest trigram of the citing page is one
/// that cannot exist in the book being quoted. A pair of rare lemmas near
/// each other makes no claim about what lies between them.
fn skipgrams(q: &Seq, tokens: &[Token], params: &Params) -> Vec<Anchor> {
    let mut rare: Vec<usize> = (0..q.len())
        .filter(|&j| {
            q.lemma[j].is_some()
                && !q.banal[j]
                && (!params.exclude_zones_from_anchoring || q.zone[j].is_none())
        })
        .collect();
    rare.sort_by_key(|&j| std::cmp::Reverse(rank_value(q.rank[j])));
    rare.truncate(params.anchors.max(params.min_anchors).max(1) * 3);
    rare.sort_unstable();

    let mut out: Vec<Anchor> = Vec::new();
    let mut seen: HashMap<(u32, u32), ()> = HashMap::new();
    for a in 0..rare.len() {
        for b in (a + 1)..rare.len() {
            let (i, j) = (rare[a], rare[b]);
            if j - i > params.anchor_skip as usize {
                break;
            }
            let key = (q.lemma[i].unwrap(), q.lemma[j].unwrap());
            if seen.insert(key, ()).is_some() {
                continue;
            }
            out.push(Anchor {
                slop: params.anchor_skip,
                start: i,
                terms: vec![tokens[i].lemma.clone(), tokens[j].lemma.clone()],
                rank_sum: rank_value(q.rank[i]) + rank_value(q.rank[j]),
                df: 0,
            });
        }
    }
    out.sort_by(|a, b| b.rank_sum.cmp(&a.rank_sum).then_with(|| a.start.cmp(&b.start)));
    out
}

/// Amendment 1.4: anchors by document frequency. The `count_budget` is
/// spent evenly over `k` slices of the passage (the rarest-by-rank trigrams
/// of each slice), so every part of it is looked at; then, over everything
/// counted, the trigrams with the lowest count beyond the query's own page
/// (a count of 1 is "only here"; a count above `max_candidates` cannot be
/// retrieved whole and is skipped) are taken greedily without overlap,
/// rarest by rank on ties — the rarest phrases of a passage cluster where
/// its wording is peculiar, which is exactly where a parallel differs.
pub fn anchors(q: &Seq, tokens: &[Token], params: &Params, count: &dyn Fn(&[String]) -> Result<usize>) -> Result<Vec<Anchor>> {
    if params.anchor_slots.is_empty() {
        return anchors_on_one_key(q, tokens, params, count);
    }
    // Each key gets its own budget and its own ceiling. Two keys that pick
    // the same phrase are one anchor, not two queries.
    let mut out: Vec<Anchor> = Vec::new();
    for slot in &params.anchor_slots {
        let p = Params {
            anchor_gram: slot.gram,
            anchors: slot.anchors,
            min_anchors: slot.anchors.min(params.min_anchors),
            anchor_df_cap: slot.df_cap,
            anchor_slots: Vec::new(),
            ..params.clone()
        };
        for a in anchors_on_one_key(q, tokens, &p, count)? {
            if !out.iter().any(|x| x.terms == a.terms) {
                out.push(a);
            }
        }
    }
    Ok(out)
}

fn anchors_on_one_key(q: &Seq, tokens: &[Token], params: &Params, count: &dyn Fn(&[String]) -> Result<usize>) -> Result<Vec<Anchor>> {
    let all = if params.anchor_skip > 0 { skipgrams(q, tokens, params) } else { trigrams(q, tokens, params) };
    if all.is_empty() {
        return Ok(Vec::new());
    }
    let k = params.anchors.max(params.min_anchors).max(1);
    let positions = q.len().saturating_sub(2).max(1);
    let slice_len = positions.div_ceil(k).max(1);
    let per_slice = (params.count_budget.max(1) / k).max(1);
    let mut counted: Vec<Anchor> = Vec::new();
    for slice in 0..k {
        let lo = slice * slice_len;
        let hi = lo + slice_len;
        for a in all.iter().filter(|a| a.start >= lo && a.start < hi).take(per_slice) {
            let mut a = a.clone();
            a.df = count(&a.terms)?;
            counted.push(a);
        }
    }
    let cap = params.df_cap();
    let mut usable: Vec<&Anchor> = counted.iter().filter(|a| a.df >= 2 && a.df <= cap).collect();
    usable.sort_by(|a, b| a.df.cmp(&b.df).then_with(|| b.rank_sum.cmp(&a.rank_sum)).then_with(|| a.start.cmp(&b.start)));
    let mut picked: Vec<Anchor> = Vec::new();
    for a in &usable {
        if picked.len() >= k {
            break;
        }
        if picked.iter().all(|p| p.start.abs_diff(a.start) >= 3) {
            picked.push((*a).clone());
        }
    }
    for a in &usable {
        if picked.len() >= k {
            break;
        }
        if !picked.iter().any(|p| p.start == a.start) {
            picked.push((*a).clone());
        }
    }
    Ok(picked)
}

/// Unknown lemmas are rarer than any ranked one; treat them as rank 10⁷ so
/// the sum stays comparable.
fn rank_value(rank: u32) -> u64 {
    if rank == u32::MAX { 10_000_000 } else { rank as u64 }
}

// ---------------------------------------------------------- the book index ---

/// Every lemma n-gram of one book, and the pages holding it.
///
/// Built once per run from the target book's pages. Keys are 64-bit hashes
/// of the joined lemmas rather than the lemmas themselves: a collision costs
/// one page that alignment then rejects, and it keeps a 150,000-token book
/// to a few megabytes.
#[derive(Debug, Default)]
pub struct BookIndex {
    grams: HashMap<u64, Vec<u32>>,
    pages: Vec<PageRef>,
    /// Lengths held, and how many postings there are, for the run report.
    pub lengths: Vec<usize>,
    pub postings: usize,
}

fn gram_key(lemmas: &[&str]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for l in lemmas {
        l.hash(&mut h);
        0xffu8.hash(&mut h);
    }
    h.finish()
}

impl BookIndex {
    /// One pass over the book. `lengths` are the n-gram lengths to hold.
    pub fn build(pages: &[Page], lengths: &[usize]) -> Self {
        let mut ix = BookIndex { lengths: lengths.to_vec(), ..Default::default() };
        for (pi, page) in pages.iter().enumerate() {
            ix.pages.push(PageRef { book_id: page.book_id, part_index: page.part_index, page_id: page.page_id });
            let lemmas: Vec<&str> = page.tokens.iter().map(|t| t.lemma.as_str()).collect();
            for &n in lengths {
                if n == 0 || lemmas.len() < n {
                    continue;
                }
                for i in 0..=lemmas.len() - n {
                    if lemmas[i..i + n].iter().any(|l| l.is_empty()) {
                        continue;
                    }
                    let e = ix.grams.entry(gram_key(&lemmas[i..i + n])).or_default();
                    if e.last() != Some(&(pi as u32)) {
                        e.push(pi as u32);
                        ix.postings += 1;
                    }
                }
            }
        }
        ix
    }

    pub fn pages(&self) -> usize {
        self.pages.len()
    }

    pub fn keys(&self) -> usize {
        self.grams.len()
    }

    /// Roughly what it occupies, for the run report.
    pub fn bytes(&self) -> usize {
        self.grams.len() * (8 + 24) + self.postings * 4 + self.pages.len() * 16
    }

    /// Every page sharing an n-gram with these tokens, most shared first.
    pub fn candidates(&self, tokens: &[Token], own: &[PageRef], params: &Params) -> Vec<Candidate> {
        let lemmas: Vec<&str> = tokens.iter().map(|t| t.lemma.as_str()).collect();
        let mut hits: HashMap<u32, usize> = HashMap::new();
        for &n in &self.lengths {
            if n == 0 || lemmas.len() < n {
                continue;
            }
            for i in 0..=lemmas.len() - n {
                if lemmas[i..i + n].iter().any(|l| l.is_empty()) {
                    continue;
                }
                if let Some(ps) = self.grams.get(&gram_key(&lemmas[i..i + n])) {
                    for p in ps {
                        *hits.entry(*p).or_insert(0) += 1;
                    }
                }
            }
        }
        let mut out: Vec<Candidate> = hits
            .into_iter()
            .map(|(pi, n)| Candidate { page: self.pages[pi as usize], hits: n })
            .filter(|c| !own.contains(&c.page))
            .collect();
        out.sort_by(|a, b| {
            b.hits.cmp(&a.hits).then_with(|| (a.page.book_id, a.page.part_index, a.page.page_id).cmp(&(b.page.book_id, b.page.part_index, b.page.page_id)))
        });
        out.truncate(params.exhaustive_max_candidates.max(1));
        out
    }
}

// ------------------------------------------------------------- candidates ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Candidate {
    pub page: PageRef,
    pub hits: usize,
}

/// Run every anchor as a lemma phrase query and keep the pages that hit
/// enough of them (§4.3), excluding the query's own page (and, when asked,
/// its whole book), capped by hit count.
pub fn candidates(
    source: &dyn BookSource,
    anchors: &[Anchor],
    // `own` is every page of the query window: none of them is a candidate.
    own: &[PageRef],
    exclude_book: Option<u64>,
    non_banal: usize,
    params: &Params,
) -> Result<Vec<Candidate>> {
    let mut hits: HashMap<(u64, u32, u64), usize> = HashMap::new();
    let mut rare: std::collections::HashSet<(u64, u32, u64)> = std::collections::HashSet::new();
    for a in anchors {
        let q = CandidateQuery { layer: crate::source::Layer::Lemma, terms: a.terms.clone(), limit: params.max_candidates.max(1), slop: a.slop, book_ids: params.book_filter() };
        // A compound index expands a lemma into its triples, and a phrase
        // whose expansion is too wide cannot be run with slop at all. That
        // is a property of the phrase, not an error in the query: fall back
        // to the exact one rather than abandoning the anchor.
        let found = match source.find_pages(&q) {
            Ok(h) => h,
            Err(_) if a.slop > 0 => source.find_pages(&CandidateQuery { slop: 0, ..q.clone() })?,
            Err(e) => return Err(e),
        };
        for p in found.pages {
            let key = (p.book_id, p.part_index, p.page_id);
            *hits.entry(key).or_insert(0) += 1;
            if a.df > 0 && a.df <= params.rare_df {
                rare.insert(key);
            }
        }
    }
    let need = if non_banal < params.small_passage { 1 } else { params.anchor_hits.max(1) };
    let mut out: Vec<Candidate> = hits
        .into_iter()
        .filter(|((b, p, g), n)| {
            (*n >= need || rare.contains(&(*b, *p, *g)))
                && !own.iter().any(|o| o.book_id == *b && o.part_index == *p && o.page_id == *g)
                && exclude_book.map(|x| x != *b).unwrap_or(true)
        })
        .map(|((book_id, part_index, page_id), hits)| Candidate { page: PageRef { book_id, part_index, page_id }, hits })
        .collect();
    out.sort_by(|a, b| {
        b.hits.cmp(&a.hits).then_with(|| (a.page.book_id, a.page.part_index, a.page.page_id).cmp(&(b.page.book_id, b.page.part_index, b.page.page_id)))
    });
    out.truncate(params.max_candidates.max(1));
    Ok(out)
}

// -------------------------------------------------------------- alignment ---

/// One local alignment: `(query index, target index)` pairs in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aligned {
    pub pairs: Vec<(usize, usize)>,
    pub score: i32,
}

fn pair_score(q: &Seq, i: usize, t: &Seq, j: usize, p: &Params) -> i32 {
    match (q.lemma[i], t.lemma[j]) {
        (Some(a), Some(b)) if a == b => p.match_lemma,
        _ => match (q.root[i], t.root[j]) {
            (Some(a), Some(b)) if a == b => p.match_root,
            _ => p.mismatch,
        },
    }
}

const NEG: i32 = i32::MIN / 4;

/// Smith–Waterman with affine gaps (Gotoh) on `q` × `t[t_range]`, skipping
/// masked positions. Returns the best local alignment, or `None` when
/// nothing scores above zero.
pub fn smith_waterman(q: &Seq, t: &Seq, t_range: Range<usize>, q_mask: &[bool], t_mask: &[bool], p: &Params) -> Option<Aligned> {
    let m = q.len();
    let n = t_range.len();
    if m == 0 || n == 0 {
        return None;
    }
    let w = n + 1;
    // H: best ending in a pair; E: ending in a gap on the query side (a
    // target token skipped); F: ending in a gap on the target side.
    let mut h = vec![0i32; (m + 1) * w];
    let mut e = vec![NEG; (m + 1) * w];
    let mut f = vec![NEG; (m + 1) * w];
    // 0 = stop, 1 = diagonal, 2 = from E, 3 = from F; for E/F: whether opened.
    let mut hd = vec![0u8; (m + 1) * w];
    let mut eo = vec![false; (m + 1) * w];
    let mut fo = vec![false; (m + 1) * w];
    let mut best = (0i32, 0usize, 0usize);
    for i in 1..=m {
        for j in 1..=n {
            let c = i * w + j;
            let masked = q_mask[i - 1] || t_mask[t_range.start + j - 1];
            let open_e = h[c - 1] + p.gap_open;
            let ext_e = e[c - 1] + p.gap_extend;
            if open_e >= ext_e {
                e[c] = open_e;
                eo[c] = true;
            } else {
                e[c] = ext_e;
            }
            let open_f = h[c - w] + p.gap_open;
            let ext_f = f[c - w] + p.gap_extend;
            if open_f >= ext_f {
                f[c] = open_f;
                fo[c] = true;
            } else {
                f[c] = ext_f;
            }
            let diag = if masked { NEG } else { h[c - w - 1] + pair_score(q, i - 1, t, t_range.start + j - 1, p) };
            let (v, d) = if diag >= e[c] && diag >= f[c] { (diag, 1u8) } else if e[c] >= f[c] { (e[c], 2) } else { (f[c], 3) };
            if v <= 0 {
                h[c] = 0;
                hd[c] = 0;
            } else {
                h[c] = v;
                hd[c] = d;
            }
            if h[c] > best.0 {
                best = (h[c], i, j);
            }
        }
    }
    if best.0 <= 0 {
        return None;
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (best.1, best.2);
    let mut state = 0u8; // 0 = in H, 2 = in E, 3 = in F
    loop {
        let c = i * w + j;
        match state {
            0 => match hd[c] {
                1 => {
                    pairs.push((i - 1, t_range.start + j - 1));
                    i -= 1;
                    j -= 1;
                }
                2 => state = 2,
                3 => state = 3,
                _ => break,
            },
            2 => {
                let opened = eo[c];
                j -= 1;
                if opened {
                    state = 0;
                }
            }
            _ => {
                let opened = fo[c];
                i -= 1;
                if opened {
                    state = 0;
                }
            }
        }
        if i == 0 || j == 0 {
            break;
        }
    }
    pairs.reverse();
    Some(Aligned { pairs, score: best.0 })
}

/// The best local alignment on a page and, in proximity mode, further
/// disjoint alignments starting within `proximity_window` of it (§4.3),
/// merged into one pair list. `None` when the best is shorter than
/// `min_aligned`.
pub fn align_page(q: &Seq, t: &Seq, p: &Params) -> Option<Aligned> {
    let mut q_mask = vec![false; q.len()];
    let mut t_mask = vec![false; t.len()];
    align_one(q, t, &mut q_mask, &mut t_mask, p)
}

/// At most this many passages are reported from one candidate page, and at
/// most this many fragments are folded into one of them in proximity mode. A
/// page that aligns eight separate times is either a table of contents or a
/// disaster, and either way the ninth adds nothing.
pub const MAX_ALIGNMENTS_PER_PAGE: usize = 8;

/// Every passage this page shares with the query region, best first.
///
/// Retrieval found the page; this finds what is on it. Each alignment is
/// masked out before the next is sought, so two quotations from different
/// parts of the same page come back as two matches instead of one span
/// stretched across the gap between them.
pub fn align_all(q: &Seq, t: &Seq, p: &Params) -> Vec<Aligned> {
    align_all_upto(q, t, p, MAX_ALIGNMENTS_PER_PAGE)
}

/// The same, over a region of several pages: the budget is per page, so
/// widening the region does not make the last page compete with the first.
pub fn align_all_upto(q: &Seq, t: &Seq, p: &Params, limit: usize) -> Vec<Aligned> {
    let mut q_mask = vec![false; q.len()];
    let mut t_mask = vec![false; t.len()];
    let mut out = Vec::new();
    while out.len() < limit.max(1) {
        let Some(a) = align_one(q, t, &mut q_mask, &mut t_mask, p) else { break };
        out.push(a);
    }
    out
}

/// One passage: the best local alignment left, with the fragments near it
/// that belong to the same passage folded in.
fn align_one(q: &Seq, t: &Seq, q_mask: &mut [bool], t_mask: &mut [bool], p: &Params) -> Option<Aligned> {
    let first = smith_waterman(q, t, 0..t.len(), q_mask, t_mask, p)?;
    if first.pairs.len() < p.aligned_floor() {
        return None;
    }
    for (a, b) in &first.pairs {
        q_mask[*a] = true;
        t_mask[*b] = true;
    }
    let mut all = first.clone();
    if p.proximity {
        let t_first = first.pairs[0].1;
        let lo = t_first.saturating_sub(p.proximity_window);
        let hi = (first.pairs.last().unwrap().1 + 1 + p.proximity_window).min(t.len());
        for _ in 0..MAX_ALIGNMENTS_PER_PAGE {
            let Some(next) = smith_waterman(q, t, lo..hi, q_mask, t_mask, p) else { break };
            // A fragment: at least half the minimum, so an inflected tail
            // after a gap still counts, but not a chance bigram.
            if next.pairs.len() < (p.aligned_floor() / 2).max(2) || next.pairs[0].1.abs_diff(t_first) > p.proximity_window {
                break;
            }
            for (a, b) in &next.pairs {
                q_mask[*a] = true;
                t_mask[*b] = true;
            }
            all.score += next.score;
            all.pairs.extend(next.pairs);
        }
        all.pairs.sort_unstable();
    }
    Some(all)
}

/// The pages of `refs` around `center`, `radius` either side, in reading
/// order. `refs` is the book page list, which is already in reading order;
/// a centre that is not in it is its own span.
pub fn span_around(refs: &[PageRef], center: &PageRef, radius: usize) -> Vec<PageRef> {
    match refs.iter().position(|r| r == center) {
        None => vec![*center],
        Some(i) => refs[i.saturating_sub(radius)..(i + radius + 1).min(refs.len())].to_vec(),
    }
}

/// A candidate page and its neighbours, concatenated into one token stream.
///
/// Token indices inside it are offsets from the first page, exactly as the
/// isnad workbench numbers a chain that runs over a page break, and a match
/// re-bases them on whichever page its own alignment starts on.
pub struct TargetSpan {
    pub pages: Vec<PageRef>,
    /// Where each page starts in `tokens`.
    pub starts: Vec<usize>,
    pub tokens: Vec<Token>,
}

impl TargetSpan {
    /// Load `refs` in order, keeping only the run that contains `center`: a
    /// page that will not load is a hole, and a stream with a hole in it
    /// would align across text that is not there.
    pub fn load(refs: &[PageRef], center: &PageRef, load: &dyn Fn(&PageRef) -> Result<Option<Page>>) -> Result<Option<Self>> {
        let mut span = TargetSpan { pages: Vec::new(), starts: Vec::new(), tokens: Vec::new() };
        for r in refs {
            match load(r)? {
                Some(p) => {
                    span.starts.push(span.tokens.len());
                    span.pages.push(*r);
                    span.tokens.extend(p.tokens.iter().cloned());
                }
                None if span.pages.contains(center) => break,
                None => {
                    span.pages.clear();
                    span.starts.clear();
                    span.tokens.clear();
                }
            }
        }
        Ok(if span.pages.contains(center) { Some(span) } else { None })
    }

    /// The page holding token `i`, as an index into `pages`.
    pub fn page_of(&self, i: usize) -> usize {
        self.starts.iter().rposition(|s| *s <= i).unwrap_or(0)
    }
}

// ---------------------------------------------------------------- scoring ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Components {
    pub surface_agree: f64,
    pub lemma_agree: f64,
    pub root_agree: f64,
    pub coverage: f64,
    /// Banal fraction of the aligned query region — kept so the banality
    /// scale can be changed without re-running.
    pub banal_share: f64,
    pub banality_factor: f64,
    /// Aligned pairs.
    pub aligned: usize,
}

/// §4.3's per-match components. `non_banal_query` is the passage's non-banal
/// token count (coverage's denominator).
pub fn components(q: &Seq, t: &Seq, pairs: &[(usize, usize)], non_banal_query: usize, p: &Params) -> Components {
    let n = pairs.len().max(1) as f64;
    let mut s = 0usize;
    let mut l = 0usize;
    let mut r = 0usize;
    for (i, j) in pairs {
        if q.surface[*i] == t.surface[*j] {
            s += 1;
        }
        if q.lemma[*i].is_some() && q.lemma[*i] == t.lemma[*j] {
            l += 1;
        }
        if q.root[*i].is_some() && q.root[*i] == t.root[*j] {
            r += 1;
        }
    }
    let aligned_non_banal = pairs.iter().filter(|(i, _)| !q.banal[*i]).count();
    let coverage = if non_banal_query == 0 { 0.0 } else { (aligned_non_banal as f64 / non_banal_query as f64).min(1.0) };
    let (q_start, q_end) = match (pairs.first(), pairs.last()) {
        (Some(a), Some(b)) => (a.0, b.0 + 1),
        _ => (0, 0),
    };
    let region = q_end.saturating_sub(q_start).max(1) as f64;
    let banal_share = q.banal[q_start..q_end].iter().filter(|b| **b).count() as f64 / region;
    Components {
        surface_agree: s as f64 / n,
        lemma_agree: l as f64 / n,
        root_agree: r as f64 / n,
        coverage,
        banal_share,
        banality_factor: banality_factor(banal_share, p),
        aligned: pairs.len(),
    }
}

/// `1 − min(1, excess / banality_scale)` (alNaql's continuous penalty),
/// with `excess = max(0, banal_share − banality_baseline)`.
pub fn banality_factor(banal_share: f64, p: &Params) -> f64 {
    let excess = (banal_share - p.banality_baseline.unwrap_or(0.0)).max(0.0);
    if p.banality_scale <= 0.0 {
        return if excess > 0.0 { 0.0 } else { 1.0 };
    }
    1.0 - (excess / p.banality_scale).min(1.0)
}

/// The share of the corpus's tokens whose lemma ranks ≤ `rank`: what
/// `Params::banality_baseline` should be for that table and rank.
pub fn corpus_banal_share(freq: &FreqTable, rank: u32) -> f64 {
    if freq.total == 0 {
        return 0.0;
    }
    let banal: u64 = freq.entries().filter(|(k, _)| freq.get(k).rank.map(|r| r <= rank).unwrap_or(false)).map(|(_, c)| c).sum();
    banal as f64 / freq.total as f64
}

pub fn score(c: &Components, p: &Params) -> f64 {
    c.coverage * (p.w_lemma * c.lemma_agree + p.w_root * c.root_agree + p.w_surface * c.surface_agree) * c.banality_factor
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchType {
    Verbatim,
    Inflected,
    Paraphrase,
    Formulaic,
    Weak,
}

impl MatchType {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchType::Verbatim => "verbatim",
            MatchType::Inflected => "inflected",
            MatchType::Paraphrase => "paraphrase",
            MatchType::Formulaic => "formulaic",
            MatchType::Weak => "weak",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "verbatim" => MatchType::Verbatim,
            "inflected" => MatchType::Inflected,
            "paraphrase" => MatchType::Paraphrase,
            "formulaic" => MatchType::Formulaic,
            "weak" => MatchType::Weak,
            _ => return None,
        })
    }
}

/// §4.3's type table, `formulaic` first (see the module header). The four
/// cutoffs are [`Params`] fields; the defaults are the spec's.
pub fn match_type(c: &Components, p: &Params) -> MatchType {
    if c.banality_factor < p.type_formulaic {
        MatchType::Formulaic
    } else if c.surface_agree >= p.type_verbatim {
        MatchType::Verbatim
    } else if c.lemma_agree >= p.type_inflected {
        MatchType::Inflected
    } else if c.root_agree >= p.type_paraphrase {
        MatchType::Paraphrase
    } else {
        MatchType::Weak
    }
}

/// The type, knowing where the match sits.
///
/// A short alignment lying in an isnād is a chain, not a quotation: two
/// unrelated hadiths share `فلان عن فلان عن فلان` for six or eight tokens
/// and nothing else. Those are typed formulaic, which is what keeps them
/// out of the default report rather than out of the record. A long
/// alignment inside an isnād is a different thing -- the whole chain
/// genuinely copied -- and keeps its own type.
pub fn match_type_in(c: &Components, zone: Option<Zone>, p: &Params) -> MatchType {
    // Two books that carry the same ḥadīth share its chain, and a shared
    // chain is a fact about transmission rather than a passage one text took
    // from the other. Length does not change that: `سمعت فلانا يقول سمعت
    // فلانا يقول` is the same formula at thirteen tokens as at six, and the
    // old rule -- formulaic only below twice the aligned floor -- reported
    // every chain longer than that. `zone_of` already requires half the
    // aligned tokens to sit in the zone, so a matn parallel that merely
    // opens with a chain is not caught by this.
    if zone == Some(Zone::Isnad) {
        return MatchType::Formulaic;
    }
    match_type(c, p)
}

/// Recompute what the banality scale, weights and threshold affect from the
/// stored components — the UI's re-scoring without a re-run.
pub fn rescore(c: &Components, p: &Params) -> (Components, f64, MatchType) {
    let mut c = *c;
    c.banality_factor = banality_factor(c.banal_share, p);
    let s = score(&c, p);
    (c, s, match_type(&c, p))
}

// ---------------------------------------------------------------- matches ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Match {
    /// The page the query span starts on. A window is cut against the book's
    /// token stream, so a window -- and a match inside it -- may begin on one
    /// page and end on another.
    #[serde(default)]
    pub query: PageRef,
    /// The page the query span ends on, when it is not the one it starts on.
    /// `q_start`, `q_end` and the query side of `pairs` are offsets from
    /// `query` and run past its last token into this one.
    #[serde(default)]
    pub query_end: Option<PageRef>,
    pub target: PageRef,
    /// The page the target span ends on, when it is not the one it starts
    /// on. `t_end` and the target side of `pairs` are offsets from the start
    /// page and run past its last token into this one.
    #[serde(default)]
    pub target_end: Option<PageRef>,
    /// Query span, in the query page's token indices (end exclusive).
    pub q_start: usize,
    pub q_end: usize,
    /// Target span on the target page.
    pub t_start: usize,
    pub t_end: usize,
    /// Aligned `(query idx, target idx)` pairs, page-absolute.
    pub pairs: Vec<(usize, usize)>,
    pub components: Components,
    pub score: f64,
    pub kind: MatchType,
    pub zone: Option<Zone>,
    pub anchor_hits: usize,
}

/// The zone the aligned query tokens mostly fall in, if any.
pub fn zone_of(q: &Seq, pairs: &[(usize, usize)]) -> Option<Zone> {
    let mut quran = 0usize;
    let mut isnad = 0usize;
    for (i, _) in pairs {
        match q.zone[*i] {
            Some(Zone::Quran) => quran += 1,
            Some(Zone::Isnad) => isnad += 1,
            None => {}
        }
    }
    let half = pairs.len().max(1).div_ceil(2);
    if quran >= half {
        Some(Zone::Quran)
    } else if isnad >= half {
        Some(Zone::Isnad)
    } else {
        None
    }
}

/// What a single-passage run reports besides its matches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PassageRun {
    pub anchors: Vec<Anchor>,
    pub candidates: usize,
    pub non_banal: usize,
    pub tokens: usize,
    pub matches: Vec<Match>,
    /// Which whole-passage query retrieved the candidates, when the
    /// passage was short or had no anchor: `lemma-slop` or `surface`.
    pub fallback: Option<&'static str>,
}

/// The whole passage as one index query (amendment 1.4): the lemma phrase
/// with slop, then the surface phrase. Every hit is a candidate.
fn fallback_candidates(source: &dyn BookSource, tokens: &[Token], own: &[PageRef], exclude_book: Option<u64>, params: &Params) -> Result<(Vec<Candidate>, Option<&'static str>)> {
    let keep = |p: &PageRef| !own.contains(p) && exclude_book.map(|x| x != p.book_id).unwrap_or(true);
    let lemmas: Vec<String> = tokens.iter().map(|t| t.lemma.clone()).filter(|l| !l.is_empty()).collect();
    if lemmas.len() >= 2 {
        // The compound index refuses a slop phrase whose slots are too wide;
        // the exact lemma phrase is the next best thing, not an error.
        for (slop, label) in [(params.fallback_slop, "lemma-slop"), (0, "lemma")] {
            let q = CandidateQuery { layer: crate::source::Layer::Lemma, terms: lemmas.clone(), limit: params.max_candidates.max(1), slop, book_ids: params.book_filter() };
            let hits = match source.find_pages(&q) {
                Ok(h) => h,
                Err(_) if slop > 0 => continue,
                Err(e) => return Err(e),
            };
            let pages: Vec<Candidate> = hits.pages.into_iter().filter(keep).map(|page| Candidate { page, hits: 1 }).collect();
            if !pages.is_empty() {
                return Ok((pages, Some(label)));
            }
            if slop == 0 {
                break;
            }
        }
    }
    let surfaces: Vec<String> = tokens.iter().map(|t| normalize_arabic(&t.surface)).filter(|s| !s.is_empty()).collect();
    if surfaces.len() >= 2 {
        let q = CandidateQuery { layer: crate::source::Layer::Surface, terms: surfaces, limit: params.max_candidates.max(1), slop: 0, book_ids: params.book_filter() };
        let pages: Vec<Candidate> = source.find_pages(&q)?.pages.into_iter().filter(keep).map(|page| Candidate { page, hits: 1 }).collect();
        if !pages.is_empty() {
            return Ok((pages, Some("surface")));
        }
    }
    Ok((Vec::new(), None))
}

/// Document frequency of a lemma phrase, as `passage` needs it: one
/// `find_pages` with limit 1, reading the total.
pub fn phrase_df(source: &dyn BookSource, terms: &[String]) -> Result<usize> {
    Ok(source.find_pages(&CandidateQuery { layer: crate::source::Layer::Lemma, terms: terms.to_vec(), limit: 1, slop: 0, book_ids: None })?.total)
}

/// §4.3 single-passage mode over `page.tokens[range]`.
///
/// `zones` is per token of the whole page; `count` is the phrase document
/// frequency ([`phrase_df`], or a cache in front of it); `load` fetches a
/// candidate page (`BookSource::page`, or a cache in front of it); `cancel`
/// is polled per candidate. Matches come back sorted by score, all of them
/// — the display threshold is applied by the caller.
#[allow(clippy::too_many_arguments)]
pub fn passage(
    source: &dyn BookSource,
    freq: &FreqTable,
    params: &Params,
    banal_phrases: &[Vec<String>],
    // `pages` is the run of pages the window covers, in reading order (one
    // page is the single-passage case); `range` is the window inside them
    // concatenated, and `zones` is over the same concatenation.
    pages: &[Page],
    range: Range<usize>,
    zones: &[Option<Zone>],
    exclude_book: Option<u64>,
    count: &dyn Fn(&[String]) -> Result<usize>,
    load: &dyn Fn(&PageRef) -> Result<Option<Page>>,
    neighbours: &dyn Fn(&PageRef, usize) -> Result<Vec<PageRef>>,
    // The target book read into memory, when the run is exhaustive.
    index: Option<&BookIndex>,
    cancel: &dyn Fn() -> bool,
) -> Result<PassageRun> {
    let mut intern = Interner::default();
    // The query side is a stream too: the window's pages, concatenated, with
    // the offset of each so a match can be reported on the page it starts on.
    let mut q_starts: Vec<usize> = Vec::with_capacity(pages.len() + 1);
    let mut all: Vec<Token> = Vec::new();
    for p in pages {
        q_starts.push(all.len());
        all.extend(p.tokens.iter().cloned());
    }
    q_starts.push(all.len());
    let range = range.start.min(all.len())..range.end.min(all.len());
    let tokens = &all[range.clone()];
    let page_of = |offset: usize| q_starts[..q_starts.len() - 1].partition_point(|&s| s <= offset).saturating_sub(1);
    let page_zones: Vec<Option<Zone>> = (range.clone()).map(|i| zones.get(i).copied().flatten()).collect();
    let q = Seq::build(tokens, &mut intern, freq, params, banal_phrases, &page_zones);
    let non_banal = q.non_banal();
    let own: Vec<PageRef> = pages.iter().map(|p| PageRef { book_id: p.book_id, part_index: p.part_index, page_id: p.page_id }).collect();
    // Exhaustive retrieval asks nothing of the index and chooses nothing:
    // every n-gram of the window is looked up in the book held in memory.
    // Anchors are still computed, because the run report shows them and
    // because a passage with no usable anchor is worth seeing either way.
    let anchors = anchors(&q, tokens, params, count)?;
    let mut cands = match index.filter(|_| params.exhaustive()) {
        Some(ix) => ix.candidates(tokens, &own, params),
        None if anchors.is_empty() => Vec::new(),
        None => candidates(source, &anchors, &own, exclude_book, non_banal, params)?,
    };
    // A short passage, or one with no anchor, also goes to the index whole;
    // its hits join the anchor candidates.
    let mut fallback = None;
    if !params.exhaustive() && (tokens.len() < params.fallback_max_tokens || anchors.is_empty()) {
        let (extra, f) = fallback_candidates(source, tokens, &own, exclude_book, params)?;
        if !extra.is_empty() {
            fallback = f;
            for c in extra {
                if !cands.iter().any(|x| x.page == c.page) {
                    cands.push(c);
                }
            }
            cands.truncate(params.max_candidates.max(1));
        }
    }
    let mut matches = Vec::new();
    for c in &cands {
        if cancel() {
            break;
        }
        let refs = if params.target_neighbours > 0 { neighbours(&c.page, params.target_neighbours)? } else { vec![c.page] };
        let Some(span) = TargetSpan::load(&refs, &c.page, load)? else { continue };
        let t = Seq::build(&span.tokens, &mut intern, freq, params, banal_phrases, &[]);
        for al in align_all_upto(&q, &t, params, MAX_ALIGNMENTS_PER_PAGE * span.pages.len()) {
            // Each alignment is scored on itself, not on the window that
            // retrieved it. A window is a retrieval device: it decides which
            // pages are worth reading, and has no business in the score. Six
            // words quoted exactly are six words quoted exactly whether they
            // were found inside a window of sixty or of six hundred, and
            // dividing by the window is what made a short quotation score
            // near zero and disappear.
            let q_lo = al.pairs.iter().map(|p| p.0).min().unwrap();
            let q_hi = al.pairs.iter().map(|p| p.0).max().unwrap() + 1;
            let non_banal_span = q.banal[q_lo..q_hi].iter().filter(|b| !**b).count().max(1);
            let mut comp = components(&q, &t, &al.pairs, non_banal_span, params);
            if tokens.len() < params.fallback_max_tokens || anchors.is_empty() {
                // The user chose this short passage whole: the banality
                // penalty, meant for chance overlaps of common words in a
                // long window, would hide exactly what was asked for
                // (amendment 1.4).
                comp.banality_factor = 1.0;
            }
            let s = score(&comp, params);
            let zone = zone_of(&q, &al.pairs);
            // Re-base on the page the alignment starts on, which is not
            // always the page retrieval found: a quotation running back over
            // a break belongs to the page it begins on.
            let t_lo = al.pairs.iter().map(|p| p.1).min().unwrap();
            let t_hi = al.pairs.iter().map(|p| p.1).max().unwrap() + 1;
            let si = span.page_of(t_lo);
            let ei = span.page_of(t_hi - 1);
            let base = span.starts[si];
            // The query side re-bases the same way: a match belongs to the
            // page it begins on, whichever page the window began on.
            let qa = q_lo + range.start;
            let qb = q_hi + range.start;
            let qi = page_of(qa);
            let qj = page_of(qb - 1);
            let q_base = q_starts[qi];
            let pairs: Vec<(usize, usize)> = al.pairs.iter().map(|(i, j)| (i + range.start - q_base, j - base)).collect();
            matches.push(Match {
                query: own[qi],
                query_end: if qj > qi { Some(own[qj]) } else { None },
                target: span.pages[si],
                target_end: if ei > si { Some(span.pages[ei]) } else { None },
                q_start: qa - q_base,
                q_end: qb - q_base,
                t_start: t_lo - base,
                t_end: t_hi - base,
                zone,
                pairs,
                components: comp,
                score: s,
                kind: match_type_in(&comp, zone, params),
                anchor_hits: c.hits,
            });
        }
    }
    matches.retain(|m| !own.contains(&m.target));
    // Two alignments that overlap are one passage seen twice.
    matches = merge_overlapping(matches.into_iter().map(|m| (m.query, m)).collect())
        .into_iter()
        .map(|(_, m)| m)
        .collect();
    matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.components.aligned.cmp(&a.components.aligned)));
    Ok(PassageRun { anchors, candidates: cands.len(), non_banal, tokens: tokens.len(), matches, fallback })
}

// -------------------------------------------------------------- book mode ---

/// Windows of `window` tokens at `stride` over a page of `len` tokens; the
/// last window is whatever remains if it is at least `min` tokens.
pub fn windows(len: usize, window: usize, stride: usize, min: usize) -> Vec<Range<usize>> {
    let window = window.max(1);
    let stride = stride.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + window).min(len);
        if end - start >= min.max(1) || start == 0 {
            out.push(start..end);
        }
        if end == len {
            break;
        }
        start += stride;
    }
    out
}

/// One window of the book's token stream, with the pages it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamWindow {
    /// Indices into the page list; the window's text is
    /// `pages[first_page..=last_page]` concatenated.
    pub first_page: usize,
    pub last_page: usize,
    /// The window inside that concatenation.
    pub range: Range<usize>,
}

/// Windows at `stride` over the whole book in reading order, each mapped
/// back to the pages it needs.
///
/// A page is a printing accident. Cutting windows at page edges put a
/// boundary every hundred-odd tokens where the text has none, so a passage
/// lying across one was seen only in halves -- the same defect the target
/// side had, on the query side.
pub fn stream_windows(page_lens: &[usize], window: usize, stride: usize, min: usize) -> Vec<StreamWindow> {
    let mut starts = Vec::with_capacity(page_lens.len() + 1);
    let mut acc = 0usize;
    for n in page_lens {
        starts.push(acc);
        acc += n;
    }
    starts.push(acc);
    let page_of = |offset: usize| starts[..starts.len() - 1].partition_point(|&s| s <= offset).saturating_sub(1);
    windows(acc, window, stride, min)
        .into_iter()
        .map(|w| {
            let first = page_of(w.start);
            let last = page_of(w.end.saturating_sub(1).max(w.start));
            StreamWindow { first_page: first, last_page: last, range: (w.start - starts[first])..(w.end - starts[first]) }
        })
        .collect()
}

/// Merge matches from overlapping windows: two matches on the same query
/// page and the same target page whose query spans and target spans both
/// overlap become one, with the union of pairs; the components are re-derived
/// from the union by the caller when it has the sequences, so here the
/// better-scoring member's components are kept and the spans widened.
pub fn merge_overlapping(mut matches: Vec<(PageRef, Match)>) -> Vec<(PageRef, Match)> {
    matches.sort_by(|a, b| {
        (a.0.book_id, a.0.part_index, a.0.page_id, a.1.target.book_id, a.1.target.part_index, a.1.target.page_id, a.1.q_start)
            .cmp(&(b.0.book_id, b.0.part_index, b.0.page_id, b.1.target.book_id, b.1.target.part_index, b.1.target.page_id, b.1.q_start))
    });
    let mut out: Vec<(PageRef, Match)> = Vec::new();
    for (qp, m) in matches {
        if let Some((lp, last)) = out.last_mut() {
            let same = *lp == qp && last.target == m.target;
            let overlap_q = m.q_start < last.q_end && last.q_start < m.q_end;
            let overlap_t = m.t_start < last.t_end && last.t_start < m.t_end;
            if same && overlap_q && overlap_t {
                if m.t_end > last.t_end {
                    last.target_end = m.target_end;
                }
                if m.q_end > last.q_end {
                    last.query_end = m.query_end;
                }
                let mut pairs = std::mem::take(&mut last.pairs);
                pairs.extend(m.pairs.iter().copied());
                pairs.sort_unstable();
                pairs.dedup_by_key(|p| p.0);
                last.pairs = pairs;
                last.q_start = last.q_start.min(m.q_start);
                last.q_end = last.q_end.max(m.q_end);
                last.t_start = last.t_start.min(m.t_start);
                last.t_end = last.t_end.max(m.t_end);
                if m.score > last.score {
                    last.score = m.score;
                    last.components = m.components;
                    last.kind = m.kind;
                    last.zone = m.zone;
                }
                last.components.aligned = last.pairs.len();
                last.anchor_hits = last.anchor_hits.max(m.anchor_hits);
                continue;
            }
        }
        out.push((qp, m));
    }
    out
}

/// Per-target-book aggregate for the ranked source-book table (§4.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookAggregate {
    pub book_id: u64,
    pub matches: usize,
    pub aligned_tokens: usize,
    pub best_score: f64,
    pub types: HashMap<String, usize>,
}

pub fn aggregate<'a, I: IntoIterator<Item = &'a Match>>(matches: I, threshold: f64) -> Vec<BookAggregate> {
    let mut by: HashMap<u64, BookAggregate> = HashMap::new();
    for m in matches {
        if m.score < threshold {
            continue;
        }
        let a = by.entry(m.target.book_id).or_insert_with(|| BookAggregate {
            book_id: m.target.book_id,
            matches: 0,
            aligned_tokens: 0,
            best_score: 0.0,
            types: HashMap::new(),
        });
        a.matches += 1;
        a.aligned_tokens += m.components.aligned;
        a.best_score = a.best_score.max(m.score);
        *a.types.entry(m.kind.as_str().to_string()).or_insert(0) += 1;
    }
    let mut v: Vec<BookAggregate> = by.into_values().collect();
    v.sort_by(|a, b| b.aligned_tokens.cmp(&a.aligned_tokens).then_with(|| b.matches.cmp(&a.matches)).then_with(|| a.book_id.cmp(&b.book_id)));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::page;
    use crate::source::{BookMetadata, FreqLayer};
    use std::sync::{Arc, Mutex};

    fn freq(counts: &[(&str, u64)]) -> FreqTable {
        FreqTable::from_counts(FreqLayer::Lemma, "t", counts.iter().map(|(k, c)| (k.to_string(), *c)).collect())
    }

    /// Test corpora have no page list; a page is then its own span, which
    /// is what `span_around` does with a centre it cannot place.
    fn alone(r: &PageRef, _n: usize) -> Result<Vec<PageRef>> {
        Ok(vec![*r])
    }

    fn seqs(qw: &str, tw: &str, f: &FreqTable, p: &Params) -> (Seq, Seq) {
        let mut it = Interner::default();
        let qp = page(1, 0, 1, "", qw);
        let tp = page(2, 0, 1, "", tw);
        (Seq::build(&qp.tokens, &mut it, f, p, &[], &[]), Seq::build(&tp.tokens, &mut it, f, p, &[], &[]))
    }

    #[test]
    fn banality_is_by_rank_or_phrase() {
        // Ranks: في 1, قال 2, كتاب 3, x 4.
        let f = freq(&[("في", 100), ("قال", 50), ("كتاب", 10), ("x", 1)]);
        let mut p = Params { banality_rank: 2, ..Default::default() };
        let pg = page(1, 0, 1, "", "في|في قال|قال كتاب|كتاب نادر|نادر");
        let mut it = Interner::default();
        let s = Seq::build(&pg.tokens, &mut it, &f, &p, &[], &[]);
        assert_eq!(s.banal, [true, true, false, false]);
        assert_eq!(s.rank, [1, 2, 3, u32::MAX]);
        assert_eq!(s.non_banal(), 2);
        // A phrase marks its tokens banal whatever their rank.
        p.banality_rank = 0;
        let s = Seq::build(&pg.tokens, &mut it, &f, &p, &[vec!["كتاب".into(), "نادر".into()]], &[]);
        assert_eq!(s.banal, [false, false, true, true]);
    }

    #[test]
    fn anchors_are_the_lowest_df_trigrams_with_rank_as_tiebreaker() {
        let f = freq(&[("a", 100), ("b", 90), ("c", 80), ("d", 70), ("e", 60), ("z", 1)]);
        // One key: this is the rule the slots are built out of.
        let p = Params { banality_rank: 1, anchors: 2, min_anchors: 1, anchor_slots: Vec::new(), ..Default::default() };
        // Document frequencies from a fake index: `a b c` is rare (2 pages:
        // here and one other), `d e z` common (40), everything else 5;
        // `z b c` only on the query page itself (1) — useless.
        let df = |t: &[String]| -> Result<usize> {
            Ok(match t.join(" ").as_str() {
                "a b c" => 2,
                "d e z" => 40,
                "z b c" => 1,
                _ => 5,
            })
        };
        let pg = page(1, 0, 1, "", "a b c d e z b c");
        let mut it = Interner::default();
        let s = Seq::build(&pg.tokens, &mut it, &f, &p, &[], &[]);
        let a = anchors(&s, &pg.tokens, &p, &df).unwrap();
        // Every trigram is counted (budget 24 over 6 positions); `a b c` (df 2)
        // is rarest, then the 5s — `e z b` is the rarest of those by rank and
        // does not overlap `a b c`; `z b c` (1: only here) never qualifies.
        assert_eq!(a.iter().map(|x| (x.terms.join(" "), x.df)).collect::<Vec<_>>(), [("a b c".to_string(), 2), ("e z b".to_string(), 5)]);
        // A zone on z removes both trigrams that use it, when exclusion is on.
        let zones = vec![None, None, None, None, None, Some(Zone::Quran), None, None];
        let pz = Params { exclude_zones_from_anchoring: true, ..p.clone() };
        let s = Seq::build(&pg.tokens, &mut it, &f, &pz, &[], &zones);
        let a = anchors(&s, &pg.tokens, &pz, &df).unwrap();
        assert_eq!(a.iter().map(|x| x.terms.join(" ")).collect::<Vec<_>>(), ["a b c", "c d e"]);
        // Above the candidate cap a trigram cannot be retrieved whole: skipped.
        let pc = Params { max_candidates: 30, ..p.clone() };
        let s = Seq::build(&pg.tokens, &mut it, &f, &pc, &[], &[]);
        let a = anchors(&s, &pg.tokens, &pc, &df).unwrap();
        assert!(a.iter().all(|x| x.terms.join(" ") != "d e z"), "{:?}", a);
        // The count budget bounds the lookups: per slice, rarest-by-rank first.
        let counted = std::cell::RefCell::new(Vec::new());
        let df2 = |t: &[String]| -> Result<usize> {
            counted.borrow_mut().push(t.join(" "));
            Ok(3)
        };
        let s = Seq::build(&pg.tokens, &mut it, &f, &p, &[], &[]);
        let p2 = Params { count_budget: 2, ..p.clone() };
        let a = anchors(&s, &pg.tokens, &p2, &df2).unwrap();
        assert_eq!(counted.borrow().as_slice(), ["c d e", "d e z"], "one count per slice, the rarest by rank in each");
        assert_eq!(a.len(), 2);
    }

    /// Fix 3: `من أين تأكلون فقال لسنا نعرف الأسباب` — seven tokens, every
    /// lemma in the top 300 — has a verbatim twin in another book and must be
    /// found. Under the old rule (anchors = non-banal trigrams) it had no
    /// anchor and returned nothing.
    #[test]
    fn a_seven_token_all_banal_passage_with_a_verbatim_twin_is_found() {
        // Every lemma outranks the banality line.
        let f = freq(&[("من", 9000), ("أين", 8000), ("أكل", 7000), ("قال", 6000), ("ليس", 5000), ("عرف", 4000), ("سبب", 3000), ("كتاب", 100), ("و", 9500)]);
        let p = Params::default();
        let words = "من|من اين|أين تاكلون|أكل فقال|قال لسنا|ليس نعرف|عرف الاسباب|سبب";
        // Thirteen tokens with the context: over the fallback length.
        let query = page(1, 0, 4, "", &format!("و|و كتاب|كتاب قديم|قديم {} و|و كتاب|كتاب اخر|آخر", words));
        let twin = page(2, 0, 9, "", &format!("كتاب|كتاب {} كتاب|كتاب", words));
        let other = page(3, 0, 1, "", "من|من كتاب|كتاب اين|أين كتاب|كتاب");
        let fake = Fake { pages: vec![query.clone(), twin, other], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let mut it = Interner::default();
        let s = Seq::build(&query.tokens[3..10], &mut it, &f, &p, &[], &[]);
        assert_eq!(s.non_banal(), 0, "every token is banal");
        // The passage alone: seven tokens, under the fallback length.
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 3..10, &[], None, &count, &load, &alone, None, &|| false).unwrap();
        assert_eq!(run.fallback, Some("lemma-slop"), "{:?}", run);
        assert_eq!(run.matches.len(), 1);
        assert_eq!(run.matches[0].target.book_id, 2);
        assert_eq!(run.matches[0].kind, MatchType::Verbatim, "no banality penalty on a whole-passage query: {:?}", run.matches[0].components);
        assert_eq!(run.matches[0].components.aligned, 7);
        // With context around it (13 tokens) the trigram counts find it too:
        // `من أين تأكلون` is on two pages, the context trigrams on one.
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, None, &|| false).unwrap();
        assert!(run.fallback.is_none());
        assert!(run.anchors.iter().all(|a| a.df > 0));
        assert_eq!(run.matches.iter().filter(|m| m.target.book_id == 2).count(), 1, "{:?}", run.anchors);
    }

    #[test]
    fn identical_sequences_align_end_to_end() {
        let f = freq(&[]);
        let p = Params::default();
        let (q, t) = seqs("a b c d e f g", "x y a b c d e f g z", &f, &p);
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.pairs, (0..7).map(|i| (i, i + 2)).collect::<Vec<_>>());
        assert_eq!(al.score, 14);
    }

    #[test]
    fn a_substitution_and_a_gap_cost_what_the_spec_says() {
        let f = freq(&[]);
        let p = Params::default();
        // One mismatch in the middle: 6 matches ×2 − 2 = 10; alignment keeps it.
        let (q, t) = seqs("a b c d e f g", "a b c X e f g", &f, &p);
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.score, 10);
        assert_eq!(al.pairs.len(), 7);
        // Root-only agreement scores +1: c|c|r1 vs C|C|r1.
        let (q, t) = seqs("a b c|c|r1 d e f g", "a b C|C|r1 d e f g", &f, &p);
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.score, 13);
        // A one-token insertion in the target: open −3 → 14 − 3 = 11.
        let (q, t) = seqs("a b c d e f g", "a b c Q d e f g", &f, &p);
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.score, 11);
        assert_eq!(al.pairs, [(0, 0), (1, 1), (2, 2), (3, 4), (4, 5), (5, 6), (6, 7)]);
        // A three-token insertion: −3 −1 −1 = −5 → 9.
        let (q, t) = seqs("a b c d e f g", "a b c Q R S d e f g", &f, &p);
        assert_eq!(align_page(&q, &t, &p).unwrap().score, 9);
        // Too short to count.
        let (q, t) = seqs("a b c d e", "a b c d e", &f, &p);
        assert!(align_page(&q, &t, &p).is_none());
    }

    #[test]
    fn proximity_mode_merges_a_reordered_tail() {
        let f = freq(&[]);
        let mut p = Params { proximity_window: 10, ..Default::default() };
        // Query: A-block then B-block; target: B-block then A-block, adjacent.
        let (q, t) = seqs("a b c d e f g h i j k l", "g h i j k l a b c d e f", &f, &p);
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.pairs.len(), 12, "both halves aligned: {:?}", al.pairs);
        p.proximity = false;
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.pairs.len(), 6);
        // Beyond the window the second block is left alone.
        p.proximity = true;
        p.proximity_window = 3;
        let (q, t) = seqs("a b c d e f g h i j k l", "g h i j k l x x x x x x x x a b c d e f", &f, &p);
        assert_eq!(align_page(&q, &t, &p).unwrap().pairs.len(), 6);
    }

    #[test]
    fn components_score_and_type_by_hand() {
        let f = freq(&[("في", 100), ("من", 90)]);
        let p = Params { banality_rank: 2, ..Default::default() };
        // 8 pairs: 6 surface-equal, 8 lemma-equal, roots on all → verbatim? 6/8 = 0.75 < 0.9 → inflected.
        let (q, t) = seqs(
            "كتب|كتب|كتب في|في|# الدار|دار|دور من|من|# باب|باب|بوب علم|علم|علم نور|نور|نور ذهب|ذهب|ذهب",
            "كتبت|كتب|كتب في|في|# الدار|دار|دور من|من|# باب|باب|بوب علم|علم|علم نور|نور|نور ذهبت|ذهب|ذهب",
            &f,
            &p,
        );
        let al = align_page(&q, &t, &p).unwrap();
        assert_eq!(al.pairs.len(), 8);
        let c = components(&q, &t, &al.pairs, q.non_banal(), &p);
        assert!((c.surface_agree - 0.75).abs() < 1e-9);
        assert!((c.lemma_agree - 1.0).abs() < 1e-9);
        assert!((c.root_agree - 1.0).abs() < 1e-9);
        assert!((c.coverage - 1.0).abs() < 1e-9);
        assert!((c.banal_share - 0.25).abs() < 1e-9);
        assert!((c.banality_factor - 0.5).abs() < 1e-9, "1 − 0.25/0.5 (baseline 0)");
        let s = score(&c, &p);
        assert!((s - 1.0 * (0.5 + 0.3 + 0.2 * 0.75) * 0.5).abs() < 1e-9);
        assert_eq!(match_type(&c, &p), MatchType::Inflected);
        // Banality wins over verbatim: three of four aligned tokens banal → factor 0.
        let mut c2 = c;
        c2.surface_agree = 1.0;
        c2.banal_share = 0.75;
        c2.banality_factor = banality_factor(0.75, &p);
        assert_eq!(c2.banality_factor, 0.0);
        assert_eq!(match_type(&c2, &p), MatchType::Formulaic);
        // Re-scoring with a wider scale from the stored share.
        let p2 = Params { banality_scale: 1.0, ..p.clone() };
        let (rc, rs, rk) = rescore(&c2, &p2);
        assert!((rc.banality_factor - 0.25).abs() < 1e-9);
        assert!(rs > 0.0);
        assert_eq!(rk, MatchType::Formulaic, "0.25 < 0.3 still formulaic");
        let p3 = Params { banality_scale: 2.0, ..p.clone() };
        assert_eq!(rescore(&c2, &p3).2, MatchType::Verbatim);
        // The baseline: a region as banal as the corpus is not penalised;
        // one 0.25 above it at scale 0.5 keeps half its score.
        let p4 = Params { banality_baseline: Some(0.6), ..p.clone() };
        assert_eq!(banality_factor(0.6, &p4), 1.0);
        assert_eq!(banality_factor(0.4, &p4), 1.0);
        assert!((banality_factor(0.85, &p4) - 0.5).abs() < 1e-9);
        assert!((banality_factor(1.0, &p4) - 0.2).abs() < 1e-9);
        assert!((corpus_banal_share(&f, 1) - 100.0 / 190.0).abs() < 1e-9);
        assert_eq!(corpus_banal_share(&f, 2), 1.0);
        assert_eq!(corpus_banal_share(&f, 0), 0.0);
        // Paraphrase: roots agree, lemmas do not.
        let c3 = Components { surface_agree: 0.1, lemma_agree: 0.2, root_agree: 0.8, coverage: 0.5, banal_share: 0.0, banality_factor: 1.0, aligned: 6 };
        assert_eq!(match_type(&c3, &p), MatchType::Paraphrase);
        let c4 = Components { root_agree: 0.5, ..c3 };
        assert_eq!(match_type(&c4, &p), MatchType::Weak);
    }

    #[test]
    fn windows_and_merging() {
        assert_eq!(windows(100, 60, 30, 6), vec![0..60, 30..90, 60..100]);
        assert_eq!(windows(65, 60, 30, 6), vec![0..60, 30..65]);
        assert_eq!(windows(63, 60, 30, 6), vec![0..60, 30..63]);
        assert_eq!(windows(10, 60, 30, 6), vec![0..10]);
        assert!(windows(0, 60, 30, 6).is_empty());
        let qp = PageRef { book_id: 1, part_index: 0, page_id: 1 };
        let tp = PageRef { book_id: 2, part_index: 0, page_id: 5 };
        let m = |qs: usize, qe: usize, ts: usize, te: usize, s: f64| Match {
            query: qp,
            query_end: None,
            target_end: None,
            target: tp.clone(),
            q_start: qs,
            q_end: qe,
            t_start: ts,
            t_end: te,
            pairs: (qs..qe).zip(ts..te).collect(),
            components: Components { surface_agree: 1.0, lemma_agree: 1.0, root_agree: 1.0, coverage: 1.0, banal_share: 0.0, banality_factor: 1.0, aligned: qe - qs },
            score: s,
            kind: MatchType::Verbatim,
            zone: None,
            anchor_hits: 2,
        };
        let merged = merge_overlapping(vec![(qp.clone(), m(0, 40, 100, 140, 0.8)), (qp.clone(), m(30, 60, 130, 160, 0.9)), (qp.clone(), m(200, 220, 400, 420, 0.5))]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].1.q_start, merged[0].1.q_end, merged[0].1.t_start, merged[0].1.t_end), (0, 60, 100, 160));
        assert_eq!(merged[0].1.pairs.len(), 60);
        assert_eq!(merged[0].1.score, 0.9);
        let agg = aggregate(merged.iter().map(|(_, m)| m), 0.35);
        assert_eq!(agg.len(), 1);
        assert_eq!(agg[0].matches, 2);
        assert_eq!(agg[0].aligned_tokens, 80);
    }

    /// A fake corpus: three pages, phrase search by lemma.
    struct Fake {
        pages: Vec<Page>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl BookSource for Fake {
        fn corpus_version(&self) -> &str {
            "t"
        }
        fn books(&self) -> Result<Vec<BookMetadata>> {
            unimplemented!()
        }
        fn book(&self, _id: u64) -> Result<Option<BookMetadata>> {
            unimplemented!()
        }
        fn book_pages(&self, _id: u64, _p: &dyn Fn(u64, u64)) -> Result<Vec<Page>> {
            unimplemented!()
        }
        fn page_refs(&self, _id: u64) -> Result<Vec<PageRef>> {
            unimplemented!()
        }
        fn page(&self, id: u64, part: u32, page: u64) -> Result<Option<Page>> {
            Ok(self.pages.iter().find(|p| p.book_id == id && p.part_index == part && p.page_id == page).cloned())
        }
        fn freq_table(&self, _layer: FreqLayer) -> Result<Arc<FreqTable>> {
            unimplemented!()
        }
        fn page_entries(&self, _id: u64) -> anyhow::Result<Vec<crate::source::PageEntry>> { Ok(vec![]) }
        fn search_book(&self, _b: u64, _a: &[crate::commands::search::Term], _o: &[crate::commands::search::Term], _l: usize, _f: usize) -> anyhow::Result<crate::commands::search::SearchResults> {
            Ok(crate::commands::search::SearchResults { hits: vec![], total: 0, elapsed_ms: 0, capped: false })
        }
        fn authors(&self) -> anyhow::Result<Vec<crate::source::NamedId>> { Ok(vec![]) }
        fn genres(&self) -> anyhow::Result<Vec<crate::source::NamedId>> { Ok(vec![]) }
        fn toc(&self, _id: u64) -> anyhow::Result<Vec<crate::source::TocNode>> { Ok(vec![]) }
        fn toc_rows(&self, _id: u64) -> anyhow::Result<Vec<crate::source::TocRow>> { Ok(vec![]) }
        fn toc_status(&self) -> anyhow::Result<()> { Ok(()) }
        fn find_pages(&self, q: &CandidateQuery) -> Result<Hits> {
            self.calls.lock().unwrap().push(q.terms.clone());
            let pages: Vec<PageRef> = self
                .pages
                .iter()
                .filter(|p| q.book_ids.as_ref().map(|b| b.contains(&p.book_id)).unwrap_or(true))
                .filter(|p| {
                    let l: Vec<String> = match q.layer {
                        crate::source::Layer::Surface => p.tokens.iter().map(|t| normalize_arabic(&t.surface)).collect(),
                        _ => p.tokens.iter().map(|t| t.lemma.clone()).collect(),
                    };
                    l.windows(q.terms.len()).any(|w| w.iter().zip(&q.terms).all(|(a, b)| a == b))
                })
                .map(|p| PageRef { book_id: p.book_id, part_index: p.part_index, page_id: p.page_id })
                .collect();
            Ok(Hits { total: pages.len(), pages })
        }
    }

    #[test]
    fn reserved_slots_keep_both_key_lengths_where_a_merged_pool_would_not() {
        // The bigram run gained findings and lost others because switching
        // the key replaced the six anchors rather than adding to them. A
        // merged pool cannot fix that: the pick sorts by df ascending and a
        // trigram is always rarer than the bigrams inside it, so every slot
        // would go to trigrams. The slots have to be reserved.
        let f = freq(&[("a", 100), ("b", 90), ("c", 80), ("d", 70), ("e", 60), ("z", 1)]);
        let df = |t: &[String]| -> Result<usize> { Ok(if t.len() == 3 { 3 } else { 30 }) };
        let pg = page(1, 0, 1, "", "a b c d e z b c a");
        let mut it = Interner::default();

        let one = Params { banality_rank: 1, anchors: 4, min_anchors: 1, anchor_df_cap: 500, anchor_slots: Vec::new(), ..Default::default() };
        let s1 = Seq::build(&pg.tokens, &mut it, &f, &one, &[], &[]);
        let wide = anchors(&s1, &pg.tokens, &one, &df).unwrap();
        assert!(wide.iter().all(|a| a.terms.len() == 3), "one key, one length");

        let split = Params {
            anchor_slots: vec![AnchorSlot { gram: 3, anchors: 4, df_cap: 500 }, AnchorSlot { gram: 2, anchors: 4, df_cap: 200 }],
            ..one.clone()
        };
        let got = anchors(&s1, &pg.tokens, &split, &df).unwrap();
        assert!(got.iter().any(|a| a.terms.len() == 3), "trigrams kept");
        assert!(got.iter().any(|a| a.terms.len() == 2), "bigrams added");
        // Nothing the single key found is given up.
        for a in &wide {
            assert!(got.iter().any(|x| x.terms == a.terms), "{:?} survives the split", a.terms);
        }
    }

    #[test]
    fn windows_are_cut_against_the_stream_so_a_query_passage_is_not_halved() {
        // The query side of the same defect. A quotation lying across a page
        // break in the *citing* book was cut by the window grid, which put a
        // boundary every hundred-odd tokens where the text has none.
        let lens = [10usize, 10, 10];
        let ws = stream_windows(&lens, 12, 6, 6);
        // Windows run over the whole 30 tokens, not three lots of ten.
        assert_eq!(ws[0], StreamWindow { first_page: 0, last_page: 1, range: 0..12 });
        assert_eq!(ws[1], StreamWindow { first_page: 0, last_page: 1, range: 6..18 });
        assert_eq!(ws[2], StreamWindow { first_page: 1, last_page: 2, range: 2..14 });
        assert!(ws.iter().any(|w| w.first_page != w.last_page), "a window spans pages");

        let f = freq(&[("و", 1000), ("في", 900)]);
        let p = Params { banality_rank: 2, min_aligned: 6, banality_baseline: Some(0.3), ..Default::default() };
        // Six words at the foot of one page and six at the head of the next.
        let head = page(1, 0, 1, "", "باب اخر من الكلام المربد كل شيء حبست");
        let tail = page(1, 0, 2, "", "به الابل و هو موضع سوق ثم رجع");
        let target = page(2, 0, 5, "", "قال ابو عبيد المربد كل شيء حبست به الابل و هو موضع سوق الابل");
        let fake = Fake { pages: vec![head.clone(), tail.clone(), target, page(2, 0, 4, "", "لا شيء هنا")], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let pages = vec![head.clone(), tail];
        let lens: Vec<usize> = pages.iter().map(|x| x.tokens.len()).collect();
        let n: usize = lens.iter().sum();
        let zones = vec![None; n];
        let best = stream_windows(&lens, 60, 30, 6)
            .into_iter()
            .filter_map(|w| passage(&fake, &f, &p, &[], &pages[w.first_page..=w.last_page], w.range, &zones, None, &count, &load, &alone, None, &|| false).ok())
            .flat_map(|r| r.matches)
            .max_by_key(|m| m.components.aligned)
            .expect("the split quotation is found");
        assert!(best.components.aligned >= 10, "both halves align: {}", best.components.aligned);
        assert_eq!(best.query.page_id, 1, "reported on the page it starts on");
        assert_eq!(best.query_end.map(|x| x.page_id), Some(2), "and carries the page it ends on");
        assert!(best.q_end > head.tokens.len(), "q_end {} runs past the start page's {} tokens", best.q_end, head.tokens.len());

        // Page at a time, neither half reaches the floor.
        for pg in &pages {
            let zs = vec![None; pg.tokens.len()];
            for w in windows(pg.tokens.len(), 60, 30, 6) {
                let run = passage(&fake, &f, &p, &[], std::slice::from_ref(pg), w, &zs, None, &count, &load, &alone, None, &|| false).unwrap();
                assert!(run.matches.iter().all(|m| m.components.aligned < 10), "a page on its own only has half");
            }
        }
    }

    #[test]
    fn a_quotation_split_by_a_page_break_is_one_match_over_two_pages() {
        // The printer's break is not a boundary of the text. Half the
        // quotation sits at the foot of one page and half at the head of the
        // next; page by page neither half reaches min_aligned, and the
        // passage was invisible. Over the two together it is one match,
        // reported on the page it starts on, with the page it ends on.
        let f = freq(&[("و", 1000), ("في", 900)]);
        let p = Params { banality_rank: 2, min_aligned: 6, banality_baseline: Some(0.3), ..Default::default() };
        let quote = "المربد كل شيء حبست به الابل و هو موضع سوق";
        let query = page(1, 0, 1, "", &format!("قال ابو عبيد {} ثم رجع الي الكلام", quote));
        let head = page(2, 0, 10, "", "باب ما جاء في المربد كل شيء حبست");
        let tail = page(2, 0, 11, "", "به الابل و هو موضع سوق الابل بالبصرة");
        let elsewhere = page(2, 0, 9, "", "لا شيء هنا");
        let head_len = head.tokens.len();
        let fake = Fake { pages: vec![query.clone(), elsewhere, head, tail], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let refs: Vec<PageRef> = (9..=11).map(|g| PageRef { book_id: 2, part_index: 0, page_id: g }).collect();
        let around = |r: &PageRef, n: usize| Ok(span_around(&refs, r, n));
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &around, None, &|| false).unwrap();
        let best = run.matches.first().expect("the split quotation is found");
        assert_eq!(best.target.page_id, 10, "reported on the page it starts on");
        assert_eq!(best.target_end.map(|p| p.page_id), Some(11), "and carries the page it ends on");
        assert!(best.components.aligned >= 10, "both halves align: {}", best.components.aligned);
        // The offsets run past the start page's last token into the next.
        assert!(best.t_end > head_len, "t_end {} vs {} tokens", best.t_end, head_len);

        // One page at a time, the same quotation is lost.
        let alone = Params { target_neighbours: 0, ..p.clone() };
        let run = passage(&fake, &f, &alone, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &around, None, &|| false).unwrap();
        assert!(run.matches.iter().all(|m| m.components.aligned < 10), "each half is under the floor on its own");
    }

    #[test]
    fn exhaustive_retrieval_looks_up_every_gram_and_selects_nothing() {
        // The mode exists because selection is what loses a short
        // quotation: a window whose rarest trigrams all belong to the citing
        // author's own prose contributes no anchor that the quoted book
        // could hold. Reading the book instead of querying for it has no
        // such failure.
        let f = freq(&[("و", 1000), ("في", 900)]);
        let quote = "المربد كل شيء حبست به الابل";
        // The window is mostly Ibn Qutayba-ish framing; the quotation is six
        // words in the middle of it.
        let query = page(1, 0, 1, "", &format!("قال ابو محمد وقد تدبرت هذا التفسير وناظرت فيه {} ثم رجع الي الكلام", quote));
        let target = page(2, 0, 5, "", &format!("باب ما جاء في {} و هو موضع سوق", quote));
        let noise = page(2, 0, 6, "", "لا شيء هنا يذكر");
        let fake = Fake { pages: vec![query.clone(), target.clone(), noise.clone()], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);

        let ix = BookIndex::build(&[target.clone(), noise], &[2, 3]);
        assert_eq!(ix.pages(), 2);
        assert!(ix.keys() > 0);

        let base = Params { banality_rank: 2, min_aligned: 6, banality_baseline: Some(0.3), target_books: vec![2], ..Default::default() };
        let ex = Params { retrieval: RetrievalMode::Exhaustive, ..base.clone() };
        assert!(ex.exhaustive());
        assert_eq!(ex.aligned_floor(), 4, "the floor is a different claim between two books");
        assert_eq!(base.aligned_floor(), 6);

        let run = passage(&fake, &f, &ex, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, Some(&ix), &|| false).unwrap();
        let best = run.matches.first().expect("the quotation is found");
        assert_eq!(best.target.page_id, 5);
        assert!(best.components.aligned >= 6, "{}", best.components.aligned);
        // The page that shares nothing is not a candidate at all.
        assert!(run.matches.iter().all(|m| m.target.page_id == 5));

        // More books than the ceiling allows falls back to corpus mode.
        let many = Params { target_books: (1..=99).collect(), ..ex.clone() };
        assert!(!many.exhaustive());
        assert_eq!(many.aligned_floor(), 6);
    }

    #[test]
    fn a_target_book_restricts_retrieval_and_not_the_frequency_count() {
        // Pairwise mode. The restriction has to reach the index, or the run
        // reads the whole corpus and throws most of it away; but document
        // frequency is a fact about the corpus, and counting it inside one
        // book would make every anchor look rare and none of them usable.
        let f = freq(&[("و", 1000), ("في", 900)]);
        let query = page(1, 0, 1, "", "و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let reuse = page(2, 0, 7, "", "قال و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا ثم قال");
        let partial = page(3, 0, 2, "", "كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let fake = Fake { pages: vec![query.clone(), reuse, partial], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let base = Params { banality_rank: 2, anchors: 6, min_anchors: 3, banality_baseline: Some(0.3), ..Default::default() };
        let p = Params { target_books: vec![3], ..base.clone() };
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, None, &|| false).unwrap();
        assert_eq!(run.candidates, 1);
        assert!(run.matches.iter().all(|m| m.target.book_id == 3), "only the chosen book is searched");
        // The same anchors, at the same corpus-wide frequencies, as the
        // unrestricted run: nothing about the query has changed.
        let wide = passage(&fake, &f, &base, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, None, &|| false).unwrap();
        assert_eq!(run.anchors, wide.anchors);
    }

    #[test]
    fn a_short_quotation_in_a_long_window_is_scored_as_itself() {
        // The failure this change exists to fix. Six words quoted exactly,
        // sitting in a window of unrelated text. Scored against the window
        // the coverage was a fraction and the match vanished under the
        // threshold; scored against its own span it is what it is.
        let f = freq(&[("و", 1000), ("في", 900)]);
        let p = Params { banality_rank: 2, banality_baseline: Some(0.3), ..Default::default() };
        let filler_a = "ثم ذكر المؤلف بابا اخر في الطهارة و ما يتصل بها من الاحكام";
        let quote = "اتقوا الملاعن و اعدوا النبل للاستنجاء من الحجارة";
        let filler_b = "ثم رجع الي الكلام في الصلاة و مواقيتها و ما ورد فيها";
        let (q, t) = seqs(
            &format!("{} {} {}", filler_a, quote, filler_b),
            &format!("قال النبي {} قال الاصمعي", quote),
            &f,
            &p,
        );

        let all = align_all(&q, &t, &p);
        assert_eq!(all.len(), 1, "one passage is shared, not several");
        let pairs = &all[0].pairs;
        let lo = pairs.iter().map(|x| x.0).min().unwrap();
        let hi = pairs.iter().map(|x| x.0).max().unwrap() + 1;
        assert!(lo >= 11, "the quotation is in the middle of the window, at {}", lo);
        assert!(hi - lo <= 8, "the span is the quotation, not the window: {}..{}", lo, hi);

        // Scored on the span, as `passage` now does it.
        let span_non_banal = q.banal[lo..hi].iter().filter(|b| !**b).count().max(1);
        let on_span = components(&q, &t, pairs, span_non_banal, &p);
        // Scored on the window, as it used to be.
        let on_window = components(&q, &t, pairs, q.non_banal(), &p);

        assert!((on_span.coverage - 1.0).abs() < 1e-9, "coverage {}", on_span.coverage);
        assert!(on_window.coverage < 0.35, "the window buried it at {}", on_window.coverage);
        assert!(score(&on_span, &p) >= p.threshold, "score {}", score(&on_span, &p));
        assert!(score(&on_window, &p) < p.threshold, "old score {}", score(&on_window, &p));
    }

    #[test]
    fn two_quotations_on_one_page_are_two_matches() {
        // One span stretched across the gap between them is not what
        // happened, and it is not what gets reported.
        let f = freq(&[("و", 1000)]);
        let p = Params { banality_rank: 1, min_aligned: 5, proximity_window: 3, ..Default::default() };
        let (q, t) = seqs(
            "اتقوا الملاعن و اعدوا النبل ثم قال المؤلف كلاما اخر ثم قال ان الجدف نبات يكون باليمن",
            "اتقوا الملاعن و اعدوا النبل \
             هنا كلام طويل جدا لا علاقة له بشيء مما سبق ولا بما يلحقه من حديث \
             وقال ايضا ان الجدف نبات يكون باليمن",
            &f,
            &p,
        );
        let all = align_all(&q, &t, &p);
        assert_eq!(all.len(), 2, "{:?}", all.iter().map(|a| a.pairs.len()).collect::<Vec<_>>());
        for a in &all {
            assert!(a.pairs.len() >= p.min_aligned);
        }
    }

    #[test]
    fn a_chain_of_transmission_is_formulaic_at_any_length() {
        let f = freq(&[("عن", 1000), ("بن", 900)]);
        let p = Params { banality_rank: 2, ..Default::default() };
        let c = Components {
            surface_agree: 1.0,
            lemma_agree: 1.0,
            root_agree: 1.0,
            coverage: 1.0,
            banal_share: 0.1,
            banality_factor: 1.0,
            aligned: 7,
        };
        assert_eq!(match_type(&c, &p), MatchType::Verbatim);
        assert_eq!(match_type_in(&c, None, &p), MatchType::Verbatim);
        assert_eq!(match_type_in(&c, Some(Zone::Quran), &p), MatchType::Verbatim);
        // Seven aligned tokens of a chain of transmission: two unrelated
        // hadiths share that much and nothing else.
        assert_eq!(match_type_in(&c, Some(Zone::Isnad), &p), MatchType::Formulaic);
        // Length does not rescue it. A twenty-token chain shared by two
        // books is still a chain, and the rule that reported it -- formulaic
        // only below twice the aligned floor -- is what filled a tabaqat
        // comparison with matches of nothing but names.
        let long = Components { aligned: 20, ..c };
        assert_eq!(match_type_in(&long, Some(Zone::Isnad), &p), MatchType::Formulaic);
        // The zone is decided on the aligned tokens, not on the page, so a
        // matn parallel that merely opens with a chain is not caught: that
        // is `zone_of`, tested in its own right.
    }

    #[test]
    fn passage_mode_end_to_end_on_a_fake_corpus() {
        let f = freq(&[("و", 1000), ("في", 900)]);
        let p = Params { banality_rank: 2, anchors: 6, min_anchors: 3, banality_baseline: Some(0.3), ..Default::default() };
        let query = page(1, 0, 1, "", "و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let reuse = page(2, 0, 7, "", "قال و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا ثم قال");
        let partial = page(3, 0, 2, "", "كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let noise = page(4, 0, 3, "", "لا شيء هنا يذكر عن مدينة");
        // Six trigram anchors and four bigram ones: the shipped default.
        let fake = Fake { pages: vec![query.clone(), reuse, partial, noise], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, None, &|| false).unwrap();
        assert_eq!(run.anchors.len(), 10, "{:?}", run.anchors);
        assert_eq!(run.anchors.iter().filter(|a| a.terms.len() == 3).count(), 6);
        assert_eq!(run.anchors.iter().filter(|a| a.terms.len() == 2).count(), 4);
        assert_eq!(run.candidates, 2, "the query's own page is excluded and noise hits nothing");
        assert!(run.anchors.iter().all(|a| a.df >= 2), "{:?}", run.anchors);
        assert_eq!(run.matches.len(), 2);
        let best = &run.matches[0];
        assert_eq!(best.target.book_id, 2);
        assert_eq!(best.kind, MatchType::Verbatim);
        assert_eq!((best.q_start, best.q_end), (0, 14));
        assert_eq!((best.t_start, best.t_end), (1, 15));
        assert!((best.components.coverage - 1.0).abs() < 1e-9);
        assert!((best.components.banal_share - 4.0 / 14.0).abs() < 1e-9);
        assert_eq!(best.components.banality_factor, 1.0, "4/14 banal is below the 0.3 baseline");
        assert!((best.score - 0.7).abs() < 1e-9, "1 × (0.5·1 + 0.3·0 + 0.2·1) × 1: the fixture has no roots");
        let second = &run.matches[1];
        assert_eq!(second.target.book_id, 3);
        // The partial page quotes ten of the query's words and stops. It is
        // scored on what it shares, not on what it leaves out: a short
        // quotation is a quotation, and dividing it by the length of the
        // window that retrieved it is what used to bury it. What separates
        // the two matches is how much each aligns, not the window.
        assert!((second.components.coverage - 1.0).abs() < 1e-9);
        assert!(second.components.aligned < best.components.aligned);
        assert!(second.score <= best.score);
        // Exclude the whole book 2.
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], Some(2), &count, &load, &alone, None, &|| false).unwrap();
        assert_eq!(run.matches.len(), 1);
        // Cancel before the first candidate keeps the anchors and nothing else.
        let run = passage(&fake, &f, &p, &[], std::slice::from_ref(&query), 0..query.tokens.len(), &[], None, &count, &load, &alone, None, &|| true).unwrap();
        assert!(run.matches.is_empty());
    }
}
