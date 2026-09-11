//! Benchmark and parity harness.
//!
//! Runs a fixed query set against an index + corpus.db and writes a JSON
//! report with latency percentiles, total hits, the ordered result keys of
//! the first page, and highlight positions — enough for `compare.py` to
//! detect any change in result sets or a latency regression.
//!
//! Usage:
//!   bench --index PATH --corpus-db PATH --queries engine/bench/queries.json \
//!         [--runs 5] [--limit 250] [--out report.json] [--api-config]
//!         [--wildcard-threshold N] [--prox-cap N]
//!
//! Every case line also reports the process's current and peak resident set
//! (working set) so memory spikes can be attributed to a query.

use anyhow::{Context, Result};
use kashshaf_engine::{
    compute_variants, EngineConfig, PageKey, SearchEngine, SearchFilters, TokenCache,
};
use serde::Serialize;
use std::env;
use std::path::PathBuf;
use std::time::Instant;

use kashshaf_engine::bench_cases::{pct, QueryCase, QuerySpec};

#[derive(Debug, Serialize)]
struct CaseReport {
    name: String,
    runs: usize,
    /// The first run: a cold walk (later runs are served from the walk cache).
    first_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    total_hits: usize,
    /// (text_id, part_index, page_id) of the returned page, in order
    results: Vec<(u64, u64, u64)>,
    /// matched positions for the first 50 results (or variants tuples)
    highlights: Vec<Vec<u32>>,
    variants: Vec<(Vec<String>, u32)>,
    error: Option<String>,
    /// Per-stage timings for proximity cases (last run).
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<serde_json::Value>,
    /// `total_hits` is a lower bound (candidate cap or budget reached).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    was_capped: bool,
    /// Resident set right after the case's runs, MiB (includes mmapped index pages).
    rss_mb: f64,
    /// Process peak resident set so far (monotonic), MiB.
    peak_rss_mb: f64,
    /// Private (anonymous) bytes after the case's runs, MiB.
    private_mb: f64,
    /// Peak private bytes so far (monotonic), MiB.
    peak_private_mb: f64,
}

#[derive(Debug, Serialize)]
struct Report {
    index: String,
    corpus_db: String,
    kind: String,
    root_hedge: bool,
    docs: u64,
    segments: usize,
    reading_order: bool,
    limit: usize,
    wildcard_expansion_threshold: usize,
    max_verified_hits: usize,
    walk_budget_ms: u64,
    exact_counts: bool,
    /// Resident set after opening the index and corpus.db, MiB.
    baseline_rss_mb: f64,
    /// Peak resident set over the whole run, MiB.
    peak_rss_mb: f64,
    /// Private bytes after opening, MiB.
    baseline_private_mb: f64,
    /// Peak private bytes over the whole run, MiB.
    peak_private_mb: f64,
    cases: Vec<CaseReport>,
}

use kashshaf_engine::memory::process_memory;

/// Alias kept for the call sites below.
fn mem() -> kashshaf_engine::ProcessMemory {
    process_memory()
}

fn mib(b: u64) -> f64 {
    b as f64 / (1024.0 * 1024.0)
}

/// Step-2 micro-benchmarks: blob fetch strategies and zstd dictionary handling.
fn run_micro(cache: &TokenCache, n: usize) -> Result<()> {
    let keys3 = cache.sample_keys(n)?;
    let keys: Vec<PageKey> = keys3.iter().map(|&(b, part, p)| PageKey::new(b, part, p)).collect();
    eprintln!("micro-benchmark over {} pages", keys3.len());
    let per = |us: u128, count: usize| if count == 0 { 0.0 } else { us as f64 / count as f64 };

    // Fetch: row-value IN (current), PK point lookups on one connection, open-per-call
    let t = Instant::now();
    let rv = cache.bench_fetch_rowvalue(&keys)?;
    let rv_us = t.elapsed().as_micros();
    eprintln!("fetch  row-value IN(VALUES) x250          {:>8.1} us/page  ({} rows)", per(rv_us, rv.len()), rv.len());

    let conn = cache.bench_connection()?;
    let t = Instant::now();
    let pk = cache.bench_fetch_pk(&conn, &keys3)?;
    let pk_us = t.elapsed().as_micros();
    eprintln!("fetch  PK point lookup, one connection    {:>8.1} us/page  ({} rows)", per(pk_us, pk.len()), pk.len());

    let sub: Vec<(u64, u64, u64)> = keys3.iter().take(n.min(1000)).copied().collect();
    let t = Instant::now();
    let oe = cache.bench_fetch_pk_open_each(&sub)?;
    let oe_us = t.elapsed().as_micros();
    eprintln!("fetch  PK point lookup, open per call     {:>8.1} us/page  ({} rows)", per(oe_us, oe.len()), oe.len());

    // Decode: prepared dictionary (current) vs dictionary digested per blob
    let blobs: Vec<(i64, Vec<u8>)> = pk;
    let v2: Vec<&Vec<u8>> = blobs.iter().filter(|(e, _)| *e == 2).map(|(_, b)| b).collect();
    if let Some(codec) = cache.codec() {
        let t = Instant::now();
        let mut tokens = 0usize;
        for b in &v2 {
            tokens += codec.decode_v2(b)?.len();
        }
        let prep_us = t.elapsed().as_micros();
        let t = Instant::now();
        for b in &v2 {
            codec.decode_v2_unprepared(b)?;
        }
        let unprep_us = t.elapsed().as_micros();
        eprintln!(
            "decode prepared dictionary                {:>8.1} us/page  ({} blobs, {} tokens, {:.2} us/token)",
            per(prep_us, v2.len()),
            v2.len(),
            tokens,
            if tokens == 0 { 0.0 } else { prep_us as f64 / tokens as f64 }
        );
        eprintln!("decode dictionary digested per blob       {:>8.1} us/page", per(unprep_us, v2.len()));
    } else {
        let t = Instant::now();
        for (e, b) in &blobs {
            cache.decode(*e, b)?;
        }
        eprintln!("decode raw u32 (encoding 1)               {:>8.1} us/page", per(t.elapsed().as_micros(), blobs.len()));
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut index: Option<PathBuf> = None;
    let mut corpus_db: Option<PathBuf> = None;
    let mut queries: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut runs = 5usize;
    let mut limit = 250usize;
    let mut api_config = false;
    let mut fallback_order = false;
    let mut no_root_hedge = false;
    let mut micro: usize = 0;
    let mut prox_impl: Option<String> = None;
    let mut prox_cap: Option<usize> = None;
    let mut prox_budget: Option<u64> = None;
    let mut wildcard_threshold: Option<usize> = None;
    let mut walk_budget: Option<u64> = None;
    let mut exact_counts = false;
    let mut remote: Option<String> = None;
    let mut concurrency: Option<usize> = None;
    let mut check_compat = false;
    let mut rps = 8.0f64;
    let mut query_files: Vec<PathBuf> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        let val = |i: usize| args.get(i + 1).cloned().context("missing value");
        match args[i].as_str() {
            "--index" => { index = Some(PathBuf::from(val(i)?)); i += 1; }
            "--corpus-db" => { corpus_db = Some(PathBuf::from(val(i)?)); i += 1; }
            "--queries" => { let p = PathBuf::from(val(i)?); query_files.push(p.clone()); queries = Some(p); i += 1; }
            "--out" => { out = Some(PathBuf::from(val(i)?)); i += 1; }
            "--runs" => { runs = val(i)?.parse()?; i += 1; }
            "--limit" => { limit = val(i)?.parse()?; i += 1; }
            "--api-config" => api_config = true,
            "--fallback-order" => fallback_order = true,
            "--no-root-hedge" => no_root_hedge = true,
            "--micro" => { micro = val(i)?.parse()?; i += 1; }
            "--proximity" => { prox_impl = Some(val(i)?); i += 1; }
            "--prox-cap" => { prox_cap = Some(val(i)?.parse()?); i += 1; }
            "--prox-budget-ms" => { prox_budget = Some(val(i)?.parse()?); i += 1; }
            "--wildcard-threshold" => { wildcard_threshold = Some(val(i)?.parse()?); i += 1; }
            "--walk-budget-ms" => { walk_budget = Some(val(i)?.parse()?); i += 1; }
            "--exact-counts" => exact_counts = true,
            "--remote" => { remote = Some(val(i)?); i += 1; }
            "--concurrency" => { concurrency = Some(val(i)?.parse()?); i += 1; }
            "--check-compat" => check_compat = true,
            "--rps" => { rps = val(i)?.parse()?; i += 1; }
            other => anyhow::bail!("unknown argument {}", other),
        }
        i += 1;
    }
    if let Some(base) = remote {
        #[cfg(feature = "remote")]
        {
            if query_files.is_empty() {
                query_files = vec![PathBuf::from("engine/bench/queries.json"), PathBuf::from("engine/bench/proximity.json")];
            }
            return kashshaf_engine::bench_remote::run(kashshaf_engine::bench_remote::RemoteOpts {
                base,
                queries: query_files,
                runs,
                limit,
                concurrency,
                check_compat,
                out,
                rps,
            });
        }
        #[cfg(not(feature = "remote"))]
        {
            let _ = (base, concurrency, check_compat, rps, &query_files);
            anyhow::bail!("this bench binary was built without the `remote` feature (cargo build -p kashshaf-engine --features remote --bin bench)");
        }
    }
    let index = index.context("--index is required")?;
    let corpus_db = corpus_db.context("--corpus-db is required")?;
    let queries = queries.unwrap_or_else(|| PathBuf::from("engine/bench/queries.json"));

    let mut config = if api_config { EngineConfig::api_server() } else { EngineConfig::default() };
    config.force_fallback_ordering = fallback_order;
    config.prefer_root_text = !no_root_hedge;
    match prox_impl.as_deref() {
        Some("positional") => config.proximity_impl = kashshaf_engine::ProximityImpl::Positional,
        Some("forward") => config.proximity_impl = kashshaf_engine::ProximityImpl::Forward,
        Some(other) => anyhow::bail!("--proximity must be positional or forward, got {}", other),
        None => {}
    }
    if let Some(c) = prox_cap {
        config.max_verified_hits = c;
    }
    if let Some(b) = prox_budget {
        config.proximity_budget_ms = b;
    }
    if let Some(t) = wildcard_threshold {
        config.wildcard_expansion_threshold = t;
    }
    if let Some(b) = walk_budget {
        config.walk_budget_ms = b;
    }
    config.exact_counts = exact_counts;
    let t_open = Instant::now();
    let mut engine = SearchEngine::open_with_corpus(&index, Some(&corpus_db), config)?;
    let cache = std::sync::Arc::new(TokenCache::new(corpus_db.clone(), 1000)?);
    engine.set_token_cache(cache.clone());
    let m0 = mem();
    eprintln!(
        "opened {:?} index ({} docs, {} segments, reading_order={}, root_hedge={}) and corpus.db (codec={}) in {} ms; rss {:.0} MiB (peak {:.0}), private {:.0} MiB (peak {:.0}); wildcard_expansion_threshold={} max_verified_hits={} walk_budget_ms={} exact_counts={}",
        engine.kind(),
        engine.doc_count()?,
        engine.segment_count(),
        engine.reading_order(),
        engine.has_root_hedge(),
        cache.has_codec(),
        t_open.elapsed().as_millis(),
        mib(m0.rss),
        mib(m0.peak_rss),
        mib(m0.private),
        mib(m0.peak_private),
        engine.config().wildcard_expansion_threshold,
        engine.config().max_verified_hits,
        engine.config().walk_budget_ms,
        engine.exact_counts()
    );

    if micro > 0 {
        run_micro(&cache, micro)?;
        return Ok(());
    }

    let cases: Vec<QueryCase> = serde_json::from_str(&std::fs::read_to_string(&queries)?)
        .with_context(|| format!("parsing {:?}", queries))?;

    let mut reports = Vec::new();
    for case in cases {
        engine.set_exact_counts(case.exact_counts.unwrap_or(exact_counts));
        let filters = SearchFilters { book_ids: case.book_ids.clone(), ..Default::default() };
        let mut times = Vec::with_capacity(runs);
        let mut total_hits = 0usize;
        let mut results: Vec<(u64, u64, u64)> = Vec::new();
        let mut highlights: Vec<Vec<u32>> = Vec::new();
        let mut variants: Vec<(Vec<String>, u32)> = Vec::new();
        let mut error: Option<String> = None;
        let mut stats: Option<serde_json::Value> = None;
        let mut was_capped = false;

        for _ in 0..runs {
            let t0 = Instant::now();
            let outcome: Result<()> = (|| {
                match &case.spec {
                    QuerySpec::Term { query, mode, offset } => {
                        let r = engine.search(query, *mode, &filters, limit, *offset)?;
                        total_hits = r.total_hits;
                        was_capped = r.was_capped == Some(true);
                        results = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
                        highlights = r.results.iter().take(50).map(|x| x.matched_token_indices.clone()).collect();
                    }
                    QuerySpec::Combined { and_terms, or_terms } => {
                        let r = engine.combined_search(and_terms, or_terms, &filters, limit, 0)?;
                        total_hits = r.total_hits;
                        was_capped = r.was_capped == Some(true);
                        results = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
                        highlights = r.results.iter().take(50).map(|x| x.matched_token_indices.clone()).collect();
                    }
                    QuerySpec::Proximity { term1, term2, distance, offset } => {
                        let (r, st) = engine.proximity_search_with_stats(term1, term2, *distance, &filters, limit, *offset)?;
                        total_hits = r.total_hits;
                        was_capped = r.was_capped == Some(true);
                        results = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
                        highlights = r.results.iter().take(50).map(|x| x.matched_token_indices.clone()).collect();
                        stats = Some(serde_json::json!({
                            "path": st.path,
                            "candidates_total": st.candidates_total,
                            "candidates_scanned": st.candidates_scanned,
                            "verified_hits": st.verified_hits,
                            "set_sizes": [st.set1_size, st.set2_size],
                            "tantivy_ms": st.tantivy_us as f64 / 1e3,
                            "keys_ms": st.keys_us as f64 / 1e3,
                            "open_ms": st.open_us as f64 / 1e3,
                            "fetch_ms": st.fetch_us as f64 / 1e3,
                            "decode_ms": st.decode_us as f64 / 1e3,
                            "scan_ms": st.scan_us as f64 / 1e3,
                            "doc_fetch_ms": st.doc_fetch_us as f64 / 1e3,
                            "total_ms": st.total_us as f64 / 1e3,
                            "per_candidate_us": st.per_candidate_us(),
                            "cache_hits": st.cache_hits,
                            "blob_kb": st.blob_bytes / 1024,
                            "was_capped": r.was_capped,
                            "from_cache": st.from_cache,
                            "walk_ms": st.walk_ms,
                        }));
                    }
                    QuerySpec::Wildcard { query, offset } => {
                        let r = engine.wildcard_search(query, &filters, limit, *offset)?;
                        total_hits = r.total_hits;
                        was_capped = r.was_capped == Some(true);
                        results = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
                        highlights = r.results.iter().take(50).map(|x| x.matched_token_indices.clone()).collect();
                    }
                    QuerySpec::Name { forms } => {
                        let r = engine.name_search(forms, &filters, limit, 0)?;
                        total_hits = r.total_hits;
                        was_capped = r.was_capped == Some(true);
                        results = r.results.iter().map(|x| (x.id, x.part_index, x.page_id)).collect();
                        highlights = r.results.iter().take(50).map(|x| x.matched_token_indices.clone()).collect();
                    }
                    QuerySpec::Variants { query, mode } => {
                        let r = compute_variants(&engine, &cache, query, *mode, &filters)?;
                        total_hits = r.total_hits;
                        variants = r.variants.iter().take(200).map(|v| (v.surface_tuple.clone(), v.freq)).collect();
                    }
                    QuerySpec::PageLoad { pages } => {
                        cache.clear();
                        let mut n = 0usize;
                        for &(id, part, page) in pages {
                            let p = engine.get_page(id, part, page)?;
                            let t = cache.get(&PageKey::new(id, part, page))?;
                            if p.is_some() && !t.is_empty() {
                                n += 1;
                            }
                        }
                        total_hits = n;
                    }
                }
                Ok(())
            })();
            times.push(t0.elapsed().as_secs_f64() * 1e3);
            if let Err(e) = outcome {
                error = Some(e.to_string());
                break;
            }
            // The first run may return before its walk has finished; let it
            // complete so the remaining runs measure true cache hits and the
            // reported count is the settled one.
            if times.len() == 1 {
                engine.wait_walks();
            }
        }
        // Let the background walk finish so the next case (and the memory
        // figures) see a settled cache.
        engine.wait_walks();
        let first_ms = times.first().copied().unwrap_or(0.0);
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let m = mem();
        eprintln!(
            "{:40} first {:8.2} ms  p50 {:8.2} ms  p95 {:8.2} ms  hits {:>9}{}  rss {:5.0} MiB (peak {:5.0})  private {:5.0} MiB (peak {:5.0}){}",
            case.name,
            first_ms,
            pct(&times, 0.5),
            pct(&times, 0.95),
            total_hits,
            if was_capped { "+" } else { " " },
            mib(m.rss),
            mib(m.peak_rss),
            mib(m.private),
            mib(m.peak_private),
            error.as_deref().map(|e| format!("  ERROR {}", e)).unwrap_or_default()
        );
        if let Some(s) = &stats {
            eprintln!(
                "{:40}   cand {}/{} hits {} sets {:?} | tantivy {:.1} keys {:.1} open {:.1} fetch {:.1} decode {:.1} scan {:.1} docs {:.1} ms | {:.1} us/cand{}",
                "",
                s["candidates_scanned"],
                s["candidates_total"],
                s["verified_hits"],
                s["set_sizes"],
                s["tantivy_ms"].as_f64().unwrap_or(0.0),
                s["keys_ms"].as_f64().unwrap_or(0.0),
                s["open_ms"].as_f64().unwrap_or(0.0),
                s["fetch_ms"].as_f64().unwrap_or(0.0),
                s["decode_ms"].as_f64().unwrap_or(0.0),
                s["scan_ms"].as_f64().unwrap_or(0.0),
                s["doc_fetch_ms"].as_f64().unwrap_or(0.0),
                s["per_candidate_us"].as_f64().unwrap_or(0.0),
                if s["was_capped"].as_bool() == Some(true) { "  CAPPED" } else { "" }
            );
        }
        reports.push(CaseReport {
            name: case.name,
            runs: times.len(),
            first_ms,
            p50_ms: pct(&times, 0.5),
            p95_ms: pct(&times, 0.95),
            min_ms: times.first().copied().unwrap_or(0.0),
            total_hits,
            results,
            highlights,
            variants,
            error,
            stats,
            was_capped,
            rss_mb: mib(m.rss),
            peak_rss_mb: mib(m.peak_rss),
            private_mb: mib(m.private),
            peak_private_mb: mib(m.peak_private),
        });
    }

    let report = Report {
        index: index.display().to_string(),
        corpus_db: corpus_db.display().to_string(),
        kind: format!("{:?}", engine.kind()),
        root_hedge: engine.has_root_hedge(),
        docs: engine.doc_count()?,
        segments: engine.segment_count(),
        reading_order: engine.reading_order(),
        limit,
        wildcard_expansion_threshold: engine.config().wildcard_expansion_threshold,
        max_verified_hits: engine.config().max_verified_hits,
        walk_budget_ms: engine.config().walk_budget_ms,
        exact_counts,
        baseline_rss_mb: mib(m0.rss),
        peak_rss_mb: mib(mem().peak_rss),
        baseline_private_mb: mib(m0.private),
        peak_private_mb: mib(mem().peak_private),
        cases: reports,
    };
    eprintln!(
        "peak rss {:.0} MiB (baseline after open {:.0}); peak private {:.0} MiB (baseline {:.0})",
        report.peak_rss_mb, report.baseline_rss_mb, report.peak_private_mb, report.baseline_private_mb
    );
    let json = serde_json::to_string_pretty(&report)?;
    match out {
        Some(p) => {
            std::fs::write(&p, json)?;
            eprintln!("wrote {:?}", p);
        }
        None => println!("{}", json),
    }
    Ok(())
}
