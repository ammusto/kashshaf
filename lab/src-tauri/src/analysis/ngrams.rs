//! N-grams and collocations (Lab spec §4.1).
//!
//! **N-grams** for n = 2..5 on any layer: counts and per-million. A gram
//! never spans a token without a key on the layer (a rootless token on the
//! root layer breaks the run), and in *span-aware* mode never crosses a page
//! boundary or a `<title>` section boundary either.
//!
//! **Collocations** of a node within a window, scored three ways so the user
//! can see where they disagree (MI favours rare pairs, t-score favours
//! frequent ones, log-likelihood sits between):
//!
//! ```text
//! N   = keyed tokens in the book          W = window size (left + right)
//! f(n), f(c) = frequencies of node and collocate
//! O   = co-occurrences of c within the window of n
//! E   = f(n) · f(c) · W / N
//! MI  = log2(O / E)
//! t   = (O − E) / √O
//! LL  = 2 Σ O_ij ln(O_ij / E_ij) over the 2×2 table with
//!       R1 = f(n)·W (window slots), C1 = f(c), N slots in all
//! ```
//!
//! These are the definitions in Evert's *Corpora and collocations* (2008),
//! with W applied to E as Church & Hanks do. The same page-and-section rule
//! applies in span-aware mode, and the node itself is never its own
//! collocate.

use super::text::{BookText, StopList};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NgramRow {
    pub gram: Vec<String>,
    pub count: u64,
    pub per_million: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NgramOptions {
    /// 2..=5
    pub n: usize,
    /// Do not cross page boundaries or `<title>` sections.
    pub span_aware: bool,
    /// Drop grams containing a stop word.
    pub min_count: u64,
}

impl Default for NgramOptions {
    fn default() -> Self {
        Self { n: 2, span_aware: true, min_count: 2 }
    }
}

/// Section boundaries as global positions where a new section starts, from
/// `sections::sections`; empty = none known.
pub type Boundaries = Vec<usize>;

/// Is there a boundary strictly inside `(from, to]`? Positions in
/// `boundaries` mark the *first* token of a section, so a gram may start on
/// a boundary but not contain one after its first token.
fn crosses(boundaries: &[usize], from: usize, to: usize) -> bool {
    let i = boundaries.partition_point(|&b| b <= from);
    boundaries.get(i).map(|&b| b <= to).unwrap_or(false)
}

pub fn ngrams(text: &BookText, opts: &NgramOptions, stop: Option<&StopList>, sections: &Boundaries) -> Vec<NgramRow> {
    let n = opts.n.clamp(2, 5);
    let mut counts: HashMap<Vec<u32>, u64> = HashMap::new();
    let mut boundaries: Vec<usize> = Vec::new();
    if opts.span_aware {
        boundaries.extend(text.page_starts.iter().copied());
        boundaries.extend(sections.iter().copied());
        boundaries.sort_unstable();
        boundaries.dedup();
    }
    let mut grams_total = 0u64;
    'outer: for start in 0..text.total.saturating_sub(n - 1) {
        let end = start + n - 1;
        if opts.span_aware && crosses(&boundaries, start, end) {
            continue;
        }
        let mut gram = Vec::with_capacity(n);
        for g in start..=end {
            let Some(id) = text.keys[g] else { continue 'outer };
            if let Some(s) = stop {
                if text.is_stop(g, s) {
                    continue 'outer;
                }
            }
            gram.push(id);
        }
        *counts.entry(gram).or_insert(0) += 1;
        grams_total += 1;
    }
    let mut rows: Vec<NgramRow> = counts
        .into_iter()
        .filter(|(_, c)| *c >= opts.min_count)
        .map(|(ids, count)| NgramRow {
            gram: ids.iter().map(|id| text.vocab[*id as usize].clone()).collect(),
            count,
            per_million: super::freq::per_million(count, grams_total),
        })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.gram.cmp(&b.gram)));
    rows
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollocationOptions {
    pub left: usize,
    pub right: usize,
    pub span_aware: bool,
    pub min_freq: u64,
}

impl Default for CollocationOptions {
    fn default() -> Self {
        Self { left: 5, right: 5, span_aware: true, min_freq: 3 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collocate {
    pub key: String,
    /// Co-occurrences within the window.
    pub observed: u64,
    pub expected: f64,
    /// The collocate's own frequency in the book.
    pub freq: u64,
    pub mi: f64,
    pub log_likelihood: f64,
    pub t_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collocations {
    pub node: String,
    pub node_freq: u64,
    pub window: (usize, usize),
    pub rows: Vec<Collocate>,
}

/// The three scores from the counts, so they can be checked by hand.
/// Returns `(expected, MI, LL, t)`.
pub fn scores(o: u64, f_node: u64, f_coll: u64, window: usize, n: u64) -> (f64, f64, f64, f64) {
    let (o, fn_, fc, w, n) = (o as f64, f_node as f64, f_coll as f64, window as f64, n as f64);
    if n == 0.0 || o == 0.0 {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let e = fn_ * fc * w / n;
    let mi = (o / e).log2();
    let t = (o - e) / o.sqrt();
    // 2×2: R1 = window slots around the node, C1 = collocate occurrences.
    let r1 = fn_ * w;
    let c1 = fc;
    // Guard a degenerate table (a huge window on a tiny book).
    let n = n.max(r1 + c1);
    let o11 = o;
    let o12 = (r1 - o).max(0.0);
    let o21 = (c1 - o).max(0.0);
    let o22 = (n - r1 - c1 + o).max(0.0);
    let r2 = o21 + o22;
    let c2 = o12 + o22;
    let term = |obs: f64, exp: f64| if obs > 0.0 && exp > 0.0 { obs * (obs / exp).ln() } else { 0.0 };
    let ll = 2.0
        * (term(o11, r1 * c1 / n) + term(o12, r1 * c2 / n) + term(o21, r2 * c1 / n) + term(o22, r2 * c2 / n));
    (e, mi, ll, t)
}

pub fn collocations(
    text: &BookText,
    node: &str,
    opts: &CollocationOptions,
    stop: Option<&StopList>,
    sections: &Boundaries,
) -> Collocations {
    let window = (opts.left, opts.right);
    let Some(node_id) = text.id_of(node) else {
        return Collocations { node: node.to_string(), node_freq: 0, window, rows: vec![] };
    };
    let mut boundaries: Vec<usize> = Vec::new();
    if opts.span_aware {
        boundaries.extend(text.page_starts.iter().copied());
        boundaries.extend(sections.iter().copied());
        boundaries.sort_unstable();
        boundaries.dedup();
    }
    let (freqs, n) = text.counts(stop);
    let node_freq = freqs.get(&node_id).copied().unwrap_or(0);
    let mut observed: HashMap<u32, u64> = HashMap::new();

    for g in 0..text.total {
        if text.keys[g] != Some(node_id) {
            continue;
        }
        let lo = g.saturating_sub(opts.left);
        let hi = (g + opts.right).min(text.total.saturating_sub(1));
        for h in lo..=hi {
            if h == g {
                continue;
            }
            let Some(c) = text.keys[h] else { continue };
            if c == node_id {
                continue;
            }
            if opts.span_aware && crosses(&boundaries, g.min(h), g.max(h)) {
                continue;
            }
            if let Some(s) = stop {
                if text.is_stop(h, s) {
                    continue;
                }
            }
            *observed.entry(c).or_insert(0) += 1;
        }
    }

    let w = opts.left + opts.right;
    let mut rows: Vec<Collocate> = observed
        .into_iter()
        .filter(|(_, o)| *o >= opts.min_freq)
        .map(|(c, o)| {
            let fc = freqs.get(&c).copied().unwrap_or(0);
            let (expected, mi, ll, t) = scores(o, node_freq, fc, w, n);
            Collocate {
                key: text.vocab[c as usize].clone(),
                observed: o,
                expected,
                freq: fc,
                mi,
                log_likelihood: ll,
                t_score: t,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.log_likelihood
            .partial_cmp(&a.log_likelihood)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });
    Collocations { node: node.to_string(), node_freq, window, rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::{page, two_pages};
    use crate::source::Layer;

    #[test]
    fn bigrams_count_and_do_not_cross_pages_when_span_aware() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        // Lemmas: [قول رجل قول الله] [رجل من الله في كتاب قول]
        let rows = ngrams(&text, &NgramOptions { n: 2, span_aware: true, min_count: 1 }, None, &vec![]);
        // 3 bigrams on page 0, 5 on page 1 = 8 grams, all distinct.
        assert_eq!(rows.len(), 8);
        assert!(rows.iter().all(|r| r.count == 1));
        assert!(rows.iter().all(|r| (r.per_million - 125_000.0).abs() < 1e-6));
        assert!(!rows.iter().any(|r| r.gram == ["الله", "رجل"]), "the page-crossing pair must not appear");

        let rows = ngrams(&text, &NgramOptions { n: 2, span_aware: false, min_count: 1 }, None, &vec![]);
        assert_eq!(rows.len(), 9);
        assert!(rows.iter().any(|r| r.gram == ["الله", "رجل"]));
    }

    #[test]
    fn a_missing_key_breaks_a_gram_and_stop_words_drop_it() {
        let pages = two_pages();
        let root = BookText::build(&pages, Layer::Root);
        // Roots: [ق.#.ل ر.ج.ل ق.#.ل —] [ر.ج.ل — — — ك.ت.ب ق.#.ل]
        let rows = ngrams(&root, &NgramOptions { n: 2, span_aware: true, min_count: 1 }, None, &vec![]);
        let grams: Vec<Vec<String>> = rows.iter().map(|r| r.gram.clone()).collect();
        assert_eq!(grams.len(), 3, "{:?}", grams);
        assert!(grams.contains(&vec!["ك.ت.ب".to_string(), "ق.#.ل".to_string()]));

        let lemma = BookText::build(&pages, Layer::Lemma);
        let stop = StopList::new(["من".to_string(), "في".to_string()]);
        let rows = ngrams(&lemma, &NgramOptions { n: 2, span_aware: true, min_count: 1 }, Some(&stop), &vec![]);
        assert!(rows.iter().all(|r| !r.gram.contains(&"من".to_string()) && !r.gram.contains(&"في".to_string())));
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn section_boundaries_are_respected() {
        let pages = vec![page(1, 0, 1, "", "a|a b|b c|c d|d e|e f|f")];
        let text = BookText::build(&pages, Layer::Lemma);
        // A section starts at token 3: grams may not contain 2→3.
        let rows = ngrams(&text, &NgramOptions { n: 3, span_aware: true, min_count: 1 }, None, &vec![3]);
        let grams: Vec<String> = rows.iter().map(|r| r.gram.join(" ")).collect();
        assert_eq!(grams.len(), 2, "{:?}", grams);
        assert!(grams.contains(&"a b c".to_string()));
        assert!(grams.contains(&"d e f".to_string()));
    }

    /// Hand computation: N = 100, f(node) = 10, f(c) = 20, W = 4, O = 8.
    /// E = 10·20·4/100 = 8 → MI = 0, t = 0, LL = 0 (perfect independence).
    #[test]
    fn independence_scores_zero() {
        let (e, mi, ll, t) = scores(8, 10, 20, 4, 100);
        assert!((e - 8.0).abs() < 1e-9);
        assert!(mi.abs() < 1e-9);
        assert!(t.abs() < 1e-9);
        assert!(ll.abs() < 1e-9, "LL = {}", ll);
    }

    /// N = 1000, f(node) = 10, f(c) = 10, W = 2, O = 5.
    /// E = 10·10·2/1000 = 0.2; MI = log2(25) = 4.6439; t = (5 − 0.2)/√5 = 2.1466.
    /// LL over the table R1 = 20, C1 = 10, N = 1000:
    ///   O = [5, 15, 5, 975]; E = [0.2, 19.8, 9.8, 970.2]
    ///   2·[5 ln 25 + 15 ln(15/19.8) + 5 ln(5/9.8) + 975 ln(975/970.2)]
    ///   = 2·[16.094 − 4.168 − 3.365 + 4.811] = 26.74
    #[test]
    fn scores_match_a_hand_computation() {
        let (e, mi, ll, t) = scores(5, 10, 10, 2, 1000);
        assert!((e - 0.2).abs() < 1e-9);
        assert!((mi - 4.6439).abs() < 1e-3, "MI = {}", mi);
        assert!((t - 2.1466).abs() < 1e-3, "t = {}", t);
        assert!((ll - 26.74).abs() < 0.05, "LL = {}", ll);
    }

    #[test]
    fn collocates_are_counted_within_the_window_and_never_the_node_itself() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        // Node قول at 0, 2, 9. Window ±1, span-aware:
        //   0: right 1 (رجل)         2: left 1 (رجل), right 3 (الله)
        //   9: left 8 (كتاب); right is beyond the page.
        let c = collocations(
            &text,
            "قول",
            &CollocationOptions { left: 1, right: 1, span_aware: true, min_freq: 1 },
            None,
            &vec![],
        );
        assert_eq!(c.node_freq, 3);
        let get = |k: &str| c.rows.iter().find(|r| r.key == k).map(|r| r.observed);
        assert_eq!(get("رجل"), Some(2));
        assert_eq!(get("الله"), Some(1));
        assert_eq!(get("كتاب"), Some(1));
        assert_eq!(get("قول"), None, "the node is not its own collocate");
        assert!(c.rows.windows(2).all(|w| w[0].log_likelihood >= w[1].log_likelihood));
    }

    #[test]
    fn an_absent_node_yields_no_rows() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let c = collocations(&text, "غائب", &CollocationOptions::default(), None, &vec![]);
        assert_eq!(c.node_freq, 0);
        assert!(c.rows.is_empty());
    }
}
