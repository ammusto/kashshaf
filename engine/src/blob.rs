//! `page_tokens.token_ids` blob codec.
//!
//! Two encodings exist (column `page_tokens.encoding`, absent on pre-v3
//! databases where everything is encoding 1):
//!
//! * **1** — little-endian `u32` per token, no header.
//! * **2** — `varint(n_tokens)` (unsigned LEB128) followed by one standard
//!   zstd frame (magic present; no checksum, content size or dictionary id)
//!   compressed with the dictionary stored in `token_codec['zstd_dict']`.
//!   The decompressed payload is `n_tokens` unsigned LEB128 varints, each a
//!   *rank*; `token_definitions.id = rank_to_def[rank]` where
//!   `token_codec['rank_to_def']` is a `u32` LE array.
//!
//! The layout is fixed by `kashshaf-data-clean/build_sqlite_tokens.py`
//! (`--recompress`) and test vectors live in its `fixtures/` output.

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{Connection, OptionalExtension};
use zstd::dict::DecoderDictionary;

pub const ENCODING_RAW_U32: i64 = 1;
pub const ENCODING_RANK_VARINT_ZSTD: i64 = 2;

/// Decoder state for encoding 2. Cheap to share: the dictionary is prepared
/// once; a zstd decompression context is created per call (microseconds).
pub struct BlobCodec {
    rank_to_def: Vec<u32>,
    dict: DecoderDictionary<'static>,
    dict_bytes: Vec<u8>,
}

impl BlobCodec {
    pub fn new(rank_to_def: Vec<u32>, dict_bytes: &[u8]) -> Self {
        Self {
            rank_to_def,
            dict: DecoderDictionary::copy(dict_bytes),
            dict_bytes: dict_bytes.to_vec(),
        }
    }

    /// Load from `token_codec` if the table and both rows exist.
    pub fn load(conn: &Connection) -> Result<Option<Self>> {
        let has_table: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='token_codec'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_table {
            return Ok(None);
        }
        let rank_blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT data FROM token_codec WHERE key='rank_to_def'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let dict_blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT data FROM token_codec WHERE key='zstd_dict'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match (rank_blob, dict_blob) {
            (Some(r), Some(d)) => {
                if r.len() % 4 != 0 {
                    bail!("token_codec.rank_to_def length {} is not a multiple of 4", r.len());
                }
                let rank_to_def: Vec<u32> = r
                    .chunks_exact(4)
                    .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                Ok(Some(Self::new(rank_to_def, &d)))
            }
            _ => Ok(None),
        }
    }

    pub fn rank_count(&self) -> usize {
        self.rank_to_def.len()
    }

    /// Raw dictionary bytes (for benchmarks that rebuild the dictionary per call).
    pub fn dict_bytes(&self) -> Vec<u8> {
        self.dict_bytes.clone()
    }

    /// Decode with a dictionary digested **per call** — the anti-pattern the
    /// audit checks for. Only for the `--micro` benchmark.
    pub fn decode_v2_unprepared(&self, blob: &[u8]) -> Result<Vec<u32>> {
        let (n, pos) = read_leb128(blob, 0)?;
        let n = n as usize;
        if n == 0 {
            return Ok(Vec::new());
        }
        let dict = DecoderDictionary::copy(&self.dict_bytes);
        let mut dec = zstd::bulk::Decompressor::with_prepared_dictionary(&dict)?;
        let payload = dec.decompress(&blob[pos..], n * 5)?;
        let mut out = Vec::with_capacity(n);
        let mut p = 0usize;
        for _ in 0..n {
            let (rank, next) = read_leb128(&payload, p)?;
            p = next;
            out.push(*self.rank_to_def.get(rank as usize).ok_or_else(|| anyhow!("rank out of range"))?);
        }
        Ok(out)
    }

    /// Number of tokens in an encoding-2 blob without decompressing it.
    pub fn token_count_v2(blob: &[u8]) -> Result<usize> {
        let (n, _) = read_leb128(blob, 0)?;
        Ok(n as usize)
    }

    /// Decode an encoding-2 blob to `token_definitions.id`s.
    pub fn decode_v2(&self, blob: &[u8]) -> Result<Vec<u32>> {
        let (n, pos) = read_leb128(blob, 0)?;
        let n = n as usize;
        if n == 0 {
            return Ok(Vec::new());
        }
        // Each rank varint is at most 5 bytes.
        let capacity = n.checked_mul(5).ok_or_else(|| anyhow!("token count overflow"))?;
        let mut dec = zstd::bulk::Decompressor::with_prepared_dictionary(&self.dict)
            .context("zstd decompressor init")?;
        let payload = dec
            .decompress(&blob[pos..], capacity)
            .context("zstd decompress of page blob")?;

        let mut out = Vec::with_capacity(n);
        let mut p = 0usize;
        for _ in 0..n {
            let (rank, next) = read_leb128(&payload, p)?;
            p = next;
            let def = *self
                .rank_to_def
                .get(rank as usize)
                .ok_or_else(|| anyhow!("rank {} outside rank_to_def ({} entries)", rank, self.rank_to_def.len()))?;
            out.push(def);
        }
        if p != payload.len() {
            bail!("trailing bytes after {} varints in page blob", n);
        }
        Ok(out)
    }
}

/// Decode encoding 1 (raw little-endian u32). Trailing partial bytes are an error.
pub fn decode_raw_u32(blob: &[u8]) -> Result<Vec<u32>> {
    if blob.len() % 4 != 0 {
        bail!("raw blob length {} is not a multiple of 4", blob.len());
    }
    Ok(blob
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Decode any supported encoding.
pub fn decode_blob(encoding: i64, blob: &[u8], codec: Option<&BlobCodec>) -> Result<Vec<u32>> {
    match encoding {
        ENCODING_RAW_U32 => decode_raw_u32(blob),
        ENCODING_RANK_VARINT_ZSTD => match codec {
            Some(c) => c.decode_v2(blob),
            None => bail!("page blob uses encoding 2 but corpus.db has no token_codec"),
        },
        other => bail!("unknown page_tokens encoding {}", other),
    }
}

/// Token count for any supported encoding without a full decode.
pub fn blob_token_count(encoding: i64, blob: &[u8]) -> Result<usize> {
    match encoding {
        ENCODING_RAW_U32 => Ok(blob.len() / 4),
        ENCODING_RANK_VARINT_ZSTD => BlobCodec::token_count_v2(blob),
        other => bail!("unknown page_tokens encoding {}", other),
    }
}

/// Read one unsigned LEB128 value. Returns `(value, next_pos)`.
pub fn read_leb128(buf: &[u8], mut pos: usize) -> Result<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *buf
            .get(pos)
            .ok_or_else(|| anyhow!("truncated varint at byte {}", pos))?;
        pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok((result, pos));
        }
        shift += 7;
        if shift > 63 {
            bail!("varint too long");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leb(mut n: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (n & 0x7F) as u8;
            n >>= 7;
            if n == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    #[test]
    fn leb128_roundtrip() {
        for n in [0u64, 1, 127, 128, 16383, 16384, 1 << 21, (1 << 28) - 1, 1 << 28, u32::MAX as u64] {
            let enc = leb(n);
            let (dec, pos) = read_leb128(&enc, 0).unwrap();
            assert_eq!(dec, n);
            assert_eq!(pos, enc.len());
        }
        assert!(read_leb128(&[0x80], 0).is_err());
    }

    #[test]
    fn raw_decode_rejects_partial() {
        assert_eq!(decode_raw_u32(&[1, 0, 0, 0, 2, 0, 0, 0]).unwrap(), vec![1, 2]);
        assert!(decode_raw_u32(&[1, 0, 0]).is_err());
    }

    #[test]
    fn v2_roundtrip_with_dictionary() {
        // rank_to_def: rank 0 -> def 42, rank 1 -> def 7, rank 2 -> def 1000
        let rank_to_def = vec![42u32, 7, 1000];
        // Train nothing: an arbitrary byte string is a valid raw-content dictionary.
        let dict_bytes: Vec<u8> = (0..64u8).collect();
        let codec = BlobCodec::new(rank_to_def, &dict_bytes);

        let ranks = [0u64, 1, 2, 1, 0, 300 % 3];
        let mut payload = Vec::new();
        for r in ranks {
            payload.extend(leb(r));
        }
        let cdict = zstd::dict::EncoderDictionary::copy(&dict_bytes, 3);
        let mut enc = zstd::bulk::Compressor::with_prepared_dictionary(&cdict).unwrap();
        enc.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(false)).unwrap();
        enc.set_parameter(zstd::zstd_safe::CParameter::ContentSizeFlag(false)).unwrap();
        enc.set_parameter(zstd::zstd_safe::CParameter::DictIdFlag(false)).unwrap();
        let frame = enc.compress(&payload).unwrap();
        let mut blob = leb(ranks.len() as u64);
        blob.extend(frame);

        assert_eq!(BlobCodec::token_count_v2(&blob).unwrap(), ranks.len());
        assert_eq!(codec.decode_v2(&blob).unwrap(), vec![42, 7, 1000, 7, 42, 42]);
        assert_eq!(
            decode_blob(ENCODING_RANK_VARINT_ZSTD, &blob, Some(&codec)).unwrap().len(),
            ranks.len()
        );
        assert!(decode_blob(ENCODING_RANK_VARINT_ZSTD, &blob, None).is_err());
        assert!(decode_blob(9, &blob, Some(&codec)).is_err());

        // Empty page
        let empty = leb(0);
        assert_eq!(codec.decode_v2(&empty).unwrap(), Vec::<u32>::new());
    }
}
