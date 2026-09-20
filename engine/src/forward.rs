//! Forward-index scans over a page's token ids (Phase B).
//!
//! Given a page as a sequence of ids and, per query position, a set of ids
//! that satisfy that position, these functions return exact match positions
//! without touching Tantivy postings. They work equally on definition ids or
//! triple ids as long as `sets` use the same id space as `ids`.

use std::collections::HashSet;

/// Membership test for one query slot. `HashSet<u32>` for ordinary slots;
/// [`IdBitmap`] for slots that expand to hundreds of thousands of ids
/// (wildcards such as `ال*`), where a hash set would cost tens of megabytes
/// and a cache miss per probe.
pub trait TripleSet {
    fn contains(&self, id: u32) -> bool;
}

impl TripleSet for HashSet<u32> {
    #[inline]
    fn contains(&self, id: u32) -> bool {
        HashSet::contains(self, &id)
    }
}

/// Dense bitmap over the id space (one bit per triple id: ~370 KB for the
/// full corpus's 3M triples).
#[derive(Debug, Clone, Default)]
pub struct IdBitmap {
    words: Vec<u64>,
    len: usize,
}

impl IdBitmap {
    pub fn from_ids(ids: &[u32]) -> Self {
        let max = ids.iter().copied().max().map_or(0, |m| m as usize + 1);
        let mut words = vec![0u64; max.div_ceil(64)];
        for &id in ids {
            words[(id / 64) as usize] |= 1u64 << (id % 64);
        }
        Self { words, len: ids.len() }
    }

    /// Number of ids inserted (not deduplicated).
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl TripleSet for IdBitmap {
    #[inline]
    fn contains(&self, id: u32) -> bool {
        self.words
            .get((id / 64) as usize)
            .map_or(false, |w| w & (1u64 << (id % 64)) != 0)
    }
}

/// A slot's membership set, hash or bitmap depending on its size.
#[derive(Debug, Clone)]
pub enum Members {
    Hash(HashSet<u32>),
    Bitmap(IdBitmap),
}

impl Members {
    /// Hash set up to `threshold` ids, bitmap above it.
    pub fn from_ids(ids: &[u32], threshold: usize) -> Self {
        if ids.len() > threshold {
            Members::Bitmap(IdBitmap::from_ids(ids))
        } else {
            Members::Hash(ids.iter().copied().collect())
        }
    }
}

impl TripleSet for Members {
    #[inline]
    fn contains(&self, id: u32) -> bool {
        match self {
            Members::Hash(h) => h.contains(&id),
            Members::Bitmap(b) => b.contains(id),
        }
    }
}

/// Start positions where `sets[0..n]` match consecutively.
pub fn phrase_starts<S: TripleSet>(ids: &[u32], sets: &[S]) -> Vec<u32> {
    let n = sets.len();
    if n == 0 || ids.len() < n {
        return Vec::new();
    }
    (0..=ids.len() - n)
        .filter(|&s| (0..n).all(|k| sets[k].contains(ids[s + k])))
        .map(|s| s as u32)
        .collect()
}

/// Every position covered by a consecutive match of `sets`.
pub fn phrase_positions<S: TripleSet>(ids: &[u32], sets: &[S]) -> Vec<u32> {
    let n = sets.len() as u32;
    let mut out: Vec<u32> = phrase_starts(ids, sets).into_iter().flat_map(|s| s..s + n).collect();
    out.dedup();
    out
}

/// Positions of ids in `set` (single-position query).
pub fn member_positions<S: TripleSet>(ids: &[u32], set: &S) -> Vec<u32> {
    ids.iter()
        .enumerate()
        .filter(|(_, &id)| set.contains(id))
        .map(|(i, _)| i as u32)
        .collect()
}

/// True if any start in `a` is within `max_distance` of any start in `b`.
/// Both inputs must be sorted ascending (as `phrase_starts` returns them);
/// runs in O(|a| + |b|) and stops at the first qualifying pair.
pub fn has_pair_within(a: &[u32], b: &[u32], max_distance: u32) -> bool {
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        let (x, y) = (a[i], b[j]);
        if x.abs_diff(y) <= max_distance {
            return true;
        }
        if x < y {
            i += 1;
        } else {
            j += 1;
        }
    }
    false
}

/// Positions (from both sides) of pairs whose distance is at most `max_distance`.
/// Distance is measured between the *start* of each phrase occurrence.
/// Returns an empty vector when no pair qualifies.
pub fn proximity_positions(a_starts: &[u32], a_len: u32, b_starts: &[u32], b_len: u32, max_distance: u32) -> Vec<u32> {
    chain_positions(&[a_starts.to_vec(), b_starts.to_vec()], &[a_len, b_len], &[max_distance], false)
}

/// One link of a chain: `next` within `max_distance` of `prev` — either way
/// round when unordered, strictly after it when ordered.
#[inline]
pub fn link_ok(prev: u32, next: u32, max_distance: u32, ordered: bool) -> bool {
    if ordered {
        next > prev && next - prev <= max_distance
    } else {
        prev.abs_diff(next) <= max_distance
    }
}

/// Every tuple of the chain: one start from each term, consecutive ones
/// within their link's distance (`distances[k]` between term k and k + 1).
/// Up to three terms in the app; the walk is general.
fn chain_tuples(starts: &[Vec<u32>], distances: &[u32], ordered: bool) -> Vec<Vec<u32>> {
    let mut tuples: Vec<Vec<u32>> = starts[0].iter().map(|&s| vec![s]).collect();
    for (k, next) in starts.iter().enumerate().skip(1) {
        let d = distances[k - 1];
        let mut grown = Vec::new();
        for t in &tuples {
            let prev = *t.last().unwrap();
            for &n in next {
                if link_ok(prev, n, d, ordered) {
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

/// Whether some tuple of the chain exists. Two unordered terms: the same
/// answer as `has_pair_within`.
pub fn has_chain(starts: &[Vec<u32>], distances: &[u32], ordered: bool) -> bool {
    match starts.len() {
        0 => false,
        1 => !starts[0].is_empty(),
        2 if !ordered => has_pair_within(&starts[0], &starts[1], distances[0]),
        _ => !chain_tuples(starts, distances, ordered).is_empty(),
    }
}

/// Every position covered by some tuple of the chain: each term's span from
/// its start, over every qualifying tuple, sorted, once each. Two unordered
/// terms give exactly `proximity_positions`.
pub fn chain_positions(starts: &[Vec<u32>], lens: &[u32], distances: &[u32], ordered: bool) -> Vec<u32> {
    let mut out = Vec::new();
    for t in chain_tuples(starts, distances, ordered) {
        for (k, &s) in t.iter().enumerate() {
            out.extend(s..s + lens[k]);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &[u32]) -> HashSet<u32> {
        v.iter().copied().collect()
    }

    #[test]
    fn phrase_and_members() {
        let ids = [5u32, 1, 2, 9, 1, 2, 2];
        let sets = [set(&[1]), set(&[2])];
        assert_eq!(phrase_starts(&ids, &sets), vec![1, 4]);
        assert_eq!(phrase_positions(&ids, &sets), vec![1, 2, 4, 5]);
        assert_eq!(member_positions(&ids, &set(&[2])), vec![2, 5, 6]);
        assert!(phrase_starts(&ids[..1], &sets).is_empty());
    }

    #[test]
    fn proximity() {
        assert_eq!(proximity_positions(&[10], 1, &[13], 1, 3), vec![10, 13]);
        assert!(proximity_positions(&[10], 1, &[14], 1, 3).is_empty());
        assert_eq!(proximity_positions(&[0], 2, &[5], 1, 5), vec![0, 1, 5]);
    }

    #[test]
    fn bitmap_and_hash_agree() {
        let ids: Vec<u32> = vec![0, 1, 63, 64, 65, 1000, 2_985_159];
        let bm = IdBitmap::from_ids(&ids);
        let hs = set(&ids);
        for probe in [0u32, 1, 2, 63, 64, 65, 66, 999, 1000, 1001, 2_985_159, 2_985_160, 9_000_000] {
            assert_eq!(TripleSet::contains(&bm, probe), TripleSet::contains(&hs, probe), "id {}", probe);
        }
        assert_eq!(bm.len(), ids.len());
        let m = Members::from_ids(&ids, 3);
        assert!(matches!(m, Members::Bitmap(_)));
        let m2 = Members::from_ids(&ids, 100);
        assert!(matches!(m2, Members::Hash(_)));
        let page = vec![5u32, 1000, 7, 64, 63];
        assert_eq!(member_positions(&page, &bm), vec![1, 3, 4]);
        assert_eq!(phrase_starts(&page, &[m.clone(), m2.clone()]), vec![3]);
    }

    #[test]
    fn has_pair_matches_full_scan() {
        let cases: Vec<(Vec<u32>, Vec<u32>, u32)> = vec![
            (vec![10], vec![13], 3),
            (vec![10], vec![14], 3),
            (vec![1, 50, 100], vec![40, 200], 9),
            (vec![1, 50, 100], vec![40, 200], 10),
            (vec![], vec![1], 5),
            (vec![5, 6, 7], vec![], 5),
            (vec![100], vec![1, 2, 3, 95], 5),
        ];
        for (a, b, d) in cases {
            let full = !proximity_positions(&a, 1, &b, 1, d).is_empty();
            assert_eq!(has_pair_within(&a, &b, d), full, "a={:?} b={:?} d={}", a, b, d);
        }
    }
}

#[cfg(test)]
mod chain_tests {
    use super::*;

    #[test]
    fn chains_and_order() {
        // A at 2 and 30, B at 5, C at 9: unordered A~4 B~5 C is (2,5,9); ordered too.
        let starts = vec![vec![2, 30], vec![5], vec![9]];
        assert!(has_chain(&starts, &[4, 5], false));
        assert!(has_chain(&starts, &[4, 5], true));
        assert_eq!(chain_positions(&starts, &[1, 1, 1], &[4, 5], false), vec![2, 5, 9]);
        // Ordered fails when C precedes B.
        let back = vec![vec![2], vec![5], vec![3]];
        assert!(has_chain(&back, &[4, 5], false));
        assert!(!has_chain(&back, &[4, 5], true));
        // Two unordered terms: the pair helpers, span for span.
        let a = vec![1, 10, 40];
        let b = vec![12, 41];
        assert_eq!(has_chain(&[a.clone(), b.clone()], &[3], false), has_pair_within(&a, &b, 3));
        assert_eq!(chain_positions(&[a.clone(), b.clone()], &[2, 1], &[3], false), proximity_positions(&a, 2, &b, 1, 3));
        // A link that fails breaks the chain even when the ends are near.
        let gap = vec![vec![0], vec![50], vec![1]];
        assert!(!has_chain(&gap, &[5, 5], false));
    }
}
