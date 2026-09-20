//! A page's name highlights, as the `/page` bundle computes them from the
//! displayed patterns, equal the name search's own positions on that page:
//! one expansion (`expand_name_patterns`) feeds both. Gated on
//! `KASHSHAF_SAMPLE_DIR`; without it every test passes vacuously.
//!
//!     KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data/data/sample" cargo test --release --test name_bundle_parity

use kashshaf_engine::{expand_name_forms, expand_name_patterns, EngineConfig, PageKey, SearchEngine, SearchFilters, TokenCache};
use std::path::PathBuf;
use std::sync::Arc;

fn open() -> Option<(SearchEngine, Arc<TokenCache>, Vec<PageKey>)> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), EngineConfig { exact_counts: true, ..EngineConfig::default() }).ok()?;
    let cache = Arc::new(TokenCache::new(db.clone(), 100_000).ok()?);
    engine.set_token_cache(cache.clone());
    let conn = rusqlite::Connection::open(&db).ok()?;
    let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens ORDER BY book_id, part_index, page_id").ok()?;
    let keys: Vec<PageKey> = stmt
        .query_map([], |r| Ok(PageKey::new(r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))
        .ok()?
        .filter_map(|k| k.ok())
        .collect();
    Some((engine, cache, keys))
}

fn plain(w: &str) -> bool {
    w.chars().count() >= 2 && w.chars().all(|c| ('\u{0621}'..='\u{064A}').contains(&c))
}

/// Displayed patterns found in the sample's text: a kunya (`اب* X`, from a
/// page that writes ابو/ابا/ابي X) and a two-word name (`X بن Y`).
fn displayed_patterns(cache: &TokenCache, keys: &[PageKey]) -> Vec<String> {
    let mut kunya: Option<String> = None;
    let mut nasab: Option<String> = None;
    for key in keys.iter().take(3000) {
        let Ok(tokens) = cache.get(key) else { continue };
        let surfaces: Vec<&str> = tokens.iter().map(|t| t.surface.as_str()).collect();
        for w in surfaces.windows(3) {
            if kunya.is_none() && ["ابو", "ابا", "ابي"].contains(&w[0]) && plain(w[1]) {
                kunya = Some(format!("اب* {}", w[1]));
            }
            if nasab.is_none() && plain(w[0]) && w[1] == "بن" && plain(w[2]) {
                nasab = Some(format!("{} بن {}", w[0], w[2]));
            }
        }
        if kunya.is_some() && nasab.is_some() {
            break;
        }
    }
    kunya.into_iter().chain(nasab).collect()
}

#[test]
fn the_bundle_s_positions_are_the_search_s_own() {
    let Some((engine, cache, keys)) = open() else { return };
    let display = displayed_patterns(&cache, &keys);
    assert!(!display.is_empty(), "the sample writes some name");

    for pattern in &display {
        // The search: the displayed pattern, expanded as the server does.
        let forms = expand_name_forms(&[vec![pattern.clone()]]);
        let results = engine.name_search(&forms, &SearchFilters::default(), 50, 0).expect("name search");
        assert!(results.total_hits > 0, "{pattern} is on some page");
        assert!(!results.results.is_empty());

        // The bundle: the same displayed pattern, expanded the same way, on each result's page.
        for r in &results.results {
            let bundle = engine
                .get_name_match_positions(r.id, r.part_index, r.page_id, &expand_name_patterns(&[pattern.clone()]))
                .expect("positions");
            assert!(!bundle.is_empty(), "{pattern}: highlights on {}:{}:{}", r.id, r.part_index, r.page_id);
            let mut theirs = r.matched_token_indices.clone();
            theirs.sort_unstable();
            theirs.dedup();
            // The search's row carries at most its highlight cap of the page's
            // positions; every one of them is among the bundle's, and where
            // the row is not capped the two are the same list.
            assert!(theirs.iter().all(|p| bundle.contains(p)), "{pattern}: the search's positions {:?} are among the bundle's {:?}", theirs, bundle);
            if theirs.len() < engine.config().result_highlight_cap {
                assert_eq!(bundle, theirs, "{pattern} on {}:{}:{}", r.id, r.part_index, r.page_id);
            }
        }

        // And the expanded list is what the app used to send: the displayed
        // pattern alone finds nothing the expansion does not.
        let bare = engine.name_search(&[vec![pattern.replace("اب* ", "ابو ")]], &SearchFilters::default(), 1, 0).expect("bare");
        assert!(bare.total_hits <= results.total_hits);
    }
}
