//! The deploy smoke's four queries, timed locally with the API's engine
//! configuration: served elapsed and total_hits as the smoke sees them, then
//! the settled count once the walk has finished.
//! `cargo run --release -p kashshaf-engine --example smoke_probe -- <data_dir> [rounds]`
use kashshaf_engine::{EngineConfig, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache};
use std::sync::Arc;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let rounds: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(3);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&db), EngineConfig::api_server())?;
    engine.set_token_cache(Arc::new(TokenCache::new(db, 100_000)?));
    println!("boundary index: {}", engine.has_boundary_index());
    let filters = SearchFilters::default();
    let term = |q: &str, mode: SearchMode| SearchTerm { query: q.to_string(), mode };

    for round in 1..=rounds {
        // Every round is a cold walk, as the smoke's is.
        engine.clear_walk_cache();
        println!("--- round {round}");

        let t = Instant::now();
        let r = engine.search("قال", SearchMode::Lemma, &filters, 250, 0)?;
        println!("search قال lemma:        {} ms (elapsed_ms {}), total {}", t.elapsed().as_millis(), r.elapsed_ms, r.total_hits);

        let t = Instant::now();
        let r = engine.proximity_search(&term("الله", SearchMode::Surface), &term("قال", SearchMode::Lemma), 10, &filters, 5, 0)?;
        let served = (t.elapsed().as_millis(), r.elapsed_ms, r.total_hits, r.was_capped, r.complete);
        engine.wait_walks();
        let settled = engine.proximity_search(&term("الله", SearchMode::Surface), &term("قال", SearchMode::Lemma), 10, &filters, 5, 0)?;
        println!(
            "proximity الله ~10 قال:   {} ms (elapsed_ms {}), served total {} capped {:?} complete {:?}; settled total {} capped {:?}",
            served.0, served.1, served.2, served.3, served.4, settled.total_hits, settled.was_capped
        );

        let t = Instant::now();
        let r = engine.wildcard_search("ابن ال*", &filters, 5, 0)?;
        let served = (t.elapsed().as_millis(), r.elapsed_ms, r.total_hits, r.was_capped, r.complete);
        engine.wait_walks();
        let settled = engine.wildcard_search("ابن ال*", &filters, 5, 0)?;
        println!(
            "wildcard ابن ال*:         {} ms (elapsed_ms {}), served total {} capped {:?} complete {:?}; settled total {} capped {:?}",
            served.0, served.1, served.2, served.3, served.4, settled.total_hits, settled.was_capped
        );
    }
    Ok(())
}
