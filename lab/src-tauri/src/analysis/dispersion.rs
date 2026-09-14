//! Dispersion (Lab spec §4.1): where in the book a term occurs.
//!
//! Gries's **DP** (deviation of proportions, 2008) with pages as the parts,
//! and the normalised **DP_norm** (Lijffijt & Gries 2012), which corrects for
//! the fact that DP's maximum depends on the size of the smallest part:
//!
//! ```text
//! s_i  = tokens in part i / tokens in the book      (expected share)
//! v_i  = occurrences in part i / occurrences in all (observed share)
//! DP   = Σ |v_i − s_i| / 2                           0 = perfectly even, → 1 = clumped
//! DP_norm = DP / (1 − min_i s_i)
//! ```
//!
//! The strip plot is the list of every occurrence as a global position, which
//! the UI draws against a page axis labelled by part and page.

use super::text::{BookText, Pos};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dispersion {
    pub key: String,
    pub occurrences: u64,
    /// Book tokens the shares are relative to.
    pub total: u64,
    pub dp: f64,
    pub dp_norm: f64,
    /// Per page: occurrences on that page.
    pub per_page: Vec<u64>,
    /// Every occurrence, in reading order.
    pub positions: Vec<Pos>,
}

/// DP and DP_norm from per-part counts and sizes. Public so it can be checked
/// against hand-computed values without a book.
pub fn dp(counts: &[u64], sizes: &[u64]) -> (f64, f64) {
    debug_assert_eq!(counts.len(), sizes.len());
    let total: u64 = sizes.iter().sum();
    let occ: u64 = counts.iter().sum();
    if total == 0 || occ == 0 || sizes.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum = 0.0;
    let mut min_s = f64::INFINITY;
    for (&c, &s) in counts.iter().zip(sizes) {
        let s_i = s as f64 / total as f64;
        let v_i = c as f64 / occ as f64;
        sum += (v_i - s_i).abs();
        min_s = min_s.min(s_i);
    }
    let dp = sum / 2.0;
    let denom = 1.0 - min_s;
    let norm = if denom > 0.0 { dp / denom } else { 0.0 };
    (dp, norm.min(1.0))
}

pub fn dispersion(text: &BookText, key: &str) -> Dispersion {
    let id = text.id_of(key);
    let pages = text.pages();
    let mut per_page = vec![0u64; pages];
    let mut positions = Vec::new();
    if let Some(id) = id {
        for (g, k) in text.keys.iter().enumerate() {
            if *k == Some(id) {
                let p = text.pos(g);
                per_page[p.page] += 1;
                positions.push(p);
            }
        }
    }
    let sizes: Vec<u64> = (0..pages).map(|p| text.page_len(p) as u64).collect();
    let (dp, dp_norm) = dp(&per_page, &sizes);
    Dispersion {
        key: key.to_string(),
        occurrences: positions.len() as u64,
        total: text.total as u64,
        dp,
        dp_norm,
        per_page,
        positions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::two_pages;
    use crate::source::Layer;

    /// Gries (2008) example: five equal parts, a word occurring 1,2,3,4,5 times.
    /// s_i = 0.2 each; v = 1/15, 2/15, 3/15, 4/15, 5/15.
    /// |v−s| = 0.1333, 0.0667, 0, 0.0667, 0.1333 → sum 0.4 → DP = 0.2.
    /// DP_norm = 0.2 / (1 − 0.2) = 0.25.
    #[test]
    fn dp_matches_gries_example() {
        let (d, n) = dp(&[1, 2, 3, 4, 5], &[100, 100, 100, 100, 100]);
        assert!((d - 0.2).abs() < 1e-9, "DP = {}", d);
        assert!((n - 0.25).abs() < 1e-9, "DP_norm = {}", n);
    }

    #[test]
    fn even_is_zero_and_clumped_is_high() {
        let (d, _) = dp(&[10, 10, 10, 10], &[50, 50, 50, 50]);
        assert!(d.abs() < 1e-9);
        // All in one of four equal parts: |1 − .25| + 3·|0 − .25| = 1.5 → DP 0.75, norm 1.0
        let (d, n) = dp(&[40, 0, 0, 0], &[50, 50, 50, 50]);
        assert!((d - 0.75).abs() < 1e-9);
        assert!((n - 1.0).abs() < 1e-9);
    }

    #[test]
    fn unequal_parts_use_their_sizes() {
        // Parts of 90 and 10 tokens; the word occurs 9 and 1 times: exactly
        // proportional, so DP is 0 even though the counts differ.
        let (d, _) = dp(&[9, 1], &[90, 10]);
        assert!(d.abs() < 1e-9);
    }

    #[test]
    fn an_absent_term_has_no_positions() {
        let (d, n) = dp(&[0, 0], &[5, 5]);
        assert_eq!((d, n), (0.0, 0.0));
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let r = dispersion(&text, "غائب");
        assert_eq!(r.occurrences, 0);
        assert!(r.positions.is_empty());
        assert_eq!(r.per_page, vec![0, 0]);
    }

    #[test]
    fn positions_are_in_reading_order_with_pages_and_counts() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let r = dispersion(&text, "قول");
        assert_eq!(r.occurrences, 3);
        assert_eq!(r.per_page, vec![2, 1]);
        assert_eq!(r.positions, vec![Pos { page: 0, idx: 0 }, Pos { page: 0, idx: 2 }, Pos { page: 1, idx: 5 }]);
        // s = (0.4, 0.6); v = (2/3, 1/3): |.2667| + |.2667| = .5333 → DP .2667; norm /.6 = .4444
        assert!((r.dp - 0.26667).abs() < 1e-4, "{}", r.dp);
        assert!((r.dp_norm - 0.44444).abs() < 1e-4, "{}", r.dp_norm);
    }
}
