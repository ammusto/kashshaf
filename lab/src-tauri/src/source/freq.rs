//! Corpus-wide frequency tables (Lab spec §3.4).
//!
//! Keyness needs, for every lemma (or root) in a book, how often it occurs in
//! the whole corpus. Counting that means decoding every page of the corpus —
//! 5.7 million pages, 992 million tokens for 4.1.0 — which is minutes of
//! work, so it is done once, at corpus build time, by
//! `kashshaf-data-clean/build_lab_freq.py`, and shipped as `lemma_freq.bin`
//! and `root_freq.bin`. Both modes read the same files: local mode from the
//! corpus directory, api mode after downloading them into Lab's cache. When
//! neither is there, local mode can build them itself, with progress and
//! cancellation (ground rule 6), and api mode says keyness is unavailable.
//!
//! Keyed by the lemma / root *string*, not by id: `Token` carries no ids, and
//! a string key is what both modes have in hand. The spec's `freq(layer, id)`
//! is therefore `freq(layer, key)`.
//!
//! # File format (`KSHFFREQ`, version 1)
//!
//! All integers little-endian.
//!
//! ```text
//! magic            8 bytes  "KSHFFREQ"
//! format_version   u32      1
//! layer            u8       1 = lemma, 2 = root
//! corpus_version   u32 len + UTF-8 bytes
//! n_entries        u64
//! total_tokens     u64      every token of the corpus, on this layer
//! key_offsets      (n_entries + 1) × u32   byte offsets into key_blob
//! key_blob         UTF-8, keys concatenated, sorted by bytes
//! counts           n_entries × u64          count per key, same order
//! ```
//!
//! Keys are sorted so lookup is a binary search over the offsets; ranks
//! (1 = most frequent) are computed at load. The Python writer produces
//! byte-identical output, which `tests/freq_snapshot.rs` asserts.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

pub const MAGIC: &[u8; 8] = b"KSHFFREQ";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FreqLayer {
    Lemma = 1,
    Root = 2,
}

impl FreqLayer {
    pub fn file_name(self) -> &'static str {
        match self {
            FreqLayer::Lemma => "lemma_freq.bin",
            FreqLayer::Root => "root_freq.bin",
        }
    }

    fn from_byte(b: u8) -> Option<Self> {
        match b {
            1 => Some(FreqLayer::Lemma),
            2 => Some(FreqLayer::Root),
            _ => None,
        }
    }
}

/// One layer's corpus frequencies, in memory.
#[derive(Debug, Clone)]
pub struct FreqTable {
    pub layer: FreqLayer,
    pub corpus_version: String,
    /// Every token of the corpus on this layer (tokens without a root are
    /// not counted on the root layer).
    pub total: u64,
    keys: Vec<String>,
    counts: Vec<u64>,
    /// `rank[i]` is the 1-based rank of `keys[i]`: 1 = most frequent. Ties
    /// broken by key order, so ranks are total and stable across runs.
    ranks: Vec<u32>,
}

/// What a lookup returns: absent keys have count 0 and no rank.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Freq {
    pub count: u64,
    pub rank: Option<u32>,
}

impl FreqTable {
    /// Build from counts. Keys are sorted here, so callers may pass any order.
    pub fn from_counts(layer: FreqLayer, corpus_version: &str, counts: HashMap<String, u64>) -> Self {
        let mut pairs: Vec<(String, u64)> = counts.into_iter().collect();
        pairs.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let total = pairs.iter().map(|(_, c)| c).sum();
        let keys: Vec<String> = pairs.iter().map(|(k, _)| k.clone()).collect();
        let counts: Vec<u64> = pairs.iter().map(|(_, c)| *c).collect();
        let ranks = rank(&counts);
        Self { layer, corpus_version: corpus_version.to_string(), total, keys, counts, ranks }
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn get(&self, key: &str) -> Freq {
        match self.keys.binary_search_by(|k| k.as_bytes().cmp(key.as_bytes())) {
            Ok(i) => Freq { count: self.counts[i], rank: Some(self.ranks[i]) },
            Err(_) => Freq { count: 0, rank: None },
        }
    }

    /// `(key, count)` in key order — what the writer and the tests iterate.
    pub fn entries(&self) -> impl Iterator<Item = (&str, u64)> + '_ {
        self.keys.iter().map(String::as_str).zip(self.counts.iter().copied())
    }

    // ------------------------------------------------------------ I/O ---

    pub fn write_to<W: Write>(&self, mut w: W) -> Result<()> {
        w.write_all(MAGIC)?;
        w.write_all(&FORMAT_VERSION.to_le_bytes())?;
        w.write_all(&[self.layer as u8])?;
        let cv = self.corpus_version.as_bytes();
        w.write_all(&(cv.len() as u32).to_le_bytes())?;
        w.write_all(cv)?;
        w.write_all(&(self.keys.len() as u64).to_le_bytes())?;
        w.write_all(&self.total.to_le_bytes())?;
        let mut off: u32 = 0;
        for k in &self.keys {
            w.write_all(&off.to_le_bytes())?;
            off = off
                .checked_add(k.len() as u32)
                .ok_or_else(|| anyhow!("key blob exceeds 4 GiB"))?;
        }
        w.write_all(&off.to_le_bytes())?;
        for k in &self.keys {
            w.write_all(k.as_bytes())?;
        }
        for c in &self.counts {
            w.write_all(&c.to_le_bytes())?;
        }
        Ok(())
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("part");
        {
            let f = std::fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
            self.write_to(std::io::BufWriter::new(f))?;
        }
        std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
        Ok(())
    }

    pub fn read_from<R: Read>(mut r: R) -> Result<Self> {
        let mut magic = [0u8; 8];
        r.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(anyhow!("not a Kashshaf frequency table (bad magic)"));
        }
        let version = read_u32(&mut r)?;
        if version != FORMAT_VERSION {
            return Err(anyhow!("frequency table format {} is not supported (want {})", version, FORMAT_VERSION));
        }
        let mut layer = [0u8; 1];
        r.read_exact(&mut layer)?;
        let layer = FreqLayer::from_byte(layer[0]).ok_or_else(|| anyhow!("unknown layer {}", layer[0]))?;
        let cv_len = read_u32(&mut r)? as usize;
        let mut cv = vec![0u8; cv_len];
        r.read_exact(&mut cv)?;
        let corpus_version = String::from_utf8(cv).context("corpus_version is not UTF-8")?;
        let n = read_u64(&mut r)? as usize;
        let total = read_u64(&mut r)?;

        let mut offsets = Vec::with_capacity(n + 1);
        for _ in 0..=n {
            offsets.push(read_u32(&mut r)? as usize);
        }
        let blob_len = *offsets.last().unwrap_or(&0);
        let mut blob = vec![0u8; blob_len];
        r.read_exact(&mut blob)?;
        let mut keys = Vec::with_capacity(n);
        for i in 0..n {
            let (a, b) = (offsets[i], offsets[i + 1]);
            if a > b || b > blob_len {
                return Err(anyhow!("corrupt key offsets at entry {}", i));
            }
            keys.push(std::str::from_utf8(&blob[a..b]).context("key is not UTF-8")?.to_string());
        }
        if keys.windows(2).any(|w| w[0].as_bytes() >= w[1].as_bytes()) {
            return Err(anyhow!("keys are not strictly sorted"));
        }
        let mut counts = Vec::with_capacity(n);
        for _ in 0..n {
            counts.push(read_u64(&mut r)?);
        }
        let ranks = rank(&counts);
        Ok(Self { layer, corpus_version, total, keys, counts, ranks })
    }

    pub fn read(path: &Path) -> Result<Self> {
        let f = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::read_from(std::io::BufReader::new(f))
    }
}

/// 1-based ranks by count descending, ties by key order (index ascending).
fn rank(counts: &[u64]) -> Vec<u32> {
    let mut order: Vec<usize> = (0..counts.len()).collect();
    order.sort_by(|&a, &b| counts[b].cmp(&counts[a]).then(a.cmp(&b)));
    let mut ranks = vec![0u32; counts.len()];
    for (r, i) in order.into_iter().enumerate() {
        ranks[i] = r as u32 + 1;
    }
    ranks
}

fn read_u32<R: Read>(r: &mut R) -> Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

/// Build both tables by scanning a whole corpus through its `TokenCache` —
/// the local-mode fallback when the shipped files are absent.
///
/// `progress(done_books, total_books)` is called per book; `cancelled()` is
/// polled per book and a cancelled build returns `Ok(None)` having written
/// nothing (ground rule 6: a cancelled run keeps what it finished — here
/// there is nothing partial worth keeping, so it keeps the absence).
/// Build both tables from `corpus.db` (Lab spec 1.4, fix 4).
///
/// `corpus.db` holds no per-definition counts, so the tokens must be
/// counted — but never as strings. `TokenCache::book_pages` yields each
/// page's definition ids; those are tallied into a flat `Vec<u64>` indexed
/// by definition id, and only at the end are the definitions joined to
/// their lemma and root strings through `token_definitions`, `lemmas` and
/// `roots`. The result is byte-identical to `build_lab_freq.py`'s (the
/// snapshot test checks it) and runs at the bulk fetch's speed rather than
/// at one string allocation per token — the in-app build took about an hour
/// on the full corpus that way.
pub fn build_from_corpus(
    cache: &kashshaf_engine::TokenCache,
    corpus_db: &Path,
    book_ids: &[u64],
    corpus_version: &str,
    progress: &dyn Fn(u64, u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<(FreqTable, FreqTable)>> {
    let mut by_def: Vec<u64> = Vec::new();
    let total = book_ids.len() as u64;
    for (i, &book) in book_ids.iter().enumerate() {
        if cancelled() {
            return Ok(None);
        }
        for (_, _, ids) in cache.book_pages(book)? {
            for id in ids {
                let id = id as usize;
                if id >= by_def.len() {
                    by_def.resize(id + 1, 0);
                }
                by_def[id] += 1;
            }
        }
        progress(i as u64 + 1, total);
    }
    if cancelled() {
        return Ok(None);
    }
    // Definition → (lemma, root) once, then the string tables once.
    let conn = rusqlite::Connection::open_with_flags(corpus_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {}", corpus_db.display()))?;
    let mut lemma_of: HashMap<i64, String> = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, lemma FROM lemmas")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, s) = r?;
        lemma_of.insert(id, s);
    }
    let mut root_of: HashMap<i64, String> = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, root FROM roots")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, s) = r?;
        root_of.insert(id, s);
    }
    let mut lemmas: HashMap<String, u64> = HashMap::new();
    let mut roots: HashMap<String, u64> = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, lemma_id, root_id FROM token_definitions")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?)))? {
        let (id, lemma_id, root_id) = r?;
        let n = by_def.get(id as usize).copied().unwrap_or(0);
        if n == 0 {
            continue;
        }
        if let Some(l) = lemma_of.get(&lemma_id) {
            *lemmas.entry(l.clone()).or_insert(0) += n;
        }
        if let Some(r) = root_id.and_then(|r| root_of.get(&r)) {
            *roots.entry(r.clone()).or_insert(0) += n;
        }
    }
    Ok(Some((
        FreqTable::from_counts(FreqLayer::Lemma, corpus_version, lemmas),
        FreqTable::from_counts(FreqLayer::Root, corpus_version, roots),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> FreqTable {
        let mut c = HashMap::new();
        c.insert("في".to_string(), 100);
        c.insert("من".to_string(), 90);
        c.insert("قال".to_string(), 90); // tie with من; key order decides
        c.insert("كتاب".to_string(), 5);
        FreqTable::from_counts(FreqLayer::Lemma, "4.1.0", c)
    }

    #[test]
    fn lookups_and_ranks() {
        let t = table();
        assert_eq!(t.total, 285);
        assert_eq!(t.get("في"), Freq { count: 100, rank: Some(1) });
        // Tie: "قال" (U+0642) sorts before "من" (U+0645) by bytes, so it ranks 2.
        assert_eq!(t.get("قال"), Freq { count: 90, rank: Some(2) });
        assert_eq!(t.get("من"), Freq { count: 90, rank: Some(3) });
        assert_eq!(t.get("كتاب"), Freq { count: 5, rank: Some(4) });
        assert_eq!(t.get("غائب"), Freq { count: 0, rank: None });
    }

    #[test]
    fn the_file_round_trips_byte_for_byte() {
        let t = table();
        let mut bytes = Vec::new();
        t.write_to(&mut bytes).unwrap();
        assert_eq!(&bytes[..8], MAGIC);
        let back = FreqTable::read_from(&bytes[..]).unwrap();
        assert_eq!(back.corpus_version, "4.1.0");
        assert_eq!(back.layer, FreqLayer::Lemma);
        assert_eq!(back.total, t.total);
        assert_eq!(back.entries().collect::<Vec<_>>(), t.entries().collect::<Vec<_>>());
        assert_eq!(back.get("من"), t.get("من"));
        // Writing what was read gives the same bytes: the format is canonical.
        let mut again = Vec::new();
        back.write_to(&mut again).unwrap();
        assert_eq!(again, bytes);
    }

    #[test]
    fn a_known_layout_is_produced() {
        // Two keys, "a" and "b", so the bytes can be checked by hand — and so
        // the Python writer has a fixture to match exactly.
        let mut c = HashMap::new();
        c.insert("b".to_string(), 2u64);
        c.insert("a".to_string(), 7u64);
        let t = FreqTable::from_counts(FreqLayer::Root, "x", c);
        let mut bytes = Vec::new();
        t.write_to(&mut bytes).unwrap();
        let mut want = Vec::new();
        want.extend_from_slice(b"KSHFFREQ");
        want.extend_from_slice(&1u32.to_le_bytes());
        want.push(2); // root
        want.extend_from_slice(&1u32.to_le_bytes());
        want.extend_from_slice(b"x");
        want.extend_from_slice(&2u64.to_le_bytes()); // n_entries
        want.extend_from_slice(&9u64.to_le_bytes()); // total
        want.extend_from_slice(&0u32.to_le_bytes());
        want.extend_from_slice(&1u32.to_le_bytes());
        want.extend_from_slice(&2u32.to_le_bytes());
        want.extend_from_slice(b"ab");
        want.extend_from_slice(&7u64.to_le_bytes());
        want.extend_from_slice(&2u64.to_le_bytes());
        assert_eq!(bytes, want);
    }

    #[test]
    fn bad_input_is_refused_not_misread() {
        assert!(FreqTable::read_from(&b"NOTAFILE"[..]).is_err());
        let t = table();
        let mut bytes = Vec::new();
        t.write_to(&mut bytes).unwrap();
        bytes[8] = 9; // format version 9
        assert!(FreqTable::read_from(&bytes[..]).unwrap_err().to_string().contains("format 9"));
        // Truncated
        let mut bytes = Vec::new();
        t.write_to(&mut bytes).unwrap();
        bytes.truncate(bytes.len() - 3);
        assert!(FreqTable::read_from(&bytes[..]).is_err());
    }
}
