//! Matches across page breaks on a real corpus: how many a query finds, and
//! what they cost.
//! `cargo run --release -p kashshaf-engine --example boundary_probe -- <data_dir> "<phrase>" ["<term1>" "<term2>" <distance>]`
use kashshaf_engine::{EngineConfig, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache};
use std::sync::Arc;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let phrase = args.next().expect("phrase");
    let mut config = EngineConfig::default();
    config.exact_counts = true;
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&db), config)?;
    engine.set_token_cache(Arc::new(TokenCache::new(db, 100_000)?));
    println!("boundary index: {}", engine.has_boundary_index());
    let term = |q: &str| SearchTerm { query: q.to_string(), mode: SearchMode::Surface };
    let filters = SearchFilters::default();

    let t = Instant::now();
    let r = engine.combined_search(&[term(&phrase)], &[], &filters, 250, 0)?;
    let first = t.elapsed();
    let mut cross = 0usize;
    let mut offset = 0usize;
    let mut shown = 0;
    loop {
        let page = engine.combined_search(&[term(&phrase)], &[], &filters, 250, offset)?;
        if page.results.is_empty() {
            break;
        }
        for h in &page.results {
            if h.crosses_page {
                cross += 1;
                if shown < 3 {
                    shown += 1;
                    let s = h.secondary.as_ref().unwrap();
                    println!(
                        "  e.g. book {} {}:{} ({} tokens) + {}:{} ({} tokens)",
                        h.id, h.part_label, h.page_number, h.matched_token_indices.len(), s.part_label, s.page_number, s.matched_token_indices.len()
                    );
                }
            }
        }
        offset += page.results.len();
        if offset >= page.total_hits {
            break;
        }
    }
    println!(
        "phrase {:?}: {} hits total, {} across page breaks; first page in {} ms, whole walk in {} ms",
        phrase,
        r.total_hits,
        cross,
        first.as_millis(),
        t.elapsed().as_millis()
    );

    if let (Some(a), Some(b), Some(d)) = (args.next(), args.next(), args.next()) {
        let d: usize = d.parse()?;
        let t = Instant::now();
        let r = engine.proximity_search(&term(&a), &term(&b), d, &filters, 250, 0)?;
        let cross_first = r.results.iter().filter(|h| h.crosses_page).count();
        println!(
            "proximity {:?} ~{} {:?}: {} hits total (capped: {:?}), {} of the first {} across page breaks, {} ms",
            a,
            d,
            b,
            r.total_hits,
            r.was_capped,
            cross_first,
            r.results.len(),
            t.elapsed().as_millis()
        );
    }
    Ok(())
}
