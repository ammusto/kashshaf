//! Triple maps for the compound index (Phase B).
//!
//! A *triple* is a distinct `(surface, lemma_id, root_id)`; every
//! `token_definitions` row maps to one. The compound Tantivy index stores each
//! token as its zero-padded triple id, so a query in any mode becomes a set of
//! triple ids:
//!
//! * surface word  → all triples whose *normalized* surface equals it
//! * lemma word    → all triples with that `lemma_id`
//! * root          → all triples with that `root_id`
//!
//! Loaded from `corpus.db` (`triples`, `token_definitions.triple_id`,
//! `lemmas`, `roots`). Memory is kept compact: CSR arrays for the reverse
//! maps and one string arena for normalized surfaces.

use crate::normalize::normalize_arabic;
use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

/// Digits in a compound `tokens` term.
pub const TRIPLE_TOKEN_WIDTH: usize = 7;

pub fn triple_term(id: u32) -> String {
    format!("{:0width$}", id, width = TRIPLE_TOKEN_WIDTH)
}

/// Compressed sparse row map: `key -> [values]` for dense integer keys.
struct Csr {
    offsets: Vec<u32>,
    values: Vec<u32>,
}

impl Csr {
    fn build(max_key: usize, pairs: impl Iterator<Item = (u32, u32)> + Clone) -> Self {
        let mut counts = vec![0u32; max_key + 2];
        for (k, _) in pairs.clone() {
            counts[k as usize + 1] += 1;
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let offsets = counts.clone();
        let mut fill = counts;
        let mut values = vec![0u32; *offsets.last().unwrap_or(&0) as usize];
        for (k, v) in pairs {
            let slot = fill[k as usize] as usize;
            values[slot] = v;
            fill[k as usize] += 1;
        }
        Self { offsets, values }
    }

    fn get(&self, key: u32) -> &[u32] {
        let k = key as usize;
        if k + 1 >= self.offsets.len() {
            return &[];
        }
        &self.values[self.offsets[k] as usize..self.offsets[k + 1] as usize]
    }
}

pub struct TripleMaps {
    /// index = token_definitions.id → triple id (0 = unknown)
    def_to_triple: Vec<u32>,
    /// index = triple id → lemma id / root id (0 = none)
    triple_lemma: Vec<u32>,
    triple_root: Vec<u32>,
    lemma_to_triples: Csr,
    root_to_triples: Csr,
    /// triple ids sorted by normalized surface; parallel arena of those surfaces
    surface_sorted: Vec<u32>,
    surface_offsets: Vec<u32>,
    surface_arena: String,
    lemma_ids: HashMap<String, u32>,
    root_ids: HashMap<String, u32>,
    triple_count: usize,
}

impl TripleMaps {
    /// Load from `corpus.db`. Returns `Ok(None)` when the database has no
    /// `triples` table (schema < 4).
    pub fn load(corpus_db: &Path) -> Result<Option<Self>> {
        let conn = Connection::open(corpus_db).with_context(|| format!("opening {:?}", corpus_db))?;
        let has: bool = conn
            .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='triples'", [], |_| Ok(true))
            .unwrap_or(false);
        if !has {
            return Ok(None);
        }
        let t0 = std::time::Instant::now();

        // triples
        let max_triple: i64 = conn.query_row("SELECT COALESCE(MAX(id),0) FROM triples", [], |r| r.get(0))?;
        let n = max_triple as usize + 1;
        let mut triple_lemma = vec![0u32; n];
        let mut triple_root = vec![0u32; n];
        let mut surfaces: Vec<(String, u32)> = Vec::with_capacity(n);
        {
            let mut stmt = conn.prepare("SELECT id, surface, lemma_id, root_id FROM triples")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u32,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u32,
                    r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u32,
                ))
            })?;
            for row in rows {
                let (id, surface, lemma, root) = row?;
                triple_lemma[id as usize] = lemma;
                triple_root[id as usize] = root;
                surfaces.push((normalize_arabic(&surface), id));
            }
        }
        let triple_count = surfaces.len();
        if triple_count == 0 {
            bail!("triples table is empty");
        }

        // def_to_triple
        let max_def: i64 = conn.query_row("SELECT COALESCE(MAX(id),0) FROM token_definitions", [], |r| r.get(0))?;
        let mut def_to_triple = vec![0u32; max_def as usize + 1];
        {
            let mut stmt = conn.prepare("SELECT id, triple_id FROM token_definitions")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, Option<i64>>(1)?)))?;
            for row in rows {
                let (id, t) = row?;
                def_to_triple[id as usize] = t.unwrap_or(0) as u32;
            }
        }

        // reverse maps
        let max_lemma = *triple_lemma.iter().max().unwrap_or(&0) as usize;
        let max_root = *triple_root.iter().max().unwrap_or(&0) as usize;
        let lemma_pairs = triple_lemma.iter().enumerate().filter(|(_, &l)| l != 0).map(|(t, &l)| (l, t as u32));
        let root_pairs = triple_root.iter().enumerate().filter(|(_, &r)| r != 0).map(|(t, &r)| (r, t as u32));
        let lemma_to_triples = Csr::build(max_lemma, lemma_pairs);
        let root_to_triples = Csr::build(max_root, root_pairs);

        // surface-sorted arena
        surfaces.sort();
        let mut surface_sorted = Vec::with_capacity(surfaces.len());
        let mut surface_offsets = Vec::with_capacity(surfaces.len() + 1);
        let mut surface_arena = String::new();
        surface_offsets.push(0u32);
        for (s, id) in &surfaces {
            surface_arena.push_str(s);
            surface_offsets.push(surface_arena.len() as u32);
            surface_sorted.push(*id);
        }

        // string → id maps for lemmas and roots
        let mut lemma_ids: HashMap<String, u32> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT id, lemma FROM lemmas")?;
            for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, String>(1)?)))? {
                let (id, s) = row?;
                lemma_ids.insert(s, id);
            }
        }
        let mut root_ids: HashMap<String, u32> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT id, root FROM roots")?;
            for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, String>(1)?)))? {
                let (id, s) = row?;
                root_ids.insert(s, id);
            }
        }

        eprintln!(
            "[triples] loaded {} triples, {} definitions, {} lemmas, {} roots in {} ms",
            triple_count,
            def_to_triple.len(),
            lemma_ids.len(),
            root_ids.len(),
            t0.elapsed().as_millis()
        );

        Ok(Some(Self {
            def_to_triple,
            triple_lemma,
            triple_root,
            lemma_to_triples,
            root_to_triples,
            surface_sorted,
            surface_offsets,
            surface_arena,
            lemma_ids,
            root_ids,
            triple_count,
        }))
    }

    pub fn triple_count(&self) -> usize {
        self.triple_count
    }

    #[inline]
    pub fn triple_of_def(&self, def_id: u32) -> u32 {
        self.def_to_triple.get(def_id as usize).copied().unwrap_or(0)
    }

    pub fn lemma_of_triple(&self, triple: u32) -> u32 {
        self.triple_lemma.get(triple as usize).copied().unwrap_or(0)
    }

    pub fn root_of_triple(&self, triple: u32) -> u32 {
        self.triple_root.get(triple as usize).copied().unwrap_or(0)
    }

    fn surface_at(&self, sorted_pos: usize) -> &str {
        let a = self.surface_offsets[sorted_pos] as usize;
        let b = self.surface_offsets[sorted_pos + 1] as usize;
        &self.surface_arena[a..b]
    }

    /// First sorted position whose surface is >= `s`.
    fn lower_bound(&self, s: &str) -> usize {
        let (mut lo, mut hi) = (0usize, self.surface_sorted.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.surface_at(mid) < s {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// Triples whose normalized surface equals `word` (already normalized).
    pub fn triples_for_surface(&self, word: &str) -> Vec<u32> {
        let mut i = self.lower_bound(word);
        let mut out = Vec::new();
        while i < self.surface_sorted.len() && self.surface_at(i) == word {
            out.push(self.surface_sorted[i]);
            i += 1;
        }
        out
    }

    /// Every triple whose normalized surface starts with `prefix` and (if
    /// given) ends with `suffix`, in surface order. Unbounded: a one-letter
    /// prefix returns a large share of the vocabulary and the caller decides
    /// how to match a slot that wide.
    pub fn triples_for_wildcard(&self, prefix: &str, suffix: Option<&str>) -> Vec<u32> {
        let mut i = self.lower_bound(prefix);
        let mut out = Vec::new();
        while i < self.surface_sorted.len() {
            let s = self.surface_at(i);
            if !s.starts_with(prefix) {
                break;
            }
            let ok = match suffix {
                Some(suf) => s.ends_with(suf) && s.len() >= prefix.len() + suf.len(),
                None => true,
            };
            if ok {
                out.push(self.surface_sorted[i]);
            }
            i += 1;
        }
        out
    }

    /// Every triple whose normalized surface matches a `*`-glob. With a
    /// literal prefix the scan is confined to the prefix range of the
    /// surface-sorted array; a pattern starting with `*` scans every surface.
    pub fn triples_for_glob(&self, pattern: &crate::glob::GlobPattern) -> Vec<u32> {
        if !pattern.is_wildcard() {
            return self.triples_for_surface(&pattern.raw);
        }
        let mut out = Vec::new();
        match pattern.literal_prefix() {
            Some(prefix) if !prefix.is_empty() => {
                let mut i = self.lower_bound(prefix);
                while i < self.surface_sorted.len() {
                    let s = self.surface_at(i);
                    if !s.starts_with(prefix) {
                        break;
                    }
                    if pattern.matches(s) {
                        out.push(self.surface_sorted[i]);
                    }
                    i += 1;
                }
            }
            _ => {
                for i in 0..self.surface_sorted.len() {
                    if pattern.matches(self.surface_at(i)) {
                        out.push(self.surface_sorted[i]);
                    }
                }
            }
        }
        out
    }

    /// Triples for a lemma string exactly as CAMeL emits it.
    pub fn triples_for_lemma(&self, lemma: &str) -> Vec<u32> {
        match self.lemma_ids.get(lemma) {
            Some(&id) => self.lemma_to_triples.get(id).to_vec(),
            None => Vec::new(),
        }
    }

    /// Triples for a root in the dotted, `#`-weak-letter form.
    pub fn triples_for_root(&self, root: &str) -> Vec<u32> {
        match self.root_ids.get(root) {
            Some(&id) => self.root_to_triples.get(id).to_vec(),
            None => Vec::new(),
        }
    }

    /// Approximate resident size in bytes (for startup logging).
    pub fn approx_bytes(&self) -> usize {
        (self.def_to_triple.len() + self.triple_lemma.len() + self.triple_root.len() + self.surface_sorted.len()
            + self.surface_offsets.len()
            + self.lemma_to_triples.offsets.len()
            + self.lemma_to_triples.values.len()
            + self.root_to_triples.offsets.len()
            + self.root_to_triples.values.len())
            * 4
            + self.surface_arena.len()
            + (self.lemma_ids.len() + self.root_ids.len()) * 48
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csr_groups_pairs() {
        let pairs = vec![(2u32, 10u32), (1, 11), (2, 12), (5, 13)];
        let csr = Csr::build(5, pairs.into_iter());
        assert_eq!(csr.get(2), &[10, 12]);
        assert_eq!(csr.get(1), &[11]);
        assert_eq!(csr.get(5), &[13]);
        assert!(csr.get(3).is_empty());
        assert!(csr.get(99).is_empty());
    }

    #[test]
    fn triple_term_is_zero_padded() {
        assert_eq!(triple_term(42), "0000042");
    }
}
