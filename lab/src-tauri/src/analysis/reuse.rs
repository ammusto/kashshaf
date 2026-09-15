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
        }
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
    let mut seen: HashMap<[u32; 3], usize> = HashMap::new();
    let mut out: Vec<Anchor> = Vec::new();
    if q.len() < 3 {
        return out;
    }
    for i in 0..=q.len() - 3 {
        let ok = (i..i + 3).all(|j| q.lemma[j].is_some() && (!params.exclude_zones_from_anchoring || q.zone[j].is_none()));
        if !ok {
            continue;
        }
        let key = [q.lemma[i].unwrap(), q.lemma[i + 1].unwrap(), q.lemma[i + 2].unwrap()];
        if seen.contains_key(&key) {
            continue;
        }
        seen.insert(key, out.len());
        let rank_sum = (i..i + 3).map(|j| rank_value(q.rank[j])).sum();
        out.push(Anchor { start: i, terms: tokens[i..i + 3].iter().map(|t| t.lemma.clone()).collect(), rank_sum, df: 0 });
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
    let all = trigrams(q, tokens, params);
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
    let cap = params.max_candidates.max(1);
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
    own: &PageRef,
    exclude_book: Option<u64>,
    non_banal: usize,
    params: &Params,
) -> Result<Vec<Candidate>> {
    let mut hits: HashMap<(u64, u32, u64), usize> = HashMap::new();
    let mut rare: std::collections::HashSet<(u64, u32, u64)> = std::collections::HashSet::new();
    for a in anchors {
        let q = CandidateQuery { layer: crate::source::Layer::Lemma, terms: a.terms.clone(), limit: params.max_candidates.max(1), slop: 0 };
        for p in source.find_pages(&q)?.pages {
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
                && !(*b == own.book_id && *p == own.part_index && *g == own.page_id)
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
    let first = smith_waterman(q, t, 0..t.len(), &q_mask, &t_mask, p)?;
    if first.pairs.len() < p.min_aligned {
        return None;
    }
    let mut all = first.clone();
    if p.proximity {
        let t_first = first.pairs[0].1;
        let lo = t_first.saturating_sub(p.proximity_window);
        let hi = (first.pairs.last().unwrap().1 + 1 + p.proximity_window).min(t.len());
        for (a, b) in &first.pairs {
            q_mask[*a] = true;
            t_mask[*b] = true;
        }
        for _ in 0..8 {
            let Some(next) = smith_waterman(q, t, lo..hi, &q_mask, &t_mask, p) else { break };
            // A fragment: at least half the minimum, so an inflected tail
            // after a gap still counts, but not a chance bigram.
            if next.pairs.len() < (p.min_aligned / 2).max(2) || next.pairs[0].1.abs_diff(t_first) > p.proximity_window {
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

/// §4.3's type table, `formulaic` first (see the module header).
pub fn match_type(c: &Components) -> MatchType {
    if c.banality_factor < 0.3 {
        MatchType::Formulaic
    } else if c.surface_agree >= 0.9 {
        MatchType::Verbatim
    } else if c.lemma_agree >= 0.85 {
        MatchType::Inflected
    } else if c.root_agree >= 0.7 {
        MatchType::Paraphrase
    } else {
        MatchType::Weak
    }
}

/// Recompute what the banality scale, weights and threshold affect from the
/// stored components — the UI's re-scoring without a re-run.
pub fn rescore(c: &Components, p: &Params) -> (Components, f64, MatchType) {
    let mut c = *c;
    c.banality_factor = banality_factor(c.banal_share, p);
    let s = score(&c, p);
    (c, s, match_type(&c))
}

// ---------------------------------------------------------------- matches ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Match {
    pub target: PageRef,
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
fn fallback_candidates(source: &dyn BookSource, tokens: &[Token], own: &PageRef, exclude_book: Option<u64>, params: &Params) -> Result<(Vec<Candidate>, Option<&'static str>)> {
    let keep = |p: &PageRef| !(p.book_id == own.book_id && p.part_index == own.part_index && p.page_id == own.page_id) && exclude_book.map(|x| x != p.book_id).unwrap_or(true);
    let lemmas: Vec<String> = tokens.iter().map(|t| t.lemma.clone()).filter(|l| !l.is_empty()).collect();
    if lemmas.len() >= 2 {
        // The compound index refuses a slop phrase whose slots are too wide;
        // the exact lemma phrase is the next best thing, not an error.
        for (slop, label) in [(params.fallback_slop, "lemma-slop"), (0, "lemma")] {
            let q = CandidateQuery { layer: crate::source::Layer::Lemma, terms: lemmas.clone(), limit: params.max_candidates.max(1), slop };
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
        let q = CandidateQuery { layer: crate::source::Layer::Surface, terms: surfaces, limit: params.max_candidates.max(1), slop: 0 };
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
    Ok(source.find_pages(&CandidateQuery { layer: crate::source::Layer::Lemma, terms: terms.to_vec(), limit: 1, slop: 0 })?.total)
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
    page: &Page,
    range: Range<usize>,
    zones: &[Option<Zone>],
    exclude_book: Option<u64>,
    count: &dyn Fn(&[String]) -> Result<usize>,
    load: &dyn Fn(&PageRef) -> Result<Option<Page>>,
    cancel: &dyn Fn() -> bool,
) -> Result<PassageRun> {
    let mut intern = Interner::default();
    let tokens = &page.tokens[range.clone()];
    let page_zones: Vec<Option<Zone>> = (range.clone()).map(|i| zones.get(i).copied().flatten()).collect();
    let q = Seq::build(tokens, &mut intern, freq, params, banal_phrases, &page_zones);
    let non_banal = q.non_banal();
    let own = PageRef { book_id: page.book_id, part_index: page.part_index, page_id: page.page_id };
    let anchors = anchors(&q, tokens, params, count)?;
    let mut cands = if anchors.is_empty() { Vec::new() } else { candidates(source, &anchors, &own, exclude_book, non_banal, params)? };
    // A short passage, or one with no anchor, also goes to the index whole;
    // its hits join the anchor candidates.
    let mut fallback = None;
    if tokens.len() < params.fallback_max_tokens || anchors.is_empty() {
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
        let Some(tp) = load(&c.page)? else { continue };
        let t = Seq::build(&tp.tokens, &mut intern, freq, params, banal_phrases, &[]);
        let Some(al) = align_page(&q, &t, params) else { continue };
        let mut comp = components(&q, &t, &al.pairs, non_banal, params);
        if tokens.len() < params.fallback_max_tokens || anchors.is_empty() {
            // The user chose this short passage whole: the banality penalty,
            // meant for chance overlaps of common words in a long window,
            // would hide exactly what was asked for (amendment 1.4).
            comp.banality_factor = 1.0;
        }
        let s = score(&comp, params);
        let pairs: Vec<(usize, usize)> = al.pairs.iter().map(|(i, j)| (i + range.start, *j)).collect();
        let q_start = pairs.iter().map(|p| p.0).min().unwrap();
        let q_end = pairs.iter().map(|p| p.0).max().unwrap() + 1;
        let t_start = pairs.iter().map(|p| p.1).min().unwrap();
        let t_end = pairs.iter().map(|p| p.1).max().unwrap() + 1;
        matches.push(Match {
            target: c.page.clone(),
            q_start,
            q_end,
            t_start,
            t_end,
            zone: zone_of(&q, &al.pairs),
            pairs,
            components: comp,
            score: s,
            kind: match_type(&comp),
            anchor_hits: c.hits,
        });
    }
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
        let p = Params { banality_rank: 1, anchors: 2, min_anchors: 1, ..Default::default() };
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
        let run = passage(&fake, &f, &p, &[], &query, 3..10, &[], None, &count, &load, &|| false).unwrap();
        assert_eq!(run.fallback, Some("lemma-slop"), "{:?}", run);
        assert_eq!(run.matches.len(), 1);
        assert_eq!(run.matches[0].target.book_id, 2);
        assert_eq!(run.matches[0].kind, MatchType::Verbatim, "no banality penalty on a whole-passage query: {:?}", run.matches[0].components);
        assert_eq!(run.matches[0].components.aligned, 7);
        // With context around it (13 tokens) the trigram counts find it too:
        // `من أين تأكلون` is on two pages, the context trigrams on one.
        let run = passage(&fake, &f, &p, &[], &query, 0..query.tokens.len(), &[], None, &count, &load, &|| false).unwrap();
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
        assert_eq!(match_type(&c), MatchType::Inflected);
        // Banality wins over verbatim: three of four aligned tokens banal → factor 0.
        let mut c2 = c;
        c2.surface_agree = 1.0;
        c2.banal_share = 0.75;
        c2.banality_factor = banality_factor(0.75, &p);
        assert_eq!(c2.banality_factor, 0.0);
        assert_eq!(match_type(&c2), MatchType::Formulaic);
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
        assert_eq!(match_type(&c3), MatchType::Paraphrase);
        let c4 = Components { root_agree: 0.5, ..c3 };
        assert_eq!(match_type(&c4), MatchType::Weak);
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
    fn passage_mode_end_to_end_on_a_fake_corpus() {
        let f = freq(&[("و", 1000), ("في", 900)]);
        let p = Params { banality_rank: 2, anchors: 6, min_anchors: 3, banality_baseline: Some(0.3), ..Default::default() };
        let query = page(1, 0, 1, "", "و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let reuse = page(2, 0, 7, "", "قال و في مدينة الحكمة كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا ثم قال");
        let partial = page(3, 0, 2, "", "كتب الشيخ رسالة طويلة عن الزهد و الورع في الدنيا");
        let noise = page(4, 0, 3, "", "لا شيء هنا يذكر عن مدينة");
        let fake = Fake { pages: vec![query.clone(), reuse, partial, noise], calls: Mutex::new(vec![]) };
        let load = |r: &PageRef| fake.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| phrase_df(&fake, t);
        let run = passage(&fake, &f, &p, &[], &query, 0..query.tokens.len(), &[], None, &count, &load, &|| false).unwrap();
        assert_eq!(run.anchors.len(), 6, "{:?}", run.anchors);
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
        assert!(second.components.coverage < 1.0 && second.score < best.score);
        // Exclude the whole book 2.
        let run = passage(&fake, &f, &p, &[], &query, 0..query.tokens.len(), &[], Some(2), &count, &load, &|| false).unwrap();
        assert_eq!(run.matches.len(), 1);
        // Cancel before the first candidate keeps the anchors and nothing else.
        let run = passage(&fake, &f, &p, &[], &query, 0..query.tokens.len(), &[], None, &count, &load, &|| true).unwrap();
        assert!(run.matches.is_empty());
    }
}
