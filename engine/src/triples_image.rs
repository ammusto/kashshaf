//! On-disk (and in-memory) image of the triple maps: the `triples.bin`
//! sidecar format.
//!
//! The point of the format is that **both** ways of getting triple maps
//! produce the same bytes: the sidecar written by the corpus build
//! (`kashshaf-data-clean/build_triples_sidecar.py`) and the fallback that
//! reads `corpus.db` directly ([`Image::build`]). [`TripleMaps`] then only
//! ever reads through [`Image`], so the two paths cannot diverge — and a test
//! can assert the sidecar is byte-identical to the image built from SQL.
//!
//! Everything is little-endian and fixed-width, and every section starts at
//! an 8-byte boundary, so `u32` sections are handed out as `&[u32]` slices
//! over the buffer without copying or decoding.
//!
//! ```text
//! header (512 bytes)
//!   0   8  magic "KSHFTRPL"
//!   8   4  format_version = 1
//!   12  4  header_size = 512
//!   16  4  db_schema_version   (copied from corpus.db db_info)
//!   20  4  n_triples           (max triple id + 1: length of the forward arrays)
//!   24  4  n_surfaces          (rows in `triples`: entries in surface_sorted)
//!   28  4  n_defs              (max token_definitions id + 1)
//!   32  4  n_lemma_keys        (rows in `lemmas`)
//!   36  4  n_root_keys         (rows in `roots`)
//!   40  4  n_lemma_csr         (lemma CSR keys = offsets len - 1)
//!   44  4  n_root_csr          (root CSR keys  = offsets len - 1)
//!   48  4  n_sections = 17
//!   52  4  reserved = 0
//!   56  32 corpus_version, UTF-8, NUL-padded
//!   88  17*16  section table: (u64 offset, u64 len) per section
//!   ..  zero padding to header_size
//! sections, in index order, each 8-byte aligned and zero-padded
//! ```
//!
//! Surfaces are stored **in surface-sorted order** (not triple-id order) so a
//! wildcard scan walks the blob sequentially; the forward array therefore
//! holds each triple's *sorted position*, from which the blob offset and
//! length follow (`surface_offsets[pos .. pos + 2]`).

use anyhow::{anyhow, bail, Result};
use std::ops::Range;
use std::path::Path;

pub const MAGIC: &[u8; 8] = b"KSHFTRPL";
pub const FORMAT_VERSION: u32 = 1;
pub const HEADER_SIZE: usize = 512;
pub const ALIGN: usize = 8;
/// Name of the sidecar, next to `corpus.db`.
pub const SIDECAR_NAME: &str = "triples.bin";
/// No surface for this triple id (a gap in the id space, or id 0).
pub const NO_SURFACE: u32 = u32::MAX;

// Section indices.
pub const S_TRIPLE_SURFACE_POS: usize = 0;
pub const S_TRIPLE_LEMMA: usize = 1;
pub const S_TRIPLE_ROOT: usize = 2;
pub const S_SURFACE_SORTED: usize = 3;
pub const S_SURFACE_OFFSETS: usize = 4;
pub const S_SURFACE_BLOB: usize = 5;
pub const S_LEMMA_CSR_OFFSETS: usize = 6;
pub const S_LEMMA_CSR_VALUES: usize = 7;
pub const S_ROOT_CSR_OFFSETS: usize = 8;
pub const S_ROOT_CSR_VALUES: usize = 9;
pub const S_DEF_TO_TRIPLE: usize = 10;
pub const S_LEMMA_KEY_OFFSETS: usize = 11;
pub const S_LEMMA_KEY_BLOB: usize = 12;
pub const S_LEMMA_KEY_IDS: usize = 13;
pub const S_ROOT_KEY_OFFSETS: usize = 14;
pub const S_ROOT_KEY_BLOB: usize = 15;
pub const S_ROOT_KEY_IDS: usize = 16;
pub const N_SECTIONS: usize = 17;

/// How much of an image to verify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    /// Everything memory safety and bounds depend on: magic, versions, the
    /// section table, the counts, and — because `str_at` skips per-access
    /// validation — that every blob is UTF-8 with offsets on character
    /// boundaries. Fast: a few linear passes, no string comparisons.
    Structural,
    /// Also that the surface and key blobs are really sorted, which is what
    /// the binary searches rely on for *correct* (not merely safe) lookups.
    /// Used for bytes that came from disk.
    Full,
}

/// Header counts, read from the file or computed while building.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub db_schema_version: u32,
    pub n_triples: u32,
    pub n_surfaces: u32,
    pub n_defs: u32,
    pub n_lemma_keys: u32,
    pub n_root_keys: u32,
    pub n_lemma_csr: u32,
    pub n_root_csr: u32,
}

/// Byte buffer whose base address is 8-byte aligned, so any section at an
/// 8-aligned offset can be viewed as `&[u32]`.
struct AlignedBuf {
    words: Vec<u64>,
    len: usize,
}

impl AlignedBuf {
    fn zeroed(len: usize) -> Self {
        Self { words: vec![0u64; len.div_ceil(ALIGN)], len }
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: `u8` has alignment 1 and no invalid bit patterns, so any
        // initialized `u64` storage is a valid byte slice of the same extent.
        let all = unsafe { std::slice::from_raw_parts(self.words.as_ptr() as *const u8, self.words.len() * ALIGN) };
        &all[..self.len]
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        // SAFETY: as above; writing arbitrary bytes into `u64` storage is
        // sound because every bit pattern is a valid `u64`.
        let all =
            unsafe { std::slice::from_raw_parts_mut(self.words.as_mut_ptr() as *mut u8, self.words.len() * ALIGN) };
        &mut all[..self.len]
    }

    fn byte_capacity(&self) -> usize {
        self.words.len() * ALIGN
    }
}

/// A validated triple-map image: one owned aligned buffer plus the byte range
/// of each section. All accessors are slice views over the buffer.
pub struct Image {
    buf: AlignedBuf,
    sections: [Range<usize>; N_SECTIONS],
    counts: Counts,
    corpus_version: String,
}

impl std::fmt::Debug for Image {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Image")
            .field("corpus_version", &self.corpus_version)
            .field("bytes", &self.buf.len)
            .field("counts", &self.counts)
            .finish()
    }
}

impl Image {
    pub fn counts(&self) -> Counts {
        self.counts
    }

    pub fn corpus_version(&self) -> &str {
        &self.corpus_version
    }

    /// Bytes held by the image (its exact resident size).
    pub fn len(&self) -> usize {
        self.buf.len
    }

    pub fn is_empty(&self) -> bool {
        self.buf.len == 0
    }

    /// The whole image as bytes (tests, and writing it back out).
    pub fn as_bytes(&self) -> &[u8] {
        self.buf.bytes()
    }

    #[inline]
    pub fn bytes(&self, section: usize) -> &[u8] {
        &self.buf.bytes()[self.sections[section].clone()]
    }

    #[inline]
    pub fn u32s(&self, section: usize) -> &[u32] {
        let r = self.sections[section].clone();
        let bytes = &self.buf.bytes()[r];
        debug_assert_eq!(bytes.as_ptr() as usize % 4, 0);
        debug_assert_eq!(bytes.len() % 4, 0);
        // SAFETY: `validate` rejected any section whose offset is not
        // 8-aligned or whose length is not a multiple of 4, and the buffer's
        // base is 8-aligned, so the pointer is 4-aligned and the extent is an
        // exact number of `u32`s. `u32` has no invalid bit patterns.
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u32, bytes.len() / 4) }
    }

    /// One string from a sorted key blob / the surface blob.
    ///
    /// `validate` checked that the blob is UTF-8 and that every offset lands
    /// on a character boundary, so no per-access validation is needed.
    #[inline]
    pub fn str_at(&self, blob_section: usize, offsets_section: usize, i: usize) -> &str {
        let offsets = self.u32s(offsets_section);
        let blob = self.bytes(blob_section);
        let (a, b) = (offsets[i] as usize, offsets[i + 1] as usize);
        // SAFETY: `validate` verified `blob` is UTF-8 and that every offset is
        // a character boundary in it, and that offsets are non-decreasing and
        // end at `blob.len()`.
        unsafe { std::str::from_utf8_unchecked(&blob[a..b]) }
    }

    // ---------------------------------------------------------------- read

    /// Read and validate a sidecar. `expect` is what `corpus.db`'s `db_info`
    /// reports; a mismatch is an error so the caller can fall back.
    pub fn read_sidecar(path: &Path, expect_corpus_version: &str, expect_db_schema: u32) -> Result<Self> {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < HEADER_SIZE as u64 {
            bail!("too short ({} bytes, header needs {})", len, HEADER_SIZE);
        }
        if len > usize::MAX as u64 {
            bail!("file too large for this platform");
        }
        let mut buf = AlignedBuf::zeroed(len as usize);
        f.read_exact(buf.bytes_mut())?;
        let img = Self::validate(buf, Check::Full)?;
        if img.corpus_version != expect_corpus_version {
            bail!("corpus_version {:?}, corpus.db says {:?}", img.corpus_version, expect_corpus_version);
        }
        if img.counts.db_schema_version != expect_db_schema {
            bail!("db_schema_version {}, corpus.db says {}", img.counts.db_schema_version, expect_db_schema);
        }
        Ok(img)
    }

    fn u32_at(bytes: &[u8], off: usize) -> u32 {
        u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
    }

    fn u64_at(bytes: &[u8], off: usize) -> u64 {
        let mut w = [0u8; 8];
        w.copy_from_slice(&bytes[off..off + 8]);
        u64::from_le_bytes(w)
    }

    /// Check every invariant the accessors rely on. Truncation, a bad magic, a
    /// wrong version, an out-of-range section, a misaligned section, an
    /// inconsistent count, a non-UTF-8 blob or an offset that is not a
    /// character boundary all end up here as an error.
    fn validate(buf: AlignedBuf, check: Check) -> Result<Self> {
        let bytes = buf.bytes();
        // Guard before any header field is read: `validate` is the safety gate
        // for bytes from disk, so it must not index past a short buffer.
        if bytes.len() < HEADER_SIZE {
            bail!("{} bytes, the header alone needs {} (truncated?)", bytes.len(), HEADER_SIZE);
        }
        if &bytes[..8] != MAGIC {
            bail!("bad magic {:?} (expected {:?})", &bytes[..8], MAGIC);
        }
        let format_version = Self::u32_at(bytes, 8);
        if format_version != FORMAT_VERSION {
            bail!("format version {} (this build reads {})", format_version, FORMAT_VERSION);
        }
        let header_size = Self::u32_at(bytes, 12) as usize;
        let n_sections = Self::u32_at(bytes, 48) as usize;
        if n_sections != N_SECTIONS {
            bail!("{} sections (this build reads {})", n_sections, N_SECTIONS);
        }
        if header_size < 88 + N_SECTIONS * 16 || header_size % ALIGN != 0 || header_size > bytes.len() {
            bail!("header_size {} is not usable", header_size);
        }
        let counts = Counts {
            db_schema_version: Self::u32_at(bytes, 16),
            n_triples: Self::u32_at(bytes, 20),
            n_surfaces: Self::u32_at(bytes, 24),
            n_defs: Self::u32_at(bytes, 28),
            n_lemma_keys: Self::u32_at(bytes, 32),
            n_root_keys: Self::u32_at(bytes, 36),
            n_lemma_csr: Self::u32_at(bytes, 40),
            n_root_csr: Self::u32_at(bytes, 44),
        };
        let cv = &bytes[56..88];
        let cv_len = cv.iter().position(|&b| b == 0).unwrap_or(cv.len());
        let corpus_version =
            std::str::from_utf8(&cv[..cv_len]).map_err(|e| anyhow!("corpus_version is not UTF-8: {}", e))?.to_string();

        // Section table.
        let mut sections: [Range<usize>; N_SECTIONS] = std::array::from_fn(|_| 0..0);
        for (i, slot) in sections.iter_mut().enumerate() {
            let at = 88 + i * 16;
            let off = Self::u64_at(bytes, at);
            let len = Self::u64_at(bytes, at + 8);
            let end = off.checked_add(len).ok_or_else(|| anyhow!("section {} overflows", i))?;
            if end > bytes.len() as u64 {
                bail!("section {} ends at {} but the file is {} bytes (truncated?)", i, end, bytes.len());
            }
            if off < header_size as u64 {
                bail!("section {} starts inside the header", i);
            }
            if off % ALIGN as u64 != 0 {
                bail!("section {} is not {}-byte aligned", i, ALIGN);
            }
            *slot = off as usize..end as usize;
        }

        // Per-section lengths must match the header counts exactly.
        let u32_len = |r: &Range<usize>| -> Result<usize> {
            if (r.end - r.start) % 4 != 0 {
                bail!("section length {} is not a multiple of 4", r.end - r.start);
            }
            Ok((r.end - r.start) / 4)
        };
        let want = |name: &str, got: usize, expect: usize| -> Result<()> {
            if got != expect {
                bail!("{}: {} entries, header implies {}", name, got, expect);
            }
            Ok(())
        };
        let n_triples = counts.n_triples as usize;
        let n_surfaces = counts.n_surfaces as usize;
        want("triple_surface_pos", u32_len(&sections[S_TRIPLE_SURFACE_POS])?, n_triples)?;
        want("triple_lemma", u32_len(&sections[S_TRIPLE_LEMMA])?, n_triples)?;
        want("triple_root", u32_len(&sections[S_TRIPLE_ROOT])?, n_triples)?;
        want("surface_sorted", u32_len(&sections[S_SURFACE_SORTED])?, n_surfaces)?;
        want("surface_offsets", u32_len(&sections[S_SURFACE_OFFSETS])?, n_surfaces + 1)?;
        want("def_to_triple", u32_len(&sections[S_DEF_TO_TRIPLE])?, counts.n_defs as usize)?;
        want("lemma_csr_offsets", u32_len(&sections[S_LEMMA_CSR_OFFSETS])?, counts.n_lemma_csr as usize + 1)?;
        want("root_csr_offsets", u32_len(&sections[S_ROOT_CSR_OFFSETS])?, counts.n_root_csr as usize + 1)?;
        want("lemma_key_offsets", u32_len(&sections[S_LEMMA_KEY_OFFSETS])?, counts.n_lemma_keys as usize + 1)?;
        want("lemma_key_ids", u32_len(&sections[S_LEMMA_KEY_IDS])?, counts.n_lemma_keys as usize)?;
        want("root_key_offsets", u32_len(&sections[S_ROOT_KEY_OFFSETS])?, counts.n_root_keys as usize + 1)?;
        want("root_key_ids", u32_len(&sections[S_ROOT_KEY_IDS])?, counts.n_root_keys as usize)?;
        u32_len(&sections[S_LEMMA_CSR_VALUES])?;
        u32_len(&sections[S_ROOT_CSR_VALUES])?;
        if n_surfaces == 0 {
            bail!("no surfaces");
        }

        let img = Self { buf, sections, counts, corpus_version };

        // Offsets must be non-decreasing, end at the blob length, and land on
        // character boundaries of a valid UTF-8 blob: that is what lets
        // `str_at` skip validation.
        for (name, blob_s, off_s, n) in [
            ("surface", S_SURFACE_BLOB, S_SURFACE_OFFSETS, n_surfaces),
            ("lemma key", S_LEMMA_KEY_BLOB, S_LEMMA_KEY_OFFSETS, counts.n_lemma_keys as usize),
            ("root key", S_ROOT_KEY_BLOB, S_ROOT_KEY_OFFSETS, counts.n_root_keys as usize),
        ] {
            let blob = img.bytes(blob_s);
            let text = std::str::from_utf8(blob).map_err(|e| anyhow!("{} blob is not UTF-8: {}", name, e))?;
            let offsets = img.u32s(off_s);
            if offsets[0] != 0 || *offsets.last().unwrap() as usize != blob.len() {
                bail!("{} offsets span {}..{}, blob is {} bytes", name, offsets[0], offsets.last().unwrap(), blob.len());
            }
            let mut prev = 0u32;
            for (i, &o) in offsets.iter().enumerate() {
                if o < prev {
                    bail!("{} offsets decrease at {}", name, i);
                }
                if !text.is_char_boundary(o as usize) {
                    bail!("{} offset {} is not a character boundary", name, o);
                }
                prev = o;
            }
            // Keys are binary-searched, so they must be sorted; surfaces are
            // binary-searched too (`lower_bound`). This is the one pass that
            // costs string comparisons, so it is skipped for an image this
            // process just built (where the sort is by construction); the
            // byte-identity test in engine/tests/triples_sidecar.rs is what
            // holds the builder to it.
            if check == Check::Full {
                for i in 1..n {
                    if img.str_at(blob_s, off_s, i - 1).as_bytes() > img.str_at(blob_s, off_s, i).as_bytes() {
                        bail!("{} blob is not sorted at {}", name, i);
                    }
                }
            }
        }

        // CSR offsets must be non-decreasing and end at the value count.
        for (name, off_s, val_s) in [
            ("lemma", S_LEMMA_CSR_OFFSETS, S_LEMMA_CSR_VALUES),
            ("root", S_ROOT_CSR_OFFSETS, S_ROOT_CSR_VALUES),
        ] {
            let offsets = img.u32s(off_s);
            let values = img.u32s(val_s);
            if offsets[0] != 0 || *offsets.last().unwrap() as usize != values.len() {
                bail!("{} CSR offsets span {}..{}, {} values", name, offsets[0], offsets.last().unwrap(), values.len());
            }
            if offsets.windows(2).any(|w| w[0] > w[1]) {
                bail!("{} CSR offsets are not monotonic", name);
            }
        }

        Ok(img)
    }

    /// Run the checks [`Check::Structural`] skips (blob sort order). Cheap
    /// enough for a test, too slow to want on every fallback load.
    pub fn validate_sort_order(&self) -> Result<()> {
        for (name, blob_s, off_s, n) in [
            ("surface", S_SURFACE_BLOB, S_SURFACE_OFFSETS, self.counts.n_surfaces as usize),
            ("lemma key", S_LEMMA_KEY_BLOB, S_LEMMA_KEY_OFFSETS, self.counts.n_lemma_keys as usize),
            ("root key", S_ROOT_KEY_BLOB, S_ROOT_KEY_OFFSETS, self.counts.n_root_keys as usize),
        ] {
            for i in 1..n {
                if self.str_at(blob_s, off_s, i - 1).as_bytes() > self.str_at(blob_s, off_s, i).as_bytes() {
                    bail!("{} blob is not sorted at {}", name, i);
                }
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- write

    /// Serialize the parts into an image (the layout above).
    ///
    /// Used by the SQLite fallback in `TripleMaps::load`, and by tests that
    /// compare a sidecar against the SQL-built image. The Python writer in
    /// `kashshaf-data-clean/build_triples_sidecar.py` produces byte-identical
    /// output.
    pub fn build(parts: &ImageParts) -> Result<Self> {
        let p = parts;
        let counts = Counts {
            db_schema_version: p.db_schema_version,
            n_triples: p.triple_lemma.len() as u32,
            n_surfaces: p.surface_sorted.len() as u32,
            n_defs: p.def_to_triple.len() as u32,
            n_lemma_keys: p.lemma_key_ids.len() as u32,
            n_root_keys: p.root_key_ids.len() as u32,
            n_lemma_csr: (p.lemma_csr_offsets.len() - 1) as u32,
            n_root_csr: (p.root_csr_offsets.len() - 1) as u32,
        };
        // Section payload lengths in index order.
        let lens: [usize; N_SECTIONS] = [
            p.triple_surface_pos.len() * 4,
            p.triple_lemma.len() * 4,
            p.triple_root.len() * 4,
            p.surface_sorted.len() * 4,
            p.surface_offsets.len() * 4,
            p.surface_blob.len(),
            p.lemma_csr_offsets.len() * 4,
            p.lemma_csr_values.len() * 4,
            p.root_csr_offsets.len() * 4,
            p.root_csr_values.len() * 4,
            p.def_to_triple.len() * 4,
            p.lemma_key_offsets.len() * 4,
            p.lemma_key_blob.len(),
            p.lemma_key_ids.len() * 4,
            p.root_key_offsets.len() * 4,
            p.root_key_blob.len(),
            p.root_key_ids.len() * 4,
        ];
        let mut offsets = [0usize; N_SECTIONS];
        let mut at = HEADER_SIZE;
        for i in 0..N_SECTIONS {
            offsets[i] = at;
            at += lens[i].next_multiple_of(ALIGN);
        }
        let total = at;

        let mut buf = AlignedBuf::zeroed(total);
        {
            let out = buf.bytes_mut();
            out[..8].copy_from_slice(MAGIC);
            let put32 = |out: &mut [u8], at: usize, v: u32| out[at..at + 4].copy_from_slice(&v.to_le_bytes());
            let put64 = |out: &mut [u8], at: usize, v: u64| out[at..at + 8].copy_from_slice(&v.to_le_bytes());
            put32(out, 8, FORMAT_VERSION);
            put32(out, 12, HEADER_SIZE as u32);
            put32(out, 16, counts.db_schema_version);
            put32(out, 20, counts.n_triples);
            put32(out, 24, counts.n_surfaces);
            put32(out, 28, counts.n_defs);
            put32(out, 32, counts.n_lemma_keys);
            put32(out, 36, counts.n_root_keys);
            put32(out, 40, counts.n_lemma_csr);
            put32(out, 44, counts.n_root_csr);
            put32(out, 48, N_SECTIONS as u32);
            put32(out, 52, 0);
            let cv = p.corpus_version.as_bytes();
            if cv.len() > 32 {
                bail!("corpus_version {:?} does not fit in 32 bytes", p.corpus_version);
            }
            out[56..56 + cv.len()].copy_from_slice(cv);
            for i in 0..N_SECTIONS {
                put64(out, 88 + i * 16, offsets[i] as u64);
                put64(out, 88 + i * 16 + 8, lens[i] as u64);
            }
            let u32_sections: [(usize, &[u32]); 14] = [
                (S_TRIPLE_SURFACE_POS, &p.triple_surface_pos),
                (S_TRIPLE_LEMMA, &p.triple_lemma),
                (S_TRIPLE_ROOT, &p.triple_root),
                (S_SURFACE_SORTED, &p.surface_sorted),
                (S_SURFACE_OFFSETS, &p.surface_offsets),
                (S_LEMMA_CSR_OFFSETS, &p.lemma_csr_offsets),
                (S_LEMMA_CSR_VALUES, &p.lemma_csr_values),
                (S_ROOT_CSR_OFFSETS, &p.root_csr_offsets),
                (S_ROOT_CSR_VALUES, &p.root_csr_values),
                (S_DEF_TO_TRIPLE, &p.def_to_triple),
                (S_LEMMA_KEY_OFFSETS, &p.lemma_key_offsets),
                (S_LEMMA_KEY_IDS, &p.lemma_key_ids),
                (S_ROOT_KEY_OFFSETS, &p.root_key_offsets),
                (S_ROOT_KEY_IDS, &p.root_key_ids),
            ];
            for (s, values) in u32_sections {
                let base = offsets[s];
                if cfg!(target_endian = "little") {
                    // The in-memory form of a `u32` slice already *is* its
                    // little-endian encoding, so the whole section is one copy
                    // instead of 40M four-byte writes.
                    // SAFETY: `u32` has no padding and alignment 4, so the
                    // slice covers `len * 4` initialized bytes.
                    let src = unsafe { std::slice::from_raw_parts(values.as_ptr() as *const u8, values.len() * 4) };
                    out[base..base + src.len()].copy_from_slice(src);
                } else {
                    for (i, v) in values.iter().enumerate() {
                        out[base + i * 4..base + i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                    }
                }
            }
            for (s, blob) in
                [(S_SURFACE_BLOB, &p.surface_blob), (S_LEMMA_KEY_BLOB, &p.lemma_key_blob), (S_ROOT_KEY_BLOB, &p.root_key_blob)]
            {
                out[offsets[s]..offsets[s] + blob.len()].copy_from_slice(blob);
            }
        }
        debug_assert_eq!(buf.byte_capacity() % ALIGN, 0);
        // Structural checks only: this image was just built from `String`s and
        // cumulative lengths, so the sort order holds by construction while
        // bounds, counts and UTF-8 are still verified.
        Self::validate(buf, Check::Structural)
    }
}

/// The arrays that make up an image, in the order the format stores them.
#[derive(Debug, Default)]
pub struct ImageParts {
    pub corpus_version: String,
    pub db_schema_version: u32,
    pub triple_surface_pos: Vec<u32>,
    pub triple_lemma: Vec<u32>,
    pub triple_root: Vec<u32>,
    pub surface_sorted: Vec<u32>,
    pub surface_offsets: Vec<u32>,
    pub surface_blob: Vec<u8>,
    pub lemma_csr_offsets: Vec<u32>,
    pub lemma_csr_values: Vec<u32>,
    pub root_csr_offsets: Vec<u32>,
    pub root_csr_values: Vec<u32>,
    pub def_to_triple: Vec<u32>,
    pub lemma_key_offsets: Vec<u32>,
    pub lemma_key_blob: Vec<u8>,
    pub lemma_key_ids: Vec<u32>,
    pub root_key_offsets: Vec<u32>,
    pub root_key_blob: Vec<u8>,
    pub root_key_ids: Vec<u32>,
}

/// Build CSR arrays for `key -> [values]` from pairs, values ascending within
/// a key (the pairs must arrive with ascending values, as they do when
/// iterating the forward arrays by triple id).
pub fn build_csr(max_key: usize, pairs: impl Iterator<Item = (u32, u32)> + Clone) -> (Vec<u32>, Vec<u32>) {
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
    (offsets, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny but structurally complete image: 2 triples, 2 defs, 2 lemmas,
    /// 1 root.
    pub(crate) fn sample_parts() -> ImageParts {
        // triple 1: surface "ab", lemma 1, root 1; triple 2: surface "aa", lemma 2, root 0
        // sorted surfaces: "aa" (triple 2), "ab" (triple 1)
        let mut p = ImageParts {
            corpus_version: "9.9.9".into(),
            db_schema_version: 4,
            triple_surface_pos: vec![NO_SURFACE, 1, 0],
            triple_lemma: vec![0, 1, 2],
            triple_root: vec![0, 1, 0],
            surface_sorted: vec![2, 1],
            surface_offsets: vec![0, 2, 4],
            surface_blob: b"aaab".to_vec(),
            def_to_triple: vec![0, 1, 2],
            // each Arabic character is 2 bytes: "أب" is 0..4, "أج" is 4..8
            lemma_key_offsets: vec![0, 4, 8],
            lemma_key_blob: "أبأج".as_bytes().to_vec(),
            lemma_key_ids: vec![1, 2],
            root_key_offsets: vec![0, "ق.#.ل".len() as u32],
            root_key_blob: "ق.#.ل".as_bytes().to_vec(),
            root_key_ids: vec![1],
            ..Default::default()
        };
        let (lo, lv) = build_csr(2, p.triple_lemma.iter().enumerate().filter(|(_, &l)| l != 0).map(|(t, &l)| (l, t as u32)));
        p.lemma_csr_offsets = lo;
        p.lemma_csr_values = lv;
        let (ro, rv) = build_csr(1, p.triple_root.iter().enumerate().filter(|(_, &r)| r != 0).map(|(t, &r)| (r, t as u32)));
        p.root_csr_offsets = ro;
        p.root_csr_values = rv;
        p
    }

    #[test]
    fn build_validate_round_trip() {
        let img = Image::build(&sample_parts()).unwrap();
        assert_eq!(img.corpus_version(), "9.9.9");
        assert_eq!(img.counts().n_triples, 3);
        assert_eq!(img.counts().n_surfaces, 2);
        assert_eq!(img.u32s(S_TRIPLE_LEMMA), &[0, 1, 2]);
        assert_eq!(img.str_at(S_SURFACE_BLOB, S_SURFACE_OFFSETS, 0), "aa");
        assert_eq!(img.str_at(S_SURFACE_BLOB, S_SURFACE_OFFSETS, 1), "ab");
        assert_eq!(img.str_at(S_LEMMA_KEY_BLOB, S_LEMMA_KEY_OFFSETS, 0), "أب");
        assert_eq!(img.str_at(S_ROOT_KEY_BLOB, S_ROOT_KEY_OFFSETS, 0), "ق.#.ل");
        // Every section is 8-aligned and the image round-trips through bytes.
        for s in 0..N_SECTIONS {
            assert_eq!(img.sections[s].start % ALIGN, 0, "section {}", s);
        }
        let bytes = img.as_bytes().to_vec();
        let mut buf = AlignedBuf::zeroed(bytes.len());
        buf.bytes_mut().copy_from_slice(&bytes);
        let again = Image::validate(buf, Check::Full).unwrap();
        assert_eq!(again.as_bytes(), img.as_bytes());
    }

    fn image_bytes() -> Vec<u8> {
        Image::build(&sample_parts()).unwrap().as_bytes().to_vec()
    }

    fn validate_bytes(bytes: &[u8]) -> Result<Image> {
        let mut buf = AlignedBuf::zeroed(bytes.len());
        buf.bytes_mut().copy_from_slice(bytes);
        Image::validate(buf, Check::Full)
    }

    #[test]
    fn rejects_bad_magic() {
        let mut b = image_bytes();
        b[0] = b'X';
        let e = validate_bytes(&b).unwrap_err().to_string();
        assert!(e.contains("bad magic"), "{}", e);
    }

    #[test]
    fn rejects_format_version() {
        let mut b = image_bytes();
        b[8..12].copy_from_slice(&99u32.to_le_bytes());
        let e = validate_bytes(&b).unwrap_err().to_string();
        assert!(e.contains("format version 99"), "{}", e);
    }

    #[test]
    fn rejects_truncation() {
        let b = image_bytes();
        // Inside the header, just past it, and one section short of the end:
        // each must be a clean error, never a panic or a usable image.
        for cut in [8, 64, HEADER_SIZE - 8, HEADER_SIZE, HEADER_SIZE + 8, b.len() / 2, b.len() - 8] {
            let e = validate_bytes(&b[..cut]).unwrap_err().to_string();
            assert!(!e.is_empty(), "cut {} was accepted", cut);
        }
        // Past the header the message says what is short.
        let e = validate_bytes(&b[..b.len() - 8]).unwrap_err().to_string();
        assert!(e.contains("truncated") || e.contains("entries"), "{}", e);
    }

    #[test]
    fn rejects_inconsistent_counts() {
        let mut b = image_bytes();
        b[20..24].copy_from_slice(&7u32.to_le_bytes()); // n_triples
        let e = validate_bytes(&b).unwrap_err().to_string();
        assert!(e.contains("header implies 7"), "{}", e);
    }

    #[test]
    fn rejects_unsorted_blobs_from_disk() {
        // `build` trusts its own sort order, so an unsorted blob is caught
        // when the bytes are read back (Check::Full) and by validate_sort_order.
        let mut p = sample_parts();
        p.surface_blob = b"abaa".to_vec(); // "ab" before "aa"
        let built = Image::build(&p).unwrap();
        let e = built.validate_sort_order().unwrap_err().to_string();
        assert!(e.contains("not sorted"), "{}", e);
        let e = validate_bytes(built.as_bytes()).unwrap_err().to_string();
        assert!(e.contains("not sorted"), "{}", e);

        let mut p = sample_parts();
        p.surface_blob = b"ba".to_vec(); // "b" then "a"
        p.surface_offsets = vec![0, 1, 2];
        let e = validate_bytes(Image::build(&p).unwrap().as_bytes()).unwrap_err().to_string();
        assert!(e.contains("not sorted"), "{}", e);
    }

    #[test]
    fn rejects_non_monotonic_csr() {
        let mut p = sample_parts();
        p.lemma_csr_offsets[1] = 99;
        let e = Image::build(&p).unwrap_err().to_string();
        assert!(e.contains("CSR offsets"), "{}", e);
    }

    #[test]
    fn a_well_formed_image_passes_the_sort_check() {
        Image::build(&sample_parts()).unwrap().validate_sort_order().unwrap();
    }

    #[test]
    fn rejects_offsets_past_the_blob() {
        let mut p = sample_parts();
        p.surface_offsets = vec![0, 2, 5]; // blob is 4 bytes
        let e = Image::build(&p).unwrap_err().to_string();
        assert!(e.contains("offsets span"), "{}", e);
    }

    #[test]
    fn rejects_split_multibyte_offset() {
        let mut p = sample_parts();
        // "أبأج" is 8 bytes; cut at 1 splits the first character.
        p.lemma_key_offsets = vec![0, 1, 8]; // 1 is inside the first character
        let e = Image::build(&p).unwrap_err().to_string();
        assert!(e.contains("character boundary") || e.contains("not sorted"), "{}", e);
    }

    #[test]
    fn csr_matches_the_reference_grouping() {
        let pairs = vec![(2u32, 10u32), (1, 11), (2, 12), (5, 13)];
        let (offsets, values) = build_csr(5, pairs.into_iter());
        let get = |k: usize| &values[offsets[k] as usize..offsets[k + 1] as usize];
        assert_eq!(get(2), &[10, 12]);
        assert_eq!(get(1), &[11]);
        assert_eq!(get(5), &[13]);
        assert!(get(3).is_empty());
    }
}
