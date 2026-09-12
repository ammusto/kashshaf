//! Tests that need the full compound index. Gated on `KASHSHAF_FULL_DIR`
//! (a directory holding `corpus.db` schema 4 and `tantivy_index/`); skipped
//! otherwise.
//!
//! ```text
//! KASHSHAF_FULL_DIR="D:/DH Projects/kashshaf-data-clean/data/compound-work" cargo test --release --test full_index -- --nocapture
//! ```

use kashshaf_engine::{EngineConfig, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache, MAX_VERIFIED_HITS};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

fn open() -> Option<SearchEngine> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_FULL_DIR")?);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&db), EngineConfig::default()).expect("open");
    engine.set_token_cache(Arc::new(TokenCache::new(db, 1000).expect("cache")));
    Some(engine)
}

/// The inline allowance (150 ms) lets a walk that reaches its cap quickly
/// answer the first request with the settled count: `الله ~10 root:عرف`
/// verifies 20,000 hits in well under 150 ms on a warm cache, so page 1
/// must already say `20,000+`, `complete = true`, and `get_walk_status`
/// must agree with the cached entry.
#[test]
fn inline_allowance_settles_the_first_page() {
    let Some(engine) = open() else {
        eprintln!("KASHSHAF_FULL_DIR not set: skipped");
        return;
    };
    let t1 = SearchTerm { query: "الله".into(), mode: SearchMode::Surface };
    let t2 = SearchTerm { query: "عرف".into(), mode: SearchMode::Root };
    let filters = SearchFilters::default();
    // Warm the postings once (cold-cache disk reads are not the subject).
    let _ = engine.proximity_search(&t1, &t2, 10, &filters, 250, 0).unwrap();
    engine.wait_walks();
    engine.clear_walk_cache();

    let t0 = Instant::now();
    let r = engine.proximity_search(&t1, &t2, 10, &filters, 250, 0).unwrap();
    let first_ms = t0.elapsed().as_millis();
    eprintln!("first page: {} ms, total_hits={} was_capped={:?} complete={:?}", first_ms, r.total_hits, r.was_capped, r.complete);
    assert_eq!(r.results.len(), 250);
    assert_eq!(r.total_hits, MAX_VERIFIED_HITS, "settled at the cap");
    assert_eq!(r.was_capped, Some(true));
    assert_eq!(r.complete, Some(true));
    let key = r.walk_key.clone().expect("walk key");

    let status = engine.walk_status(&key).expect("status for a cached walk");
    assert!(status.complete);
    assert!(status.was_capped);
    assert!(!status.incomplete);
    assert_eq!(status.verified_hits, r.total_hits);

    // Pages served from the cache agree with the status.
    let p20 = engine.proximity_search(&t1, &t2, 10, &filters, 250, 4750).unwrap();
    assert_eq!(p20.total_hits, status.verified_hits);
    assert_eq!(p20.walk_key.as_deref(), Some(key.as_str()));
    assert_eq!(p20.complete, Some(true));
    assert!(engine.walk_status("no such key").is_none());
}

/// A walk that cannot settle within the allowance (the hybrid wildcard
/// phrase `ابن ال*` takes ~1.5 s to reach the cap) returns early with
/// `complete = false`, and the status endpoint reports its progress until
/// it is done.
#[test]
fn long_walk_reports_progress_through_status() {
    let Some(engine) = open() else {
        eprintln!("KASHSHAF_FULL_DIR not set: skipped");
        return;
    };
    let filters = SearchFilters::default();
    let _ = engine.wildcard_search("ابن ال*", &filters, 250, 0).unwrap();
    engine.wait_walks();
    engine.clear_walk_cache();

    let t0 = Instant::now();
    let r = engine.wildcard_search("ابن ال*", &filters, 250, 0).unwrap();
    let first_ms = t0.elapsed().as_millis();
    let key = r.walk_key.clone().expect("walk key");
    eprintln!("first page: {} ms, total_hits={} complete={:?}", first_ms, r.total_hits, r.complete);
    assert_eq!(r.results.len(), 250);
    assert!(r.total_hits >= 250);
    let s1 = engine.walk_status(&key).unwrap();
    assert!(s1.verified_hits >= r.total_hits);
    engine.wait_walks();
    let s2 = engine.walk_status(&key).unwrap();
    assert!(s2.complete && s2.was_capped && !s2.incomplete, "{:?}", s2);
    assert_eq!(s2.verified_hits, MAX_VERIFIED_HITS);
    let again = engine.wildcard_search("ابن ال*", &filters, 250, 0).unwrap();
    assert_eq!(again.total_hits, MAX_VERIFIED_HITS);
    assert_eq!(again.complete, Some(true));
    assert_eq!(serde_json::to_string(&again.results).unwrap(), serde_json::to_string(&r.results).unwrap(), "rows never change once served");
}

/// The sidecar written for the full corpus must be byte-identical to the
/// image the engine builds from that corpus.db: the sample corpus may not
/// exercise every normalization branch, 3M real surfaces do.
#[test]
fn full_corpus_sidecar_is_byte_identical() {
    let Some(dir) = std::env::var_os("KASHSHAF_FULL_DIR").map(PathBuf::from) else {
        eprintln!("KASHSHAF_FULL_DIR not set: skipped");
        return;
    };
    let sidecar = dir.join(kashshaf_engine::TRIPLES_SIDECAR_NAME);
    if !sidecar.exists() {
        eprintln!("{:?} missing: skipped", sidecar);
        return;
    }
    let conn = rusqlite::Connection::open(dir.join("corpus.db")).unwrap();
    let db_info: Option<(String, i64)> = conn
        .query_row("SELECT corpus_version, schema_version FROM db_info LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let t0 = Instant::now();
    let parts = kashshaf_engine::TripleMaps::parts_from_sqlite(&conn, db_info).expect("parts from sql");
    let built = kashshaf_engine::TripleImage::build(&parts).expect("build");
    built.validate_sort_order().expect("sorted");
    let on_disk = std::fs::read(&sidecar).expect("read sidecar");
    eprintln!("built {} bytes from SQL in {} ms; sidecar is {} bytes", built.as_bytes().len(), t0.elapsed().as_millis(), on_disk.len());
    assert_eq!(built.as_bytes().len(), on_disk.len(), "length differs");
    if built.as_bytes() != on_disk.as_slice() {
        let first = built.as_bytes().iter().zip(&on_disk).position(|(a, b)| a != b).unwrap();
        panic!("full-corpus sidecar differs from the SQL-built image at byte {}", first);
    }
}
