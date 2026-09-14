//! The frequency snapshot (Lab spec §3.4): the Python writer in
//! `kashshaf-data-clean/build_lab_freq.py` and the Rust builder in
//! `source::freq::build_from_corpus` must produce the same bytes, and what
//! they produce must be what the reader reads back.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`. The Python tables are looked for in
//! `KASHSHAF_FREQ_DIR`, else beside `corpus.db`:
//!
//! ```text
//! python build_lab_freq.py --corpus-db <sample>/corpus.db --out-dir <dir>
//! KASHSHAF_SAMPLE_DIR=<sample> KASHSHAF_FREQ_DIR=<dir> \
//!     cargo test -p kashshaf-lab --release --test freq_snapshot
//! ```

use kashshaf_engine::TokenCache;
use kashshaf_lab_lib::source::freq::{build_from_corpus, FreqLayer, FreqTable};
use std::path::PathBuf;

fn sample_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from)
}

fn freq_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_FREQ_DIR").map(PathBuf::from).or_else(sample_dir)
}

/// Every book with pages, from `page_tokens` itself.
fn book_ids(db: &std::path::Path) -> Vec<u64> {
    let conn = rusqlite::Connection::open(db).expect("open corpus.db");
    let mut stmt = conn.prepare("SELECT DISTINCT book_id FROM page_tokens ORDER BY book_id").expect("prepare");
    stmt.query_map([], |r| r.get::<_, i64>(0)).expect("query").filter_map(|r| r.ok()).map(|i| i as u64).collect()
}

fn corpus_version(db: &std::path::Path) -> String {
    kashshaf_engine::read_db_info(db).expect("db_info").expect("schema >= 3").corpus_version
}

fn build() -> Option<(FreqTable, FreqTable)> {
    let dir = sample_dir()?;
    let db = dir.join("corpus.db");
    let cache = TokenCache::new(db.clone(), 100).expect("open the sample corpus.db");
    let ids = book_ids(&db);
    assert!(!ids.is_empty());
    let built = build_from_corpus(&cache, &ids, &corpus_version(&db), &|_, _| {}, &|| false)
        .expect("build")
        .expect("not cancelled");
    Some(built)
}

#[test]
fn the_rust_builder_matches_the_python_writer_byte_for_byte() {
    let Some((lemma, root)) = build() else { return };
    let Some(fdir) = freq_dir() else { return };
    for t in [&lemma, &root] {
        let path = fdir.join(t.layer.file_name());
        if !path.exists() {
            eprintln!("{} not found; run build_lab_freq.py first. Skipped.", path.display());
            return;
        }
        let python = std::fs::read(&path).expect("read the Python table");
        let mut rust = Vec::new();
        t.write_to(&mut rust).expect("write");
        assert_eq!(rust.len(), python.len(), "{}: sizes differ", path.display());
        assert!(rust == python, "{}: bytes differ", path.display());
        eprintln!("[freq] {} byte-identical ({} bytes, {} keys)", path.display(), rust.len(), t.len());
    }
}

#[test]
fn the_tables_agree_with_the_token_stream() {
    let Some((lemma, root)) = build() else { return };
    let dir = sample_dir().unwrap();
    let cache = TokenCache::new(dir.join("corpus.db"), 100).expect("open");
    // Recount one book by hand through the per-page path and compare the
    // sum of its lemma counts with the table's total contribution... the
    // simplest invariant: the table's total equals the number of tokens.
    let mut tokens = 0u64;
    let mut rooted = 0u64;
    for id in book_ids(&dir.join("corpus.db")) {
        for (_, _, ids) in cache.book_pages(id).expect("book_pages") {
            let resolved = cache.resolve_pages(&[ids]).expect("resolve");
            for t in &resolved[0] {
                tokens += 1;
                if t.root.is_some() {
                    rooted += 1;
                }
            }
        }
    }
    assert_eq!(lemma.total, tokens, "the lemma table counts every token");
    assert_eq!(root.total, rooted, "the root table counts every rooted token");
    assert_eq!(lemma.layer, FreqLayer::Lemma);
    assert_eq!(root.layer, FreqLayer::Root);
    // A few of the most frequent function words must be present and ranked.
    let fi = lemma.get("في");
    assert!(fi.count > 0 && fi.rank.map(|r| r <= 5).unwrap_or(false), "في should rank in the top 5: {:?}", fi);
}

#[test]
fn a_written_table_reads_back_identically() {
    let Some((lemma, _)) = build() else { return };
    let tmp = std::env::temp_dir().join(format!("kashshaf-lab-freq-{}.bin", std::process::id()));
    lemma.write(&tmp).expect("write");
    let back = FreqTable::read(&tmp).expect("read");
    assert_eq!(back.total, lemma.total);
    assert_eq!(back.len(), lemma.len());
    assert_eq!(back.corpus_version, lemma.corpus_version);
    assert_eq!(back.get("قول"), lemma.get("قول"));
    let _ = std::fs::remove_file(&tmp);
}
