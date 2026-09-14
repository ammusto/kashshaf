//! Qurʾānic quotation detection (Lab spec §4.4).
//!
//! The Qurʾān is the source text; a page is the query. An in-memory lemma
//! n-gram index over the shipped text (`quran_data`) seeds alignments: every
//! lemma trigram of the page that is not wholly banal and occurs in the
//! Qurʾān starts a local alignment (§4.3's Smith–Waterman) between the page
//! around the seed and the āyāt around the hit. An alignment of ≥ 4 tokens
//! with `lemma_agree ≥ 0.8` is a quotation; ≥ 3 tokens with a typographic
//! or verbal cue within 3 tokens (`﴿ ﴾`, `«»`, `قال تعالى`) is too.
//!
//! Two readings of the spec fixed here:
//!
//! - "every lemma 3-gram that is non-banal" is taken as *not entirely
//!   banal* — with the top-300 lemmas at 62% of running text, requiring three
//!   non-banal tokens in a row would miss `قل هو الله أحد` and most short
//!   quotations. Alignment, not the seed, decides.
//! - Tanzil prints the basmala at the head of āya 1 of every sūra but the
//!   first and the ninth. Those 112 copies are not indexed: a basmala on a
//!   page is 1:1, and a quotation that runs on from a sūra's basmala into
//!   its first āya still aligns through it.

use crate::analysis::align::{char_to_token_map, strip_html};
use crate::analysis::reuse::{self, Interner, Params as ReuseParams, Seq};
use crate::quran_data::QuranText;
use crate::source::{FreqTable, Token};
use kashshaf_engine::normalize_arabic;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const DETECTOR_VERSION: &str = "0.2.0";

/// `بسم الله الرحمن الرحيم`: four tokens at the head of every sūra but 1 and 9.
const BASMALA_TOKENS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Params {
    /// Aligned tokens a quotation needs without a cue (4).
    pub min_tokens: usize,
    /// Lemma agreement a quotation needs (0.8).
    pub min_lemma_agree: f64,
    /// Aligned tokens a *cued* quotation needs (3).
    pub cued_min_tokens: usize,
    /// How far from the span a cue may sit, in tokens (3).
    pub cue_window: usize,
    /// Lemma rank at or below which a token is banal for seeding (300).
    pub banality_rank: u32,
    /// Page tokens on either side of a seed the alignment may extend into.
    pub page_window: usize,
}

impl Default for Params {
    fn default() -> Self {
        Self { min_tokens: 4, min_lemma_agree: 0.8, cued_min_tokens: 3, cue_window: 3, banality_rank: 300, page_window: 40 }
    }
}

/// A detected quotation on one page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hit {
    /// Page span (end exclusive).
    pub tok_start: usize,
    pub tok_end: usize,
    pub sura: u32,
    pub aya_start: u32,
    pub aya_end: u32,
    /// Span in the sūra's tokens (page-local indices of the shipped text).
    pub q_tok_start: usize,
    pub q_tok_end: usize,
    pub lemma_agree: f64,
    pub surface_agree: f64,
    pub aligned: usize,
    pub cue: Option<String>,
    /// Every other āya the span aligns to equally well (same length and
    /// agreement) — amendment 1.4: an ambiguous hit lists them all rather
    /// than choosing one. Empty when unambiguous.
    pub also: Vec<AyaRef>,
}

/// One āya range of an ambiguous hit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AyaRef {
    pub sura: u32,
    pub aya_start: u32,
    pub aya_end: u32,
    pub q_tok_start: usize,
    pub q_tok_end: usize,
}

/// The n-gram index over the Qurʾān's lemmas, built once at startup.
pub struct QuranIndex {
    /// Every lemma, root and normalised surface of the Qurʾān → id; page
    /// strings outside it get ids beyond `intern.len()` per page.
    intern: Interner,
    /// Per sūra: lemma ids per token.
    suras: Vec<Vec<u32>>,
    /// Per sūra: root ids and normalised surfaces, for agreement.
    roots: Vec<Vec<Option<u32>>>,
    surfaces: Vec<Vec<u32>>,
    /// Trigram → `(sura index, token offset)`.
    trigrams: HashMap<[u32; 3], Vec<(u16, u32)>>,
    /// 4- and 5-gram counts: how many Qurʾān positions a longer n-gram has —
    /// cheap "is this exact" checks for the UI and the eval, and what the
    /// spec's "3/4/5-gram index" names.
    fourgrams: HashMap<[u32; 4], u32>,
    fivegrams: HashMap<[u32; 5], u32>,
}

impl QuranIndex {
    pub fn build(q: &QuranText) -> Self {
        let mut intern = Interner::default();
        let mut suras = Vec::with_capacity(q.pages.len());
        let mut roots = Vec::with_capacity(q.pages.len());
        let mut surfaces = Vec::with_capacity(q.pages.len());
        let mut trigrams: HashMap<[u32; 3], Vec<(u16, u32)>> = HashMap::new();
        let mut fourgrams: HashMap<[u32; 4], u32> = HashMap::new();
        let mut fivegrams: HashMap<[u32; 5], u32> = HashMap::new();
        for (si, page) in q.pages.iter().enumerate() {
            let ids: Vec<u32> = page
                .tokens
                .iter()
                .map(|t| intern.id(&t.lemma))
                .collect();
            roots.push(page.tokens.iter().map(|t| t.root.as_deref().filter(|r| !r.is_empty()).map(|r| intern.id(r))).collect());
            surfaces.push(page.tokens.iter().map(|t| intern.id(&normalize_arabic(&t.surface))).collect());
            // Sūra 1 is the basmala's home; sūra 9 has none. Elsewhere the
            // four opening tokens are the basmala and seed nothing.
            let first = if si == 0 || si == 8 { 0 } else { BASMALA_TOKENS.min(ids.len()) };
            for i in first..ids.len() {
                if i + 3 <= ids.len() {
                    trigrams.entry([ids[i], ids[i + 1], ids[i + 2]]).or_default().push((si as u16, i as u32));
                }
                if i + 4 <= ids.len() {
                    *fourgrams.entry([ids[i], ids[i + 1], ids[i + 2], ids[i + 3]]).or_insert(0) += 1;
                }
                if i + 5 <= ids.len() {
                    *fivegrams.entry([ids[i], ids[i + 1], ids[i + 2], ids[i + 3], ids[i + 4]]).or_insert(0) += 1;
                }
            }
            suras.push(ids);
        }
        Self { intern, suras, roots, surfaces, trigrams, fourgrams, fivegrams }
    }

    pub fn trigram_count(&self) -> usize {
        self.trigrams.len()
    }

    pub fn fourgram_count(&self) -> usize {
        self.fourgrams.len()
    }

    pub fn fivegram_count(&self) -> usize {
        self.fivegrams.len()
    }

    /// The Qurʾān-side sequence of one sūra as a reuse `Seq`.
    fn sura_seq(&self, si: usize) -> Seq {
        let n = self.suras[si].len();
        Seq {
            lemma: self.suras[si].iter().map(|&i| Some(i)).collect(),
            root: self.roots[si].clone(),
            surface: self.surfaces[si].clone(),
            rank: vec![u32::MAX; n],
            banal: vec![false; n],
            zone: vec![None; n],
        }
    }
}

/// Where the cues sit on a page: token indices adjacent to `﴿`/`﴾`, `«`/`»`,
/// and the token after `قال تعالى` / `قوله تعالى`.
fn cues(tokens: &[Token], body: &str) -> Vec<(usize, &'static str)> {
    let mut out = Vec::new();
    let text = strip_html(body);
    let map = char_to_token_map(&text);
    let n = tokens.len();
    let mut last_token = 0usize;
    for (ci, c) in text.chars().enumerate() {
        if let Some(Some(t)) = map.get(ci) {
            last_token = *t;
        }
        let label = match c {
            '\u{FD3E}' | '\u{FD3F}' => "﴿﴾",
            '«' | '»' => "«»",
            _ => continue,
        };
        // The bracket sits between two tokens: the last one seen and the next.
        let next = map[ci..].iter().flatten().next().copied().unwrap_or(n);
        out.push((last_token.min(n), label));
        if next < n {
            out.push((next, label));
        }
    }
    let norm: Vec<String> = tokens.iter().map(|t| normalize_arabic(&t.surface)).collect();
    for i in 0..n.saturating_sub(1) {
        if (norm[i] == "قال" || norm[i] == "قوله" || norm[i] == "قولة") && norm[i + 1] == "تعالي" {
            out.push((i + 2, "قال تعالى"));
        }
    }
    out
}

/// Detect the quotations on one page. `freq` (the corpus lemma table) is
/// used for seed banality; without it every trigram seeds.
pub fn detect_page(index: &QuranIndex, quran: &QuranText, tokens: &[Token], body: &str, freq: Option<&FreqTable>, params: &Params) -> Vec<Hit> {
    let n = tokens.len();
    if n < params.cued_min_tokens.min(params.min_tokens) {
        return Vec::new();
    }
    // Page sequence in the Qurʾān's id space; unknown lemmas get fresh ids.
    let mut extra: HashMap<String, u32> = HashMap::new();
    let base = index.intern.len() as u32;
    let mut id_of = |s: &str| -> u32 {
        if let Some(i) = index.intern.get(s) {
            return i;
        }
        let next = base + extra.len() as u32;
        *extra.entry(s.to_string()).or_insert(next)
    };
    let lemma_ids: Vec<u32> = tokens.iter().map(|t| id_of(&t.lemma)).collect();
    let root_ids: Vec<Option<u32>> = tokens.iter().map(|t| t.root.as_deref().filter(|r| !r.is_empty()).map(&mut id_of)).collect();
    let surf_ids: Vec<u32> = tokens.iter().map(|t| id_of(&normalize_arabic(&t.surface))).collect();
    let banal: Vec<bool> = tokens
        .iter()
        .map(|t| freq.and_then(|f| f.get(&t.lemma).rank).map(|r| r <= params.banality_rank).unwrap_or(false))
        .collect();
    let page_seq = Seq {
        lemma: lemma_ids.iter().map(|&i| Some(i)).collect(),
        root: root_ids,
        surface: surf_ids,
        rank: vec![u32::MAX; n],
        banal: banal.clone(),
        zone: vec![None; n],
    };
    let rp = ReuseParams { proximity: false, min_aligned: 1, ..ReuseParams::default() };
    let cue_list = cues(tokens, body);

    // Seeds: distinct (sura, quran offset, page offset) triples, one per
    // trigram hit; alignments that land on the same span are merged below.
    let mut hits: Vec<Hit> = Vec::new();
    let mut tried: std::collections::HashSet<(u16, u32, usize)> = std::collections::HashSet::new();
    for i in 0..n.saturating_sub(2) {
        if banal[i] && banal[i + 1] && banal[i + 2] {
            continue;
        }
        let key = [lemma_ids[i], lemma_ids[i + 1], lemma_ids[i + 2]];
        let Some(posts) = index.trigrams.get(&key) else { continue };
        for &(si, qo) in posts {
            // Skip a seed inside a hit already found for this āya region;
            // another posting of the same trigram elsewhere in the sūra is
            // a different reading and still aligns (amendment 1.4).
            let qo_us = qo as usize;
            if hits.iter().any(|h| h.sura as usize == si as usize + 1 && h.tok_start <= i && i + 3 <= h.tok_end && h.q_tok_start <= qo_us && qo_us + 3 <= h.q_tok_end) {
                continue;
            }
            // One alignment per posting (amendment 1.4: every āya an
            // ambiguous span could be counts), not per 64-token region.
            if !tried.insert((si, qo, i / 64)) {
                continue;
            }
            let p_lo = i.saturating_sub(params.page_window);
            let p_hi = (i + 3 + params.page_window).min(n);
            let page_part = page_seq.slice(p_lo..p_hi);
            let sura_seq = index.sura_seq(si as usize);
            let q_lo = (qo as usize).saturating_sub(params.page_window + 10);
            let q_hi = (qo as usize + 3 + params.page_window + 10).min(sura_seq.len());
            let q_mask = vec![false; page_part.len()];
            let t_mask = vec![false; sura_seq.len()];
            let Some(al) = reuse::smith_waterman(&page_part, &sura_seq, q_lo..q_hi, &q_mask, &t_mask, &rp) else { continue };
            if al.pairs.is_empty() {
                continue;
            }
            let pairs: Vec<(usize, usize)> = al.pairs.iter().map(|(a, b)| (a + p_lo, *b)).collect();
            let aligned = pairs.len();
            let lemma_eq = pairs.iter().filter(|(a, b)| page_seq.lemma[*a] == sura_seq.lemma[*b]).count();
            let surf_eq = pairs.iter().filter(|(a, b)| page_seq.surface[*a] == sura_seq.surface[*b]).count();
            let lemma_agree = lemma_eq as f64 / aligned as f64;
            let surface_agree = surf_eq as f64 / aligned as f64;
            let tok_start = pairs[0].0;
            let tok_end = pairs[aligned - 1].0 + 1;
            let cue = cue_list
                .iter()
                .find(|(t, _)| *t + params.cue_window >= tok_start && *t <= tok_end + params.cue_window)
                .map(|(_, l)| l.to_string());
            let accepted = (aligned >= params.min_tokens && lemma_agree >= params.min_lemma_agree)
                || (cue.is_some() && aligned >= params.cued_min_tokens && lemma_agree >= params.min_lemma_agree);
            if !accepted {
                continue;
            }
            let sura = si as u32 + 1;
            let q_tok_start = pairs[0].1;
            let q_tok_end = pairs[aligned - 1].1 + 1;
            let aya_start = quran.aya_at(sura, q_tok_start).map(|a| a.aya).unwrap_or(0);
            let aya_end = quran.aya_at(sura, q_tok_end - 1).map(|a| a.aya).unwrap_or(aya_start);
            hits.push(Hit { tok_start, tok_end, sura, aya_start, aya_end, q_tok_start, q_tok_end, lemma_agree, surface_agree, aligned, cue, also: vec![] });
        }
    }
    // Overlapping hits on the page: keep the longer (then the better
    // agreeing); a hit that ties the kept one exactly — same page span,
    // same length, same agreement — is not dropped but listed on it as an
    // alternative reading (amendment 1.4: ambiguous, every āya listed).
    hits.sort_by(|a, b| {
        b.aligned
            .cmp(&a.aligned)
            .then_with(|| b.lemma_agree.partial_cmp(&a.lemma_agree).unwrap())
            .then_with(|| b.surface_agree.partial_cmp(&a.surface_agree).unwrap())
            .then_with(|| a.tok_start.cmp(&b.tok_start))
            .then_with(|| a.sura.cmp(&b.sura))
            .then_with(|| a.aya_start.cmp(&b.aya_start))
    });
    let mut kept: Vec<Hit> = Vec::new();
    for h in hits {
        if let Some(k) = kept.iter_mut().find(|k| h.tok_start < k.tok_end && k.tok_start < h.tok_end) {
            let tie = k.tok_start == h.tok_start
                && k.tok_end == h.tok_end
                && k.aligned == h.aligned
                && (k.lemma_agree - h.lemma_agree).abs() < 1e-9
                && (k.surface_agree - h.surface_agree).abs() < 1e-9
                && !(k.sura == h.sura && k.aya_start == h.aya_start && k.aya_end == h.aya_end);
            if tie {
                k.also.push(AyaRef { sura: h.sura, aya_start: h.aya_start, aya_end: h.aya_end, q_tok_start: h.q_tok_start, q_tok_end: h.q_tok_end });
            }
            continue;
        }
        kept.push(h);
    }
    kept.sort_by_key(|h| h.tok_start);
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Page;
    use std::sync::OnceLock;

    fn quran() -> &'static (QuranText, QuranIndex) {
        static Q: OnceLock<(QuranText, QuranIndex)> = OnceLock::new();
        Q.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("kashshaf-lab-quran-idx-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let q = QuranText::load(&dir).unwrap();
            let idx = QuranIndex::build(&q);
            (q, idx)
        })
    }

    /// A page made of prose tokens with a stretch copied from the Qurʾān.
    fn page_with(q: &QuranText, sura: u32, aya: u32, skip: usize, take: usize, prefix: &[&str], suffix: &[&str], brackets: bool) -> Page {
        let a = *q.aya(sura, aya).unwrap();
        let quote: Vec<Token> = q.aya_tokens(&a).iter().skip(skip).take(take).cloned().collect();
        let mk = |i: usize, w: &str| Token { idx: i, surface: w.into(), noclitic_surface: None, lemma: w.into(), root: None, pos: "noun".into(), features: vec![], clitics: vec![] };
        let mut tokens: Vec<Token> = prefix.iter().enumerate().map(|(i, w)| mk(i, w)).collect();
        let mut words: Vec<String> = prefix.iter().map(|s| s.to_string()).collect();
        if brackets {
            words.push("﴿".into());
        }
        for t in &quote {
            let mut t = t.clone();
            t.idx = tokens.len();
            words.push(t.surface.clone());
            tokens.push(t);
        }
        if brackets {
            words.push("﴾".into());
        }
        for w in suffix {
            let i = tokens.len();
            tokens.push(mk(i, w));
            words.push(w.to_string());
        }
        Page { book_id: 9, part_index: 0, page_id: 1, part_label: String::new(), page_number: "1".into(), body: words.join(" "), tokens }
    }

    #[test]
    fn the_index_covers_the_text() {
        let (q, idx) = quran();
        assert_eq!(idx.suras.len(), 114);
        assert!(idx.trigram_count() > 40_000, "{}", idx.trigram_count());
        assert!(idx.fourgram_count() > idx.trigram_count());
        assert!(idx.fivegram_count() > idx.fourgram_count());
        let kursi = q.aya(2, 255).unwrap();
        let ids = &idx.suras[1][kursi.tok_start..kursi.tok_start + 3];
        assert!(idx.trigrams[&[ids[0], ids[1], ids[2]]].contains(&(1, kursi.tok_start as u32)));
    }

    #[test]
    fn a_verbatim_quotation_is_found_with_its_aya() {
        let (q, idx) = quran();
        let page = page_with(q, 2, 255, 0, 12, &["ثم", "ذكر", "المؤلف", "قوله"], &["وهذا", "كلام", "طويل"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &Params::default());
        assert_eq!(hits.len(), 1, "{:?}", hits);
        let h = &hits[0];
        assert_eq!((h.sura, h.aya_start, h.aya_end), (2, 255, 255));
        assert_eq!((h.tok_start, h.tok_end), (4, 16));
        assert_eq!(h.aligned, 12);
        assert_eq!(h.lemma_agree, 1.0);
        assert_eq!(h.surface_agree, 1.0);
        assert!(h.cue.is_none());
    }

    /// Amendment 1.4: `ولا تقربوا الزنا`? — no: a span that aligns equally to
    /// several āyāt is one hit listing them all. `فبأي آلاء ربكما تكذبان`
    /// (55:13 and thirty more) is the plainest case.
    #[test]
    fn an_equal_score_multi_aya_hit_is_ambiguous_and_lists_every_aya() {
        let (q, idx) = quran();
        let page = page_with(q, 55, 13, 0, 4, &["قال", "الشيخ"], &["ثم", "سكت"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &Params::default());
        assert_eq!(hits.len(), 1, "one hit, not thirty-one: {:?}", hits.iter().map(|h| (h.sura, h.aya_start)).collect::<Vec<_>>());
        let h = &hits[0];
        assert_eq!((h.sura, h.aya_start), (55, 13), "the first āya in muṣḥaf order is the primary reading");
        assert!(h.also.len() >= 20, "ambiguous over {} more āyāt", h.also.len());
        assert!(h.also.iter().all(|a| a.sura == 55 && a.aya_start > 13));
        assert!(h.also.iter().all(|a| a.aya_start == a.aya_end));
        // An unambiguous quotation lists nothing.
        let page = page_with(q, 2, 255, 0, 12, &["قوله"], &["الآية"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &Params::default());
        assert!(hits[0].also.is_empty());
    }

    #[test]
    fn a_quotation_crossing_an_aya_boundary_reports_both() {
        let (q, idx) = quran();
        // Last four tokens of 1:2 and all of 1:3, as one stretch.
        let a2 = *q.aya(1, 2).unwrap();
        let a3 = *q.aya(1, 3).unwrap();
        let mut tokens: Vec<Token> = q.pages[0].tokens[a2.tok_start..a3.tok_end].to_vec();
        for (i, t) in tokens.iter_mut().enumerate() {
            t.idx = i;
        }
        let body = tokens.iter().map(|t| t.surface.clone()).collect::<Vec<_>>().join(" ");
        let hits = detect_page(idx, q, &tokens, &body, None, &Params::default());
        assert_eq!(hits.len(), 1, "{:?}", hits);
        assert_eq!((hits[0].sura, hits[0].aya_start, hits[0].aya_end), (1, 2, 3));
    }

    #[test]
    fn short_quotes_need_a_cue_and_paraphrase_needs_agreement() {
        let (q, idx) = quran();
        let p = Params::default();
        // Three tokens, no cue: not enough.
        // (Tanzil opens 112:1 with the basmala; the quote is `قل هو الله`.)
        let page = page_with(q, 112, 1, 4, 3, &["وقد", "ورد"], &["في", "السورة"], false);
        assert!(detect_page(idx, q, &page.tokens, &page.body, None, &p).is_empty());
        // Three tokens in ﴿ ﴾: accepted, with the cue recorded.
        let page = page_with(q, 112, 1, 4, 3, &["وقد", "ورد"], &["في", "السورة"], true);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &p);
        assert_eq!(hits.len(), 1, "{:?}", hits);
        assert_eq!(hits[0].cue.as_deref(), Some("﴿﴾"));
        assert_eq!((hits[0].sura, hits[0].aya_start), (112, 1));
        // A basmala is 1:1, not the head of 112 other sūras.
        let page = page_with(q, 1, 1, 0, 4, &["كتب"], &["ثم", "قال"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &p);
        assert_eq!(hits.len(), 1, "{:?}", hits);
        assert_eq!((hits[0].sura, hits[0].aya_start, hits[0].aligned), (1, 1, 4));
        // …but a quotation running on from a sūra's basmala aligns through it.
        let page = page_with(q, 112, 1, 0, 8, &["كتب"], &["ثم", "قال"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &p);
        assert_eq!(hits.len(), 1, "{:?}", hits);
        assert_eq!((hits[0].sura, hits[0].aya_start, hits[0].aligned), (112, 1, 8));
        // `قال تعالى` before it is a cue too.
        let page = page_with(q, 112, 1, 4, 3, &["قال", "تعالى"], &["في", "السورة"], false);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &p);
        assert_eq!(hits.len(), 1, "{:?}", hits);
        assert_eq!(hits[0].cue.as_deref(), Some("قال تعالى"));
        // An inflected quotation: change two surfaces, keep lemmas → lemma_agree 1, surface < 1.
        let mut page = page_with(q, 2, 255, 0, 10, &["قوله"], &["الآية"], false);
        page.tokens[3].surface = format!("و{}", page.tokens[3].surface);
        page.tokens[5].surface = format!("ف{}", page.tokens[5].surface);
        let hits = detect_page(idx, q, &page.tokens, &page.body, None, &p);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lemma_agree, 1.0);
        assert!((hits[0].surface_agree - 0.8).abs() < 1e-9);
        // Prose that merely shares common words seeds nothing.
        let mk = |i: usize, w: &str| Token { idx: i, surface: w.into(), noclitic_surface: None, lemma: w.into(), root: None, pos: "noun".into(), features: vec![], clitics: vec![] };
        let words = ["قال", "الشيخ", "إن", "الكتاب", "في", "الدار", "و", "الله", "أعلم", "بالصواب"];
        let tokens: Vec<Token> = words.iter().enumerate().map(|(i, w)| mk(i, w)).collect();
        assert!(detect_page(idx, q, &tokens, &words.join(" "), None, &p).is_empty());
    }
}
