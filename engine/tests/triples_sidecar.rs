//! `triples.bin` against `corpus.db`: the sidecar must be byte-identical to
//! the image the engine builds from SQL, every lookup must agree, a corrupt
//! or stale sidecar must fall back cleanly, and a search must return the same
//! hits either way.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` (a directory with `corpus.db` schema 4,
//! `tantivy_index_compound_root/`, and `triples.bin` written by
//! `kashshaf-data-clean/build_triples_sidecar.py`); skipped without it.
//!
//! ```text
//! python build_triples_sidecar.py --data-dir data/sample-mini --check
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
//!     cargo test --release --test triples_sidecar -- --nocapture
//! ```

use kashshaf_engine::triples_image::{Image, SIDECAR_NAME};
use kashshaf_engine::{
    EngineConfig, SearchEngine, SearchFilters, SearchMode, SearchResults, SearchTerm, TokenCache, TripleMaps,
    TripleSource,
};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn sample_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    if !dir.join(SIDECAR_NAME).exists() {
        eprintln!(
            "{:?} has no {}: run `python build_triples_sidecar.py --data-dir <dir>` first; skipped",
            dir, SIDECAR_NAME
        );
        return None;
    }
    Some(dir)
}

/// A scratch copy of `corpus.db`, so a test can add, remove or corrupt the
/// sidecar beside it without touching the shared sample directory.
struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str, sample: &Path) -> Self {
        let dir = std::env::temp_dir().join(format!("kashshaf-sidecar-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::copy(sample.join("corpus.db"), dir.join("corpus.db")).expect("copy corpus.db");
        Self { dir }
    }

    fn corpus_db(&self) -> PathBuf {
        self.dir.join("corpus.db")
    }

    fn sidecar(&self) -> PathBuf {
        self.dir.join(SIDECAR_NAME)
    }

    /// Put the good sidecar in place, optionally mutated first.
    fn place_sidecar(&self, sample: &Path, mutate: impl FnOnce(&mut Vec<u8>)) {
        let mut bytes = std::fs::read(sample.join(SIDECAR_NAME)).expect("read sidecar");
        mutate(&mut bytes);
        std::fs::write(self.sidecar(), &bytes).expect("write sidecar");
    }

    fn remove_sidecar(&self) {
        let _ = std::fs::remove_file(self.sidecar());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn load(corpus_db: &Path) -> TripleMaps {
    TripleMaps::load(corpus_db).expect("load triple maps").expect("schema 4 corpus has triples")
}

/// The sidecar on disk must equal the image the engine builds from SQL, byte
/// for byte. That single assertion covers the normalization table, the sort
/// order, the CSR grouping, the header and every offset at once: if the bytes
/// match, no lookup can differ.
#[test]
fn sidecar_is_byte_identical_to_the_sql_image() {
    let Some(sample) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let conn = Connection::open(sample.join("corpus.db")).unwrap();
    let db_info: Option<(String, i64)> = conn
        .query_row("SELECT corpus_version, schema_version FROM db_info LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let parts = TripleMaps::parts_from_sqlite(&conn, db_info).expect("build parts from sql");
    let built = Image::build(&parts).expect("build image");
    // `build` trusts its own sort order; hold it to the full check here.
    built.validate_sort_order().expect("SQL-built image is sorted");
    let on_disk = std::fs::read(sample.join(SIDECAR_NAME)).expect("read sidecar");

    assert_eq!(
        built.as_bytes().len(),
        on_disk.len(),
        "sidecar is {} bytes, the SQL-built image is {}",
        on_disk.len(),
        built.as_bytes().len()
    );
    if built.as_bytes() != on_disk.as_slice() {
        let first = built.as_bytes().iter().zip(&on_disk).position(|(a, b)| a != b).unwrap();
        panic!(
            "sidecar differs from the SQL-built image at byte {} (of {}): \
             build_triples_sidecar.py has drifted from triples_image.rs",
            first,
            on_disk.len()
        );
    }
    eprintln!("byte-identical: {} bytes, corpus {}", on_disk.len(), built.corpus_version());
}

/// Every lookup must return the same thing from the sidecar and from SQL.
#[test]
fn every_lookup_agrees_between_sidecar_and_sqlite() {
    let Some(sample) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let fx = Fixture::new("lookups", &sample);

    fx.remove_sidecar();
    let sql = load(&fx.corpus_db());
    assert_eq!(sql.source(), TripleSource::Sqlite, "no sidecar means the SQL path");

    fx.place_sidecar(&sample, |_| {});
    let side = load(&fx.corpus_db());
    assert_eq!(side.source(), TripleSource::Sidecar, "the sidecar should have been used");

    assert_eq!(side.triple_count(), sql.triple_count());
    assert_eq!(side.approx_bytes(), sql.approx_bytes());
    let n = sql.triple_count();
    assert!(n > 1000, "sample has only {} triples", n);

    // Forward arrays over the whole id space, plus a margin past the end.
    let max_probe = (n as u32) + 64;
    let mut surfaces = Vec::with_capacity(n);
    for t in 0..max_probe {
        assert_eq!(side.lemma_of_triple(t), sql.lemma_of_triple(t), "lemma_of_triple({})", t);
        assert_eq!(side.root_of_triple(t), sql.root_of_triple(t), "root_of_triple({})", t);
        assert_eq!(side.surface_of_triple(t), sql.surface_of_triple(t), "surface_of_triple({})", t);
        if let Some(s) = sql.surface_of_triple(t) {
            surfaces.push(s.to_string());
        }
    }
    assert_eq!(surfaces.len(), n, "every triple in the table has a surface");

    // def -> triple over the whole id space.
    let mut defs = 0usize;
    for d in 0..200_000u32 {
        let a = side.triple_of_def(d);
        assert_eq!(a, sql.triple_of_def(d), "triple_of_def({})", d);
        if a != 0 {
            defs += 1;
        }
    }
    assert!(defs > 1000, "only {} definitions mapped", defs);

    // surface -> triples for every distinct surface in the corpus, and the
    // surface-sorted order itself (through the wildcard scan, which walks it).
    surfaces.sort();
    surfaces.dedup();
    for s in &surfaces {
        assert_eq!(side.triples_for_surface(s), sql.triples_for_surface(s), "triples_for_surface({:?})", s);
    }
    assert!(side.triples_for_surface("ﷺﷺ-not-a-surface").is_empty());
    let all = kashshaf_engine::glob::GlobPattern::parse("*");
    let order_side = side.triples_for_glob(&all);
    let order_sql = sql.triples_for_glob(&all);
    assert_eq!(order_side.len(), n, "the full scan visits every triple");
    assert_eq!(order_side, order_sql, "surface-sorted order differs");

    // lemma / root -> triples for every key in the tables.
    let conn = Connection::open(fx.corpus_db()).unwrap();
    let mut keys = 0usize;
    for (table, column) in [("lemmas", "lemma"), ("roots", "root")] {
        let mut stmt = conn.prepare(&format!("SELECT {} FROM {}", column, table)).unwrap();
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert!(!rows.is_empty());
        for key in &rows {
            let (a, b) = if table == "lemmas" {
                (side.triples_for_lemma(key), sql.triples_for_lemma(key))
            } else {
                (side.triples_for_root(key), sql.triples_for_root(key))
            };
            assert_eq!(a, b, "{} {:?}", column, key);
            keys += 1;
        }
        // A key that is not in the table.
        assert!(side.triples_for_lemma("\u{0}no-such-key").is_empty());
        assert!(side.triples_for_root("\u{0}no-such-key").is_empty());
    }
    eprintln!(
        "parity over {} triples, {} definitions, {} distinct surfaces, {} lemma/root keys",
        n,
        defs,
        surfaces.len(),
        keys
    );
}

/// A truncated, mis-magicked, wrong-version or stale sidecar must be ignored
/// with a warning, not panic and not serve wrong data.
#[test]
fn corrupt_or_stale_sidecars_fall_back_to_sqlite() {
    let Some(sample) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let fx = Fixture::new("corrupt", &sample);
    fx.remove_sidecar();
    let sql = load(&fx.corpus_db());
    let probe_surface = sql.surface_of_triple(1).expect("triple 1 has a surface").to_string();
    let expect = sql.triples_for_surface(&probe_surface);
    let expect_count = sql.triple_count();

    let cases: Vec<(&str, Box<dyn FnOnce(&mut Vec<u8>)>)> = vec![
        ("bad magic", Box::new(|b: &mut Vec<u8>| b[0] = b'X')),
        ("format version", Box::new(|b: &mut Vec<u8>| b[8..12].copy_from_slice(&7u32.to_le_bytes()))),
        ("truncated mid-section", Box::new(|b: &mut Vec<u8>| b.truncate(b.len() / 2))),
        ("truncated to a stub", Box::new(|b: &mut Vec<u8>| b.truncate(64))),
        ("empty file", Box::new(|b: &mut Vec<u8>| b.clear())),
        (
            "corpus_version mismatch",
            Box::new(|b: &mut Vec<u8>| {
                b[56..88].fill(0);
                b[56..61].copy_from_slice(b"9.9.9");
            }),
        ),
        ("db_schema_version mismatch", Box::new(|b: &mut Vec<u8>| b[16..20].copy_from_slice(&3u32.to_le_bytes()))),
        (
            "section offset past the end",
            Box::new(|b: &mut Vec<u8>| b[88..96].copy_from_slice(&(u32::MAX as u64).to_le_bytes())),
        ),
        ("count does not match the section", Box::new(|b: &mut Vec<u8>| b[20..24].copy_from_slice(&5u32.to_le_bytes()))),
    ];

    for (name, mutate) in cases {
        fx.place_sidecar(&sample, mutate);
        let m = TripleMaps::load(&fx.corpus_db())
            .unwrap_or_else(|e| panic!("{}: load failed instead of falling back: {}", name, e))
            .unwrap_or_else(|| panic!("{}: load returned None", name));
        assert_eq!(m.source(), TripleSource::Sqlite, "{}: should have fallen back", name);
        assert_eq!(m.triple_count(), expect_count, "{}: wrong triple count after fallback", name);
        assert_eq!(m.triples_for_surface(&probe_surface), expect, "{}: wrong lookup after fallback", name);
        eprintln!("{:34} -> fell back to corpus.db", name);
    }

    // And the unmodified sidecar is still accepted after all that.
    fx.place_sidecar(&sample, |_| {});
    assert_eq!(load(&fx.corpus_db()).source(), TripleSource::Sidecar);
}

fn keys_of(r: &SearchResults) -> Vec<(u64, u64, u64, Vec<u32>)> {
    r.results.iter().map(|x| (x.id, x.part_index, x.page_id, x.matched_token_indices.clone())).collect()
}

/// The same searches must return the same hits whichever way the maps loaded.
#[test]
fn searches_return_the_same_hits_either_way() {
    let Some(sample) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let index = sample.join("tantivy_index_compound_root");
    if !index.is_dir() {
        eprintln!("{:?} missing: skipped", index);
        return;
    }
    let fx = Fixture::new("search", &sample);

    let open = |db: &Path| {
        let mut e = SearchEngine::open_with_corpus(&index, Some(db), EngineConfig { exact_counts: true, ..EngineConfig::default() })
            .expect("open engine");
        e.set_token_cache(Arc::new(TokenCache::new(db.to_path_buf(), 1000).expect("token cache")));
        e
    };

    fx.remove_sidecar();
    let sql = open(&fx.corpus_db());
    fx.place_sidecar(&sample, |_| {});
    let side = open(&fx.corpus_db());
    assert_eq!(sql.triple_maps().unwrap().source(), TripleSource::Sqlite);
    assert_eq!(side.triple_maps().unwrap().source(), TripleSource::Sidecar);

    let f = SearchFilters::default();
    let mut compared = 0usize;
    for (mode, query) in [
        (SearchMode::Surface, "الكتاب"),
        (SearchMode::Lemma, "كتاب"),
        (SearchMode::Lemma, "قال"),
        (SearchMode::Root, "علم"),
        (SearchMode::Root, "قول"),
        (SearchMode::Surface, "رسول الله"),
        (SearchMode::Lemma, "قال رسول"),
    ] {
        let a = sql.search(query, mode, &f, 50, 0).expect("sql search");
        let b = side.search(query, mode, &f, 50, 0).expect("sidecar search");
        assert_eq!(a.total_hits, b.total_hits, "{:?} {:?}: total_hits", mode, query);
        assert_eq!(keys_of(&a), keys_of(&b), "{:?} {:?}: rows or highlights", mode, query);
        assert!(a.total_hits > 0, "{:?} {:?} found nothing in the sample", mode, query);
        compared += 1;
    }
    for query in ["أب*", "*ية", "مع*رف*", "ابن ال*", "م*رف"] {
        let a = sql.wildcard_search(query, &f, 50, 0).expect("sql wildcard");
        let b = side.wildcard_search(query, &f, 50, 0).expect("sidecar wildcard");
        assert_eq!(a.total_hits, b.total_hits, "wildcard {:?}: total_hits", query);
        assert_eq!(keys_of(&a), keys_of(&b), "wildcard {:?}: rows or highlights", query);
        compared += 1;
    }
    let t1 = SearchTerm { query: "الله".into(), mode: SearchMode::Surface };
    let t2 = SearchTerm { query: "قال".into(), mode: SearchMode::Lemma };
    let a = sql.proximity_search(&t1, &t2, 10, &f, 50, 0).expect("sql proximity");
    let b = side.proximity_search(&t1, &t2, 10, &f, 50, 0).expect("sidecar proximity");
    assert_eq!(a.total_hits, b.total_hits, "proximity total_hits");
    assert_eq!(keys_of(&a), keys_of(&b), "proximity rows");
    compared += 1;

    let variants_sql = kashshaf_engine::compute_variants(&sql, sql.token_cache().unwrap(), "كتاب", SearchMode::Lemma, &f)
        .expect("sql variants");
    let variants_side =
        kashshaf_engine::compute_variants(&side, side.token_cache().unwrap(), "كتاب", SearchMode::Lemma, &f)
            .expect("sidecar variants");
    assert_eq!(variants_sql.total_hits, variants_side.total_hits, "variants total_hits");
    assert_eq!(
        variants_sql.variants.iter().map(|v| (v.surface_tuple.clone(), v.freq)).collect::<Vec<_>>(),
        variants_side.variants.iter().map(|v| (v.surface_tuple.clone(), v.freq)).collect::<Vec<_>>(),
        "variants"
    );
    compared += 1;

    eprintln!("{} searches identical between the sidecar and corpus.db", compared);
}
