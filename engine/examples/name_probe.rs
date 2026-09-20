//! The name search for the nineteen displayed patterns of أبو منصور معمر بن
//! أحمد بن زياد (nisbas الأصبهاني, الحافظ), timed and taken apart, then the
//! same query retrieved other ways, each held to the search's own pages and
//! highlight positions.
//! `cargo run --release -p kashshaf-engine --example name_probe -- <data_dir> [rounds]`
use kashshaf_engine::search::name_probe::ProbeOut;
use kashshaf_engine::{EngineConfig, SearchEngine, SearchFilters, TokenCache};
use std::sync::Arc;
use std::time::Instant;

const DISPLAY: &[&str] = &[
    "اب* منصور معمر بن احمد",
    "اب* منصور معمر بن احمد الاصبهاني",
    "اب* منصور معمر بن احمد الحافظ",
    "اب* منصور معمر بن احمد بن زياد",
    "اب* منصور معمر بن احمد بن زياد الاصبهاني",
    "اب* منصور معمر بن احمد بن زياد الحافظ",
    "اب* منصور معمر الاصبهاني",
    "اب* منصور معمر الحافظ",
    "اب* منصور بن احمد",
    "اب* منصور بن احمد الاصبهاني",
    "اب* منصور بن احمد الحافظ",
    "اب* منصور بن احمد بن زياد",
    "اب* منصور بن احمد بن زياد الاصبهاني",
    "اب* منصور بن احمد بن زياد الحافظ",
    "معمر بن احمد بن زياد",
    "معمر بن احمد بن زياد الاصبهاني",
    "معمر بن احمد بن زياد الحافظ",
    "معمر بن احمد الاصبهاني",
    "معمر بن احمد الحافظ",
];
const LIMIT: usize = 250;

fn ms(us: u64) -> String {
    format!("{:.1}", us as f64 / 1000.0)
}

fn report(o: &ProbeOut, base: Option<&ProbeOut>) {
    let t = &o.timing;
    let same = match base {
        Some(b) => {
            if b.pages == o.pages && b.highlights == o.highlights && b.total_hits == o.total_hits {
                "identical".to_string()
            } else {
                let pages = if b.pages == o.pages { "same pages" } else { "DIFFERENT pages" };
                let hl = if b.highlights == o.highlights { "same highlights" } else { "DIFFERENT highlights" };
                format!("{pages}, {hl}, total {} vs {}", o.total_hits, b.total_hits)
            }
        }
        None => "baseline".to_string(),
    };
    println!(
        "{:<44} queries {:>3} (verify plans {}) | total {:>8} ms | plan {:>6} weight {:>8} scorer {:>7} iterate {:>8} collect {:>8} verify {:>6} results {:>5} highlights {:>6} | hits {} (candidates {}) | {}",
        o.label,
        o.queries,
        o.verify_plans,
        ms(t.total_us),
        ms(t.plan_us),
        ms(t.weight_us),
        ms(t.scorer_us),
        ms(t.iterate_us),
        ms(t.collect_us),
        ms(t.verify_us),
        ms(t.results_us),
        ms(t.highlight_us),
        o.total_hits,
        o.candidates,
        same
    );
    if !o.note.is_empty() {
        println!("{:<44} {}", "", o.note);
    }
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let rounds: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(2);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&db), EngineConfig::api_server())?;
    engine.set_token_cache(Arc::new(TokenCache::new(db, 100_000)?));
    println!("boundary index present: {} (the name search never queries it: `paged`, no cross stream)", engine.has_boundary_index());
    println!("segments: {}, reading order: {}", engine.segment_count(), engine.reading_order());
    let filters = SearchFilters::default();

    let display: Vec<String> = DISPLAY.iter().map(|s| s.to_string()).collect();
    let expanded = engine.probe_expand(&display);
    println!("displayed patterns: {}, expanded (as searched): {}", display.len(), expanded.len());
    let minimal_display = SearchEngine::probe_minimal(&display);
    let minimal_expanded = engine.probe_expand(&minimal_display);
    println!("minimal displayed patterns: {} -> {:?}", minimal_display.len(), minimal_display);
    println!("minimal expanded: {}", minimal_expanded.len());

    for round in 1..=rounds {
        println!("\n=== round {round}");
        engine.clear_walk_cache();

        // The search as the API runs it.
        let t = Instant::now();
        let r = engine.name_search(&[expanded.clone()], &filters, LIMIT, 0)?;
        println!(
            "name_search (as served): {} ms wall, elapsed_ms {}, total_hits {}, results {}, walk_key {:?}, capped {:?}",
            t.elapsed().as_millis(),
            r.elapsed_ms,
            r.total_hits,
            r.results.len(),
            r.walk_key,
            r.was_capped
        );
        let served: Vec<(u64, u64, u64)> = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
        let served_hl: Vec<Vec<u32>> = r.results.iter().map(|x| x.matched_token_indices.clone()).collect();

        if round == 1 {
            // Each of the expanded patterns alone.
            let per = engine.probe_per_pattern(&expanded)?;
            let total_us: u64 = per.iter().map(|p| p.3).sum();
            let verify = per.iter().filter(|p| p.1).count();
            println!("per pattern alone: {} queries, {} need verification, sum {} ms", per.len(), verify, ms(total_us));
            let mut sorted = per.clone();
            sorted.sort_by_key(|p| std::cmp::Reverse(p.3));
            for (p, v, n, us) in sorted.iter().take(8) {
                println!("  {:>8} ms  hits {:>6}  verify {}  {}", ms(*us), n, v, p);
            }
            let median = {
                let mut v: Vec<u64> = per.iter().map(|p| p.3).collect();
                v.sort_unstable();
                v[v.len() / 2]
            };
            println!("  median {} ms, min {} ms", ms(median), ms(per.iter().map(|p| p.3).min().unwrap_or(0)));
        }

        let base = engine.probe_tantivy("baseline: 282 phrase queries", &engine.probe_sets(&expanded), &expanded, None, LIMIT)?;
        report(&base, None);
        if base.pages != served || base.highlights != served_hl {
            println!("  !! the probe's baseline differs from name_search itself");
        }

        // (a) one query per displayed pattern, first slot merged
        let merged = engine.probe_merged_first_slot(&expanded);
        let a = engine.probe_tantivy("(a) merged first slot", &merged, &expanded, None, LIMIT)?;
        report(&a, Some(&base));

        // (b) glob first slot
        let (glob, width) = engine.probe_glob_first_slot(&expanded);
        let b = engine.probe_tantivy(&format!("(b) glob اب* first slot ({width} ids)"), &glob, &expanded, Some(&expanded), LIMIT)?;
        report(&b, Some(&base));

        // (c) minimal patterns, per expanded pattern
        let c = engine.probe_tantivy("(c) minimal patterns", &engine.probe_sets(&minimal_expanded), &expanded, None, LIMIT)?;
        report(&c, Some(&base));

        // (d) positional, per expanded pattern
        let d = engine.probe_positional("(d) positional, 282", &engine.probe_sets(&expanded), &expanded, LIMIT)?;
        report(&d, Some(&base));

        // combinations
        let ac = engine.probe_tantivy("(a+c) merged, minimal", &engine.probe_merged_first_slot(&minimal_expanded), &expanded, None, LIMIT)?;
        report(&ac, Some(&base));
        let ad = engine.probe_positional("(a+d) positional, merged", &merged, &expanded, LIMIT)?;
        report(&ad, Some(&base));
        let cd = engine.probe_positional("(c+d) positional, minimal", &engine.probe_sets(&minimal_expanded), &expanded, LIMIT)?;
        report(&cd, Some(&base));
        let acd = engine.probe_positional("(a+c+d) positional, merged, minimal", &engine.probe_merged_first_slot(&minimal_expanded), &expanded, LIMIT)?;
        report(&acd, Some(&base));
    }
    Ok(())
}
