//! Keyness (Lab spec §4.1): the book against a reference set.
//!
//! Statistic: log-likelihood G² (Rayson & Garside 2000) with a Bayes-factor
//! threshold (Wilson 2013: BIC = G² − ln N), plus Log Ratio (Hardie 2014) as
//! the effect size. Both are reported for every item, positive (over-used in
//! the book) and negative (under-used).
//!
//! Given a key with `a` occurrences in the book (of `c` tokens) and `b` in
//! the reference (of `d` tokens):
//!
//! ```text
//! E1 = c (a + b) / (c + d)        E2 = d (a + b) / (c + d)
//! G² = 2 [ a ln(a / E1) + b ln(b / E2) ]        (a term with a zero count is 0)
//! BIC = G² − ln(c + d)                            (> 2 positive, > 6 strong, > 10 very strong)
//! Log Ratio = log2( (a / c) / (b / d) )           (a zero count is replaced by 0.5)
//! ```
//!
//! The direction (over- or under-used) is `a/c` against `b/d`; G² itself is
//! non-negative and is reported as such, with `direction` alongside.
//!
//! The reference set is counts plus a total, whatever produced it: the whole
//! corpus minus this book (default), a set of books, or a user selection.
//! "Minus this book" matters — a book compared with a corpus that contains it
//! is compared partly with itself, which damps every score.

use super::text::{BookText, StopList};
use crate::source::FreqTable;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Counts and their total, for one side of the comparison.
#[derive(Debug, Clone, Default)]
pub struct Counts {
    pub counts: HashMap<String, u64>,
    pub total: u64,
}

impl Counts {
    pub fn from_text(text: &BookText, stop: Option<&StopList>) -> Self {
        let (by_id, total) = text.counts(stop);
        let counts = by_id.into_iter().map(|(id, c)| (text.vocab[id as usize].clone(), c)).collect();
        Self { counts, total }
    }

    pub fn from_table(table: &FreqTable) -> Self {
        Self { counts: table.entries().map(|(k, c)| (k.to_string(), c)).collect(), total: table.total }
    }

    /// `self` with `other` removed — the rest of the corpus.
    pub fn minus(&self, other: &Counts) -> Self {
        let mut counts = self.counts.clone();
        for (k, c) in &other.counts {
            if let Some(v) = counts.get_mut(k) {
                *v = v.saturating_sub(*c);
                if *v == 0 {
                    counts.remove(k);
                }
            }
        }
        Self { counts, total: self.total.saturating_sub(other.total) }
    }

    /// Sum several sets (a same-author or same-genre reference).
    pub fn sum<'a, I: IntoIterator<Item = &'a Counts>>(sets: I) -> Self {
        let mut out = Counts::default();
        for s in sets {
            for (k, c) in &s.counts {
                *out.counts.entry(k.clone()).or_insert(0) += c;
            }
            out.total += s.total;
        }
        out
    }

    pub fn get(&self, key: &str) -> u64 {
        self.counts.get(key).copied().unwrap_or(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// More frequent in the book than in the reference.
    Positive,
    Negative,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyItem {
    pub key: String,
    pub book_count: u64,
    pub ref_count: u64,
    pub book_per_million: f64,
    pub ref_per_million: f64,
    pub g2: f64,
    pub bic: f64,
    pub log_ratio: f64,
    pub direction: Direction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeynessOptions {
    /// Items must occur at least this often in the book *or* the reference.
    pub min_freq: u64,
    /// Keep items with BIC ≥ this; 2 is "positive evidence" (Wilson 2013).
    pub min_bic: f64,
}

impl Default for KeynessOptions {
    fn default() -> Self {
        Self { min_freq: 3, min_bic: 2.0 }
    }
}

/// The two statistics for one item, so they can be hand-checked in isolation.
pub fn g2_and_log_ratio(a: u64, c: u64, b: u64, d: u64) -> (f64, f64) {
    let (a, b, c, d) = (a as f64, b as f64, c as f64, d as f64);
    let n = c + d;
    let g2 = if n == 0.0 || a + b == 0.0 {
        0.0
    } else {
        let e1 = c * (a + b) / n;
        let e2 = d * (a + b) / n;
        let t1 = if a > 0.0 { a * (a / e1).ln() } else { 0.0 };
        let t2 = if b > 0.0 { b * (b / e2).ln() } else { 0.0 };
        2.0 * (t1 + t2)
    };
    let ra = (if a > 0.0 { a } else { 0.5 }) / c.max(1.0);
    let rb = (if b > 0.0 { b } else { 0.5 }) / d.max(1.0);
    let log_ratio = (ra / rb).log2();
    (g2, log_ratio)
}

/// Key items of `book` against `reference`, sorted by BIC descending.
pub fn keyness(book: &Counts, reference: &Counts, opts: &KeynessOptions) -> Vec<KeyItem> {
    let (c, d) = (book.total, reference.total);
    let n_ln = ((c + d) as f64).max(1.0).ln();
    let mut keys: Vec<&String> = book.counts.keys().chain(reference.counts.keys()).collect();
    keys.sort_unstable();
    keys.dedup();

    let mut items: Vec<KeyItem> = keys
        .into_iter()
        .filter_map(|k| {
            let a = book.get(k);
            let b = reference.get(k);
            if a < opts.min_freq && b < opts.min_freq {
                return None;
            }
            let (g2, log_ratio) = g2_and_log_ratio(a, c, b, d);
            let bic = g2 - n_ln;
            if bic < opts.min_bic {
                return None;
            }
            let book_pm = super::freq::per_million(a, c);
            let ref_pm = super::freq::per_million(b, d);
            Some(KeyItem {
                key: k.clone(),
                book_count: a,
                ref_count: b,
                book_per_million: book_pm,
                ref_per_million: ref_pm,
                g2,
                bic,
                log_ratio,
                direction: if book_pm >= ref_pm { Direction::Positive } else { Direction::Negative },
            })
        })
        .collect();
    items.sort_by(|x, y| y.bic.partial_cmp(&x.bic).unwrap_or(std::cmp::Ordering::Equal).then_with(|| x.key.cmp(&y.key)));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(&str, u64)], total: u64) -> Counts {
        Counts { counts: pairs.iter().map(|(k, c)| (k.to_string(), *c)).collect(), total }
    }

    /// Rayson & Garside's worked example: a = 6, c = 100 000; b = 1, d = 1 000 000.
    /// E1 = 100000·7/1100000 = 0.636…, E2 = 6.363…
    /// G² = 2 [6 ln(6/0.63636) + 1 ln(1/6.36364)] = 2 [13.4633 − 1.8506] = 23.225
    #[test]
    fn g2_matches_a_hand_computation() {
        let (g2, lr) = g2_and_log_ratio(6, 100_000, 1, 1_000_000);
        assert!((g2 - 23.225).abs() < 0.01, "G² = {}", g2);
        // Log Ratio = log2((6/100000)/(1/1000000)) = log2(60) = 5.907
        assert!((lr - 5.907).abs() < 0.001, "LR = {}", lr);
    }

    #[test]
    fn a_zero_count_uses_half_for_the_ratio_and_contributes_nothing_to_g2() {
        // a = 10 of 1000, b = 0 of 1000: E1 = E2 = 5; G² = 2·10·ln(2) = 13.863
        let (g2, lr) = g2_and_log_ratio(10, 1000, 0, 1000);
        assert!((g2 - 13.8629).abs() < 0.001, "G² = {}", g2);
        // LR = log2((10/1000)/(0.5/1000)) = log2(20) = 4.3219
        assert!((lr - 4.3219).abs() < 0.001, "LR = {}", lr);
        assert!(lr > 0.0);
        let (_, lr_neg) = g2_and_log_ratio(0, 1000, 10, 1000);
        assert!((lr_neg + 4.3219).abs() < 0.001);
    }

    #[test]
    fn equal_rates_are_not_key() {
        let (g2, lr) = g2_and_log_ratio(5, 100, 50, 1000);
        assert!(g2.abs() < 1e-9);
        assert!(lr.abs() < 1e-9);
    }

    #[test]
    fn positive_and_negative_items_both_appear_sorted_by_bic() {
        let book = counts(&[("x", 30), ("y", 1), ("z", 5)], 1_000);
        let reference = counts(&[("x", 30), ("y", 900), ("z", 50)], 100_000);
        let items = keyness(&book, &reference, &KeynessOptions { min_freq: 1, min_bic: -1e9 });
        let x = items.iter().find(|i| i.key == "x").unwrap();
        let y = items.iter().find(|i| i.key == "y").unwrap();
        let z = items.iter().find(|i| i.key == "z").unwrap();
        assert_eq!(x.direction, Direction::Positive); // 30 000 pm vs 300 pm
        assert_eq!(y.direction, Direction::Negative); // 1 000 pm vs 9 000 pm
        assert_eq!(z.direction, Direction::Positive); // 5 000 pm vs 500 pm
        assert!(x.bic > z.bic, "x is the stronger keyword");
        assert!(items.windows(2).all(|w| w[0].bic >= w[1].bic));
        // Per-million columns are what the UI shows next to the counts.
        assert!((x.book_per_million - 30_000.0).abs() < 1e-9);
        assert!((x.ref_per_million - 300.0).abs() < 1e-9);
    }

    #[test]
    fn the_thresholds_filter() {
        let book = counts(&[("x", 30), ("rare", 1)], 1_000);
        let reference = counts(&[("x", 30), ("rare", 1)], 100_000);
        let items = keyness(&book, &reference, &KeynessOptions { min_freq: 3, min_bic: 2.0 });
        assert!(items.iter().all(|i| i.key != "rare"), "below min_freq on both sides");
        assert!(items.iter().any(|i| i.key == "x"));
        // BIC gate: a weak item is dropped at 2.0
        let weak_book = counts(&[("w", 3)], 1_000);
        let weak_ref = counts(&[("w", 250)], 100_000);
        assert!(keyness(&weak_book, &weak_ref, &KeynessOptions { min_freq: 1, min_bic: 2.0 }).is_empty());
    }

    #[test]
    fn the_reference_excludes_the_book_itself() {
        let corpus = counts(&[("x", 100), ("y", 50)], 10_000);
        let book = counts(&[("x", 60), ("y", 50)], 1_000);
        let rest = corpus.minus(&book);
        assert_eq!(rest.total, 9_000);
        assert_eq!(rest.get("x"), 40);
        assert_eq!(rest.get("y"), 0, "a key the book exhausts disappears from the reference");
        assert!(!rest.counts.contains_key("y"));
    }

    #[test]
    fn sets_sum_for_composite_references() {
        let a = counts(&[("x", 1)], 10);
        let b = counts(&[("x", 2), ("y", 3)], 20);
        let s = Counts::sum([&a, &b]);
        assert_eq!(s.total, 30);
        assert_eq!(s.get("x"), 3);
        assert_eq!(s.get("y"), 3);
    }
}
