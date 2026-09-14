//! The Qurʾān as Lab data (spec §4.4).
//!
//! Both files are produced by `kashshaf-data-clean/ingest_quran.py` and are
//! compiled into the binary, so Lab needs no download and no corpus for them:
//!
//! - `quran/quran.jsonl.zst` — one line per sūra in the corpus token schema
//!   (`id` 0, `part_index` 0, `page_id` = sūra number, `body` = the āyāt
//!   joined by newlines), read with the same code as a bulk book. The
//!   alignment contract of §3.3 holds on every line (`tests/quran_data.rs`).
//! - `quran/quran.db` — `sura`, `aya(sura, aya, tok_start, tok_end, text,
//!   text_uthmani)` and `db_info`. Token ranges are page-local, end
//!   exclusive: `pages[sura-1].tokens[tok_start..tok_end]` is the āya.
//!
//! Morphology ran on Tanzil's imlāʾī text, not the Uthmani one: after the
//! pipeline's normalisation 17.6% of Uthmani tokens differ from the spelling
//! the corpus quotes in (`مَٰلِكِ` → `ملك`, `ٱلصَّلَوٰةَ` → `الصلوة`) and 363
//! āyāt differ in word count. The Uthmani text is kept for display.
//!
//! The database is embedded as bytes and unpacked into Lab's directory on
//! first use (SQLite wants a file); it is replaced whenever the embedded copy
//! changes size.

use crate::source::{Page, Token};
use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;

const JSONL_ZST: &[u8] = include_bytes!("../quran/quran.jsonl.zst");
const DB: &[u8] = include_bytes!("../quran/quran.db");

/// Book id the Qurʾān lines carry; not a corpus id.
pub const QURAN_BOOK_ID: u64 = 0;

#[derive(Debug, Clone, Serialize)]
pub struct Sura {
    pub sura: u32,
    pub name: String,
    pub tname: String,
    pub revelation: String,
    pub ayas: u32,
    pub tokens: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Aya {
    pub sura: u32,
    pub aya: u32,
    /// Page-local token range in the sūra's line, end exclusive.
    pub tok_start: usize,
    pub tok_end: usize,
}

#[derive(Deserialize)]
struct Line {
    page_id: u64,
    part_label: String,
    page_number: String,
    body: String,
    tokens: Vec<Token>,
}

pub struct QuranText {
    /// Index `sura - 1`.
    pub pages: Vec<Page>,
    pub suras: Vec<Sura>,
    /// In muṣḥaf order.
    pub ayas: Vec<Aya>,
    pub info: BTreeMap<String, String>,
    /// Where the unpacked `quran.db` lives, for the display-text queries.
    db_path: std::path::PathBuf,
}

impl QuranText {
    /// Decode the embedded text and unpack the database into `dir`.
    pub fn load(dir: &Path) -> Result<Self> {
        let pages = decode_pages()?;
        let db_path = dir.join("quran.db");
        unpack_db(&db_path)?;
        let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening {}", db_path.display()))?;

        let mut info = BTreeMap::new();
        let mut st = conn.prepare("SELECT key, value FROM db_info")?;
        for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (k, v) = row?;
            info.insert(k, v);
        }

        let mut st = conn.prepare("SELECT sura, name, tname, revelation, ayas, tok_end FROM sura ORDER BY sura")?;
        let suras = st
            .query_map([], |r| {
                Ok(Sura {
                    sura: r.get(0)?,
                    name: r.get(1)?,
                    tname: r.get(2)?,
                    revelation: r.get(3)?,
                    ayas: r.get(4)?,
                    tokens: r.get::<_, i64>(5)? as usize,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let mut st = conn.prepare("SELECT sura, aya, tok_start, tok_end FROM aya ORDER BY sura, aya")?;
        let ayas = st
            .query_map([], |r| {
                Ok(Aya {
                    sura: r.get(0)?,
                    aya: r.get(1)?,
                    tok_start: r.get::<_, i64>(2)? as usize,
                    tok_end: r.get::<_, i64>(3)? as usize,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        if pages.len() != 114 || suras.len() != 114 {
            return Err(anyhow!("the embedded Qurʾān has {} pages and {} sūras; expected 114", pages.len(), suras.len()));
        }
        for (p, s) in pages.iter().zip(&suras) {
            if p.page_id != s.sura as u64 || p.tokens.len() != s.tokens {
                return Err(anyhow!("sūra {}: text and database disagree ({} vs {} tokens)", s.sura, p.tokens.len(), s.tokens));
            }
        }
        Ok(Self { pages, suras, ayas, info, db_path })
    }

    pub fn page(&self, sura: u32) -> Option<&Page> {
        self.pages.get(sura.checked_sub(1)? as usize)
    }

    pub fn sura(&self, sura: u32) -> Option<&Sura> {
        self.suras.get(sura.checked_sub(1)? as usize)
    }

    /// The āya containing token `idx` of sūra `sura`.
    pub fn aya_at(&self, sura: u32, idx: usize) -> Option<&Aya> {
        let start = self.ayas.partition_point(|a| a.sura < sura);
        let end = self.ayas.partition_point(|a| a.sura <= sura);
        let range = &self.ayas[start..end];
        let i = range.partition_point(|a| a.tok_end <= idx);
        range.get(i).filter(|a| a.tok_start <= idx && idx < a.tok_end)
    }

    pub fn aya(&self, sura: u32, aya: u32) -> Option<&Aya> {
        let start = self.ayas.partition_point(|a| a.sura < sura);
        self.ayas[start..].iter().take_while(|a| a.sura == sura).find(|a| a.aya == aya)
    }

    /// Tokens of one āya.
    pub fn aya_tokens(&self, a: &Aya) -> &[Token] {
        &self.pages[a.sura as usize - 1].tokens[a.tok_start..a.tok_end]
    }

    pub fn token_count(&self) -> usize {
        self.pages.iter().map(|p| p.tokens.len()).sum()
    }

    /// Display texts of an āya: `(imlāʾī with tashkil, Uthmani)`.
    pub fn aya_text(&self, sura: u32, aya: u32) -> Result<(String, String)> {
        let conn = Connection::open_with_flags(&self.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.query_row(
            "SELECT text, text_uthmani FROM aya WHERE sura = ?1 AND aya = ?2",
            rusqlite::params![sura, aya],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .with_context(|| format!("āya {}:{}", sura, aya))
    }
}

fn decode_pages() -> Result<Vec<Page>> {
    let ndjson = zstd::decode_all(JSONL_ZST).context("decompressing the embedded Qurʾān")?;
    let mut pages = Vec::with_capacity(114);
    for (i, line) in ndjson.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let l: Line = serde_json::from_str(&line).with_context(|| format!("quran.jsonl line {}", i + 1))?;
        pages.push(Page {
            book_id: QURAN_BOOK_ID,
            part_index: 0,
            page_id: l.page_id,
            part_label: l.part_label,
            page_number: l.page_number,
            body: l.body,
            tokens: l.tokens,
        });
    }
    Ok(pages)
}

fn unpack_db(path: &Path) -> Result<()> {
    let current = std::fs::metadata(path).map(|m| m.len() == DB.len() as u64).unwrap_or(false);
    if current {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("db.tmp");
    std::fs::write(&tmp, DB).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}
