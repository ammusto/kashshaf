//! The death years the reading-order key uses come from `metadata.db`, not
//! from the index. On the sample corpus, whose index still carries a
//! `death_ah` column, the two sources must agree text for text, and an
//! engine opened beside that `metadata.db` must still find its single
//! segment in reading order.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`.

use kashshaf_engine::search::{EngineConfig, SearchEngine, SearchMode};
use kashshaf_engine::{Deaths, NO_DEATH};
use std::path::PathBuf;

fn sample_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from).filter(|p| p.join("metadata.db").is_file())
}

#[test]
fn metadata_and_the_old_column_agree() {
    let Some(dir) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set; skipping");
        return;
    };
    let from_metadata = Deaths::load(&dir.join("metadata.db")).unwrap();
    let from_index = Deaths::from_index_dir(&dir.join("tantivy_index_compound_root")).unwrap();
    assert!(!from_index.is_empty(), "the sample index has no death_ah column to compare with");
    for (text, death) in from_index.iter() {
        assert_eq!(from_metadata.of(text), death, "text {} has death {} in the index", text, death);
    }
    // And a text the index knows without a year has none in the metadata either.
    assert_eq!(from_metadata.of(u64::MAX - 1), NO_DEATH);
}

#[test]
fn an_engine_beside_metadata_is_in_reading_order() {
    let Some(dir) = sample_dir() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set; skipping");
        return;
    };
    let db = dir.join("corpus.db");
    let config = EngineConfig { verify_reading_order: true, ..EngineConfig::default() };
    let engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), config).unwrap();
    // The boundary index only opens over a main index verified to be in reading order.
    assert!(engine.capabilities().boundary_index, "reading order not verified with death years from metadata.db");

    // Results page in reading order: death year ascending, texts without one last.
    let deaths = Deaths::load(&dir.join("metadata.db")).unwrap();
    let r = engine.search("الله", SearchMode::Surface, &Default::default(), 200, 0).unwrap();
    let keys: Vec<(u64, u64, u64, u64)> = r.results.iter().map(|x| (deaths.of(x.id), x.id, x.part_index, x.page_id)).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted, "results are not in reading order");
    assert!(r.results.len() > 50, "{} results", r.results.len());
}
