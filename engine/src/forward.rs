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
    let mut out = Vec::new();
    for &a in a_starts {
        for &b in b_starts {
            if a.abs_diff(b) <= max_distance {
                out.extend(a..a + a_len);
                out.extend(b..b + b_len);
            }
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
