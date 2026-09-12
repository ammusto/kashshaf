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
//! The maps come from one of two places, in this order:
//!
//! 1. **`triples.bin` next to `corpus.db`** — the sidecar written by the
//!    corpus build, read and validated in one pass and used as slice views
//!    over a single buffer (no decoding, no sorting, no hashing).
//! 2. **`corpus.db` itself** (`triples`, `token_definitions.triple_id`,
//!    `lemmas`, `roots`) — the original path: normalize every surface, sort
//!    them, build the reverse maps. Several seconds on the full corpus.
//!
//! Both build the *same* [`Image`], so a corpus without the sidecar, or with
//! a stale one, behaves exactly as it did before it existed; a mismatch only
//! costs the slower load and one warning.

use crate::normalize::normalize_arabic;
use crate::triples_image::{
    build_csr, Image, ImageParts, NO_SURFACE, SIDECAR_NAME, S_DEF_TO_TRIPLE, S_LEMMA_CSR_OFFSETS, S_LEMMA_CSR_VALUES,
    S_LEMMA_KEY_BLOB, S_LEMMA_KEY_IDS, S_LEMMA_KEY_OFFSETS, S_ROOT_CSR_OFFSETS, S_ROOT_CSR_VALUES, S_ROOT_KEY_BLOB,
    S_ROOT_KEY_IDS, S_ROOT_KEY_OFFSETS, S_SURFACE_BLOB, S_SURFACE_OFFSETS, S_SURFACE_SORTED, S_TRIPLE_LEMMA,
    S_TRIPLE_ROOT, S_TRIPLE_SURFACE_POS,
};
use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use std::path::Path;

/// Digits in a compound `tokens` term.
pub const TRIPLE_TOKEN_WIDTH: usize = 7;

pub fn triple_term(id: u32) -> String {
    format!("{:0width$}", id, width = TRIPLE_TOKEN_WIDTH)
}

/// Where a loaded set of triple maps came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TripleSource {
    /// The `triples.bin` sidecar.
    Sidecar,
    /// Built from `corpus.db` (no sidecar, or it was rejected).
    Sqlite,
}

pub struct TripleMaps {
    img: Image,
    source: TripleSource,
}

impl TripleMaps {
    /// Load from `corpus.db`, preferring the `triples.bin` sidecar beside it.
    /// Returns `Ok(None)` when the database has no `triples` table (schema < 4).
    pub fn load(corpus_db: &Path) -> Result<Option<Self>> {
        let conn = Connection::open(corpus_db).with_context(|| format!("opening {:?}", corpus_db))?;
        let has: bool = conn
            .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='triples'", [], |_| Ok(true))
            .unwrap_or(false);
        if !has {
            return Ok(None);
        }
        // What a sidecar has to agree with.
        let db_info: Option<(String, i64)> = conn
            .query_row("SELECT corpus_version, schema_version FROM db_info LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok();

        let sidecar = corpus_db.with_file_name(SIDECAR_NAME);
        if sidecar.exists() {
            match &db_info {
                Some((corpus_version, schema_version)) => {
                    let t0 = std::time::Instant::now();
                    match Image::read_sidecar(&sidecar, corpus_version, *schema_version as u32) {
                        Ok(img) => {
                            let me = Self { img, source: TripleSource::Sidecar };
                            eprintln!(
                                "[triples] {} {}: {} triples, {} definitions, {} lemmas, {} roots, {} MB in {} ms",
                                SIDECAR_NAME,
                                corpus_version,
                                me.triple_count(),
                                me.img.counts().n_defs,
                                me.img.counts().n_lemma_keys,
                                me.img.counts().n_root_keys,
                                me.img.len() / 1_000_000,
                                t0.elapsed().as_millis()
                            );
                            return Ok(Some(me));
                        }
                        Err(e) => warn_once(&format!(
                            "[triples] ignoring {:?}: {} — falling back to corpus.db (slower startup)",
                            sidecar, e
                        )),
                    }
                }
                None => warn_once(&format!(
                    "[triples] ignoring {:?}: corpus.db has no db_info to validate it against",
                    sidecar
                )),
            }
        }

        let t0 = std::time::Instant::now();
        let parts = Self::parts_from_sqlite(&conn, db_info)?;
        let t_parts = t0.elapsed().as_millis();
        let img = Image::build(&parts)?;
        if std::env::var_os("KASHSHAF_TRIPLES_DEBUG").is_some() {
            eprintln!("[triples]   {:<14} {:>6} ms", "image build", t0.elapsed().as_millis() - t_parts);
        }
        let me = Self { img, source: TripleSource::Sqlite };
        eprintln!(
            "[triples] corpus.db: {} triples, {} definitions, {} lemmas, {} roots, {} MB in {} ms (no sidecar; build one with build_triples_sidecar.py)",
            me.triple_count(),
            me.img.counts().n_defs,
            me.img.counts().n_lemma_keys,
            me.img.counts().n_root_keys,
            me.img.len() / 1_000_000,
            t0.elapsed().as_millis()
        );
        Ok(Some(me))
    }

    /// Read the tables and lay them out exactly as the sidecar does. Public so
    /// tests (and a sidecar writer) can compare the two byte for byte.
    pub fn parts_from_sqlite(conn: &Connection, db_info: Option<(String, i64)>) -> Result<ImageParts> {
        let debug = std::env::var_os("KASHSHAF_TRIPLES_DEBUG").is_some();
        let t = std::time::Instant::now();
        let phase = |name: &str| {
            if debug {
                eprintln!("[triples]   {:<14} {:>6} ms", name, t.elapsed().as_millis());
            }
        };
        let (corpus_version, db_schema_version) = match db_info {
            Some((v, s)) => (v, s as u32),
            None => (String::new(), 0),
        };

        // Forward arrays, sized by the id space.
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
        if surfaces.is_empty() {
            bail!("triples table is empty");
        }
        phase("triples rows");

        // def id -> triple id
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

        phase("def rows");

        // Reverse maps, keyed by the largest id that actually occurs.
        let max_lemma = *triple_lemma.iter().max().unwrap_or(&0) as usize;
        let max_root = *triple_root.iter().max().unwrap_or(&0) as usize;
        let (lemma_csr_offsets, lemma_csr_values) = build_csr(
            max_lemma,
            triple_lemma.iter().enumerate().filter(|(_, &l)| l != 0).map(|(t, &l)| (l, t as u32)),
        );
        let (root_csr_offsets, root_csr_values) =
            build_csr(max_root, triple_root.iter().enumerate().filter(|(_, &r)| r != 0).map(|(t, &r)| (r, t as u32)));

        phase("csr");

        // Surfaces in sorted order: blob, offsets, the permutation, and each
        // triple's position in it.
        surfaces.sort_unstable();
        phase("surface sort");
        let mut surface_sorted = Vec::with_capacity(surfaces.len());
        let mut surface_offsets = Vec::with_capacity(surfaces.len() + 1);
        let mut surface_blob: Vec<u8> = Vec::with_capacity(surfaces.iter().map(|(s, _)| s.len()).sum());
        let mut triple_surface_pos = vec![NO_SURFACE; n];
        surface_offsets.push(0u32);
        for (pos, (s, id)) in surfaces.iter().enumerate() {
            surface_blob.extend_from_slice(s.as_bytes());
            surface_offsets.push(surface_blob.len() as u32);
            surface_sorted.push(*id);
            triple_surface_pos[*id as usize] = pos as u32;
        }

        phase("surface blob");

        // Sorted key blobs for the string -> id maps (binary searched).
        let (lemma_key_offsets, lemma_key_blob, lemma_key_ids) = sorted_keys(conn, "SELECT id, lemma FROM lemmas")?;
        let (root_key_offsets, root_key_blob, root_key_ids) = sorted_keys(conn, "SELECT id, root FROM roots")?;
        phase("key blobs");

        Ok(ImageParts {
            corpus_version,
            db_schema_version,
            triple_surface_pos,
            triple_lemma,
            triple_root,
            surface_sorted,
            surface_offsets,
            surface_blob,
            lemma_csr_offsets,
            lemma_csr_values,
            root_csr_offsets,
            root_csr_values,
            def_to_triple,
            lemma_key_offsets,
            lemma_key_blob,
            lemma_key_ids,
            root_key_offsets,
            root_key_blob,
            root_key_ids,
        })
    }

    /// Where these maps came from.
    pub fn source(&self) -> TripleSource {
        self.source
    }

    /// The image behind the maps (tests, and writing a sidecar).
    pub fn image(&self) -> &Image {
        &self.img
    }

    pub fn triple_count(&self) -> usize {
        self.img.counts().n_surfaces as usize
    }

    #[inline]
    pub fn triple_of_def(&self, def_id: u32) -> u32 {
        self.img.u32s(S_DEF_TO_TRIPLE).get(def_id as usize).copied().unwrap_or(0)
    }

    pub fn lemma_of_triple(&self, triple: u32) -> u32 {
        self.img.u32s(S_TRIPLE_LEMMA).get(triple as usize).copied().unwrap_or(0)
    }

    pub fn root_of_triple(&self, triple: u32) -> u32 {
        self.img.u32s(S_TRIPLE_ROOT).get(triple as usize).copied().unwrap_or(0)
    }

    /// Normalized surface of a triple, or `None` for an id with no row.
    pub fn surface_of_triple(&self, triple: u32) -> Option<&str> {
        let pos = self.img.u32s(S_TRIPLE_SURFACE_POS).get(triple as usize).copied()?;
        if pos == NO_SURFACE {
            return None;
        }
        Some(self.surface_at(pos as usize))
    }

    #[inline]
    fn surface_sorted(&self) -> &[u32] {
        self.img.u32s(S_SURFACE_SORTED)
    }

    #[inline]
    fn surface_at(&self, sorted_pos: usize) -> &str {
        self.img.str_at(S_SURFACE_BLOB, S_SURFACE_OFFSETS, sorted_pos)
    }

    /// First sorted position whose surface is >= `s`.
    fn lower_bound(&self, s: &str) -> usize {
        let (mut lo, mut hi) = (0usize, self.surface_sorted().len());
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
        let sorted = self.surface_sorted();
        let mut i = self.lower_bound(word);
        let mut out = Vec::new();
        while i < sorted.len() && self.surface_at(i) == word {
            out.push(sorted[i]);
            i += 1;
        }
        out
    }

    /// Every triple whose normalized surface starts with `prefix` and (if
    /// given) ends with `suffix`, in surface order. Unbounded: a one-letter
    /// prefix returns a large share of the vocabulary and the caller decides
    /// how to match a slot that wide.
    pub fn triples_for_wildcard(&self, prefix: &str, suffix: Option<&str>) -> Vec<u32> {
        let sorted = self.surface_sorted();
        let mut i = self.lower_bound(prefix);
        let mut out = Vec::new();
        while i < sorted.len() {
            let s = self.surface_at(i);
            if !s.starts_with(prefix) {
                break;
            }
            let ok = match suffix {
                Some(suf) => s.ends_with(suf) && s.len() >= prefix.len() + suf.len(),
                None => true,
            };
            if ok {
                out.push(sorted[i]);
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
        let sorted = self.surface_sorted();
        let mut out = Vec::new();
        match pattern.literal_prefix() {
            Some(prefix) if !prefix.is_empty() => {
                let mut i = self.lower_bound(prefix);
                while i < sorted.len() {
                    let s = self.surface_at(i);
                    if !s.starts_with(prefix) {
                        break;
                    }
                    if pattern.matches(s) {
                        out.push(sorted[i]);
                    }
                    i += 1;
                }
            }
            _ => {
                for i in 0..sorted.len() {
                    if pattern.matches(self.surface_at(i)) {
                        out.push(sorted[i]);
                    }
                }
            }
        }
        out
    }

    /// Triples for a lemma string exactly as CAMeL emits it.
    pub fn triples_for_lemma(&self, lemma: &str) -> Vec<u32> {
        match self.key_id(S_LEMMA_KEY_BLOB, S_LEMMA_KEY_OFFSETS, S_LEMMA_KEY_IDS, lemma) {
            Some(id) => self.csr_get(S_LEMMA_CSR_OFFSETS, S_LEMMA_CSR_VALUES, id).to_vec(),
            None => Vec::new(),
        }
    }

    /// Triples for a root in the dotted, `#`-weak-letter form.
    pub fn triples_for_root(&self, root: &str) -> Vec<u32> {
        match self.key_id(S_ROOT_KEY_BLOB, S_ROOT_KEY_OFFSETS, S_ROOT_KEY_IDS, root) {
            Some(id) => self.csr_get(S_ROOT_CSR_OFFSETS, S_ROOT_CSR_VALUES, id).to_vec(),
            None => Vec::new(),
        }
    }

    /// Binary search a sorted key blob (the image stores keys in byte order).
    fn key_id(&self, blob: usize, offsets: usize, ids: usize, needle: &str) -> Option<u32> {
        let id_list = self.img.u32s(ids);
        let (mut lo, mut hi) = (0usize, id_list.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.img.str_at(blob, offsets, mid).cmp(needle) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(id_list[mid]),
            }
        }
        None
    }

    /// One key's values from a CSR pair. Keys past the table are empty, which
    /// is what a lemma or root that occurs in no triple must return.
    fn csr_get(&self, offsets: usize, values: usize, key: u32) -> &[u32] {
        let offsets = self.img.u32s(offsets);
        let k = key as usize;
        if k + 1 >= offsets.len() {
            return &[];
        }
        &self.img.u32s(values)[offsets[k] as usize..offsets[k + 1] as usize]
    }

    /// Resident size in bytes: the image is one allocation.
    pub fn approx_bytes(&self) -> usize {
        self.img.len()
    }
}

/// `SELECT id, key FROM …` as a byte-sorted key blob plus parallel ids.
fn sorted_keys(conn: &Connection, sql: &str) -> Result<(Vec<u32>, Vec<u8>, Vec<u32>)> {
    let mut stmt = conn.prepare(sql)?;
    let mut keys: Vec<(String, u32)> = Vec::new();
    for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, String>(1)?)))? {
        let (id, s) = row?;
        keys.push((s, id));
    }
    keys.sort_unstable();
    let mut offsets = Vec::with_capacity(keys.len() + 1);
    let mut blob: Vec<u8> = Vec::with_capacity(keys.iter().map(|(s, _)| s.len()).sum());
    let mut ids = Vec::with_capacity(keys.len());
    offsets.push(0u32);
    for (s, id) in &keys {
        blob.extend_from_slice(s.as_bytes());
        offsets.push(blob.len() as u32);
        ids.push(*id);
    }
    Ok((offsets, blob, ids))
}

/// One warning per process, so a stale sidecar does not spam every open.
fn warn_once(msg: &str) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| eprintln!("{}", msg));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::triples_image::build_csr;

    #[test]
    fn triple_term_is_zero_padded() {
        assert_eq!(triple_term(42), "0000042");
    }

    #[test]
    fn csr_groups_pairs() {
        let pairs = vec![(2u32, 10u32), (1, 11), (2, 12), (5, 13)];
        let (offsets, values) = build_csr(5, pairs.into_iter());
        let get = |k: usize| &values[offsets[k] as usize..offsets[k + 1] as usize];
        assert_eq!(get(2), &[10, 12]);
        assert_eq!(get(1), &[11]);
        assert_eq!(get(5), &[13]);
        assert!(get(3).is_empty());
    }

    /// Two triples sharing a lemma, one with no root, to exercise the
    /// accessors over a hand-built image.
    fn maps() -> TripleMaps {
        let mut p = ImageParts {
            corpus_version: "1.2.3".into(),
            db_schema_version: 4,
            // ids 1..=3; sorted surfaces: "ابن"(3), "كتاب"(1), "كتب"(2)
            triple_surface_pos: vec![NO_SURFACE, 1, 2, 0],
            triple_lemma: vec![0, 5, 5, 7],
            triple_root: vec![0, 2, 2, 0],
            surface_sorted: vec![3, 1, 2],
            def_to_triple: vec![0, 1, 1, 2, 3],
            ..Default::default()
        };
        let mut blob = Vec::new();
        let mut offsets = vec![0u32];
        for s in ["ابن", "كتاب", "كتب"] {
            blob.extend_from_slice(s.as_bytes());
            offsets.push(blob.len() as u32);
        }
        p.surface_blob = blob;
        p.surface_offsets = offsets;
        let (lo, lv) =
            build_csr(7, p.triple_lemma.iter().enumerate().filter(|(_, &l)| l != 0).map(|(t, &l)| (l, t as u32)));
        p.lemma_csr_offsets = lo;
        p.lemma_csr_values = lv;
        let (ro, rv) =
            build_csr(2, p.triple_root.iter().enumerate().filter(|(_, &r)| r != 0).map(|(t, &r)| (r, t as u32)));
        p.root_csr_offsets = ro;
        p.root_csr_values = rv;
        // lemma keys sorted by bytes: "ابن" -> 7, "كتب" -> 5
        let mut kb = Vec::new();
        let mut ko = vec![0u32];
        let mut ki = Vec::new();
        for (s, id) in [("ابن", 7u32), ("كتب", 5)] {
            kb.extend_from_slice(s.as_bytes());
            ko.push(kb.len() as u32);
            ki.push(id);
        }
        p.lemma_key_offsets = ko;
        p.lemma_key_blob = kb;
        p.lemma_key_ids = ki;
        p.root_key_offsets = vec![0, "ك.ت.ب".len() as u32];
        p.root_key_blob = "ك.ت.ب".as_bytes().to_vec();
        p.root_key_ids = vec![2];
        TripleMaps { img: Image::build(&p).unwrap(), source: TripleSource::Sqlite }
    }

    #[test]
    fn forward_and_reverse_lookups() {
        let m = maps();
        assert_eq!(m.triple_count(), 3);
        assert_eq!(m.lemma_of_triple(1), 5);
        assert_eq!(m.root_of_triple(3), 0);
        assert_eq!(m.root_of_triple(999), 0, "out of range is 0, not a panic");
        assert_eq!(m.triple_of_def(2), 1);
        assert_eq!(m.triple_of_def(12345), 0);
        assert_eq!(m.surface_of_triple(1), Some("كتاب"));
        assert_eq!(m.surface_of_triple(0), None);
        assert_eq!(m.surface_of_triple(77), None);
        assert_eq!(m.triples_for_surface("كتاب"), vec![1]);
        assert!(m.triples_for_surface("لا").is_empty());
        assert_eq!(m.triples_for_lemma("كتب"), vec![1, 2], "ascending triple ids within a key");
        assert_eq!(m.triples_for_lemma("ابن"), vec![3]);
        assert!(m.triples_for_lemma("غائب").is_empty());
        assert_eq!(m.triples_for_root("ك.ت.ب"), vec![1, 2]);
        assert!(m.triples_for_root("ق.#.ل").is_empty());
        assert_eq!(m.triples_for_wildcard("كت", None), vec![1, 2], "surface order");
        assert_eq!(m.triples_for_wildcard("كت", Some("ب")), vec![1, 2]);
        assert_eq!(m.triples_for_glob(&crate::glob::GlobPattern::parse("كت*")), vec![1, 2]);
        assert_eq!(m.triples_for_glob(&crate::glob::GlobPattern::parse("*ن")), vec![3]);
        assert!(m.approx_bytes() > 0);
    }
}
