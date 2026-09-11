//! Deployment bench: the query sets replayed over HTTP against a running
//! `kashshaf-api` (feature `remote`; `bench --remote <url>`).
//!
//! * every case of the given query files, N runs each: wall-clock p50/p95
//!   from the client and the server's own `elapsed_ms`, so network and
//!   serialization show up as the difference; capped walks get a "page 20"
//!   case (offset 4750) served from the server's prefix cache;
//! * `--concurrency N`: the three scenarios of the capped-walks report
//!   (N identical proximity requests; N distinct distances; N distinct
//!   phrase walks) with a `/health` + `/page` side poller;
//! * `--check-compat`: the post-deploy smoke assertions of
//!   `api/deploy/smoke.sh` (search, proximity + status, wildcard, the
//!   `/page/tokens` shim, a burst that must yield a JSON 429).

use crate::bench_cases::{pct, QueryCase, QuerySpec};
use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct RemoteOpts {
    pub base: String,
    pub queries: Vec<PathBuf>,
    pub runs: usize,
    pub limit: usize,
    pub concurrency: Option<usize>,
    pub check_compat: bool,
    pub out: Option<PathBuf>,
    /// Requests per second for the sequential cases, so the server's own
    /// limiter (10 req/s, burst 30) never fires during a measurement.
    pub rps: f64,
}

/// Global pacing for the sequential measurements (the concurrency and burst
/// scenarios bypass it on purpose).
static PACER: std::sync::OnceLock<Mutex<(Instant, Duration)>> = std::sync::OnceLock::new();

fn pace() {
    if let Some(m) = PACER.get() {
        let mut g = m.lock().unwrap();
        let (last, interval) = *g;
        let elapsed = last.elapsed();
        if elapsed < interval {
            std::thread::sleep(interval - elapsed);
        }
        g.0 = Instant::now();
    }
}

/// Refill the server's burst bucket before an intentional burst.
fn settle_limiter() {
    std::thread::sleep(Duration::from_millis(3500));
}

#[derive(Debug, Serialize)]
struct RemoteCase {
    name: String,
    runs: usize,
    first_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    /// Median of the server-reported elapsed_ms (network + JSON = p50_ms - this).
    server_p50_ms: f64,
    total_hits: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    was_capped: bool,
    complete: Option<bool>,
    results: Vec<(u64, u64, u64)>,
    highlights: Vec<Vec<u32>>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct RemoteReport {
    base: String,
    health_before: Value,
    limit: usize,
    cases: Vec<RemoteCase>,
    concurrency: Vec<Value>,
    compat: Option<Value>,
    health_after: Value,
}

fn client() -> Result<Client> {
    Ok(Client::builder().timeout(Duration::from_secs(120)).user_agent("kashshaf-bench").build()?)
}

fn get_json(c: &Client, url: &str) -> Result<Value> {
    let r = c.get(url).send()?;
    let status = r.status();
    let text = r.text()?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {} {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    Ok(serde_json::from_str(&text).with_context(|| format!("parsing {}", url))?)
}

fn post_json(c: &Client, url: &str, body: &Value) -> Result<Value> {
    let r = c.post(url).json(body).send()?;
    let status = r.status();
    let text = r.text()?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {} {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    Ok(serde_json::from_str(&text).with_context(|| format!("parsing {}", url))?)
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn mode_str(m: crate::search::SearchMode) -> &'static str {
    match m {
        crate::search::SearchMode::Surface => "surface",
        crate::search::SearchMode::Lemma => "lemma",
        crate::search::SearchMode::Root => "root",
    }
}

/// One request for a case; returns the parsed response (search results, a
/// variants response, or a synthetic object for page loads).
fn run_case(c: &Client, base: &str, case: &QueryCase, limit: usize) -> Result<Value> {
    let book_ids = case.book_ids.as_ref().map(|v| v.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(","));
    let filters = json!({ "book_ids": case.book_ids });
    match &case.spec {
        QuerySpec::Term { query, mode, offset } => {
            let mut url = format!("{}/search?q={}&mode={}&limit={}&offset={}", base, enc(query), mode_str(*mode), limit, offset);
            if let Some(b) = &book_ids {
                url.push_str(&format!("&book_ids={}", b));
            }
            get_json(c, &url)
        }
        QuerySpec::Combined { and_terms, or_terms } => post_json(
            c,
            &format!("{}/search/combined", base),
            &json!({ "and_terms": and_terms, "or_terms": or_terms, "filters": filters, "limit": limit, "offset": 0 }),
        ),
        QuerySpec::Proximity { term1, term2, distance, offset } => post_json(
            c,
            &format!("{}/search/proximity", base),
            &json!({ "term1": term1, "term2": term2, "distance": distance, "filters": filters, "limit": limit, "offset": offset }),
        ),
        QuerySpec::Wildcard { query, offset } => {
            let mut url = format!("{}/search/wildcard?q={}&limit={}&offset={}", base, enc(query), limit, offset);
            if let Some(b) = &book_ids {
                url.push_str(&format!("&book_ids={}", b));
            }
            get_json(c, &url)
        }
        QuerySpec::Name { forms } => post_json(
            c,
            &format!("{}/search/name", base),
            &json!({ "forms": forms.iter().map(|p| json!({ "patterns": p })).collect::<Vec<_>>(), "filters": filters, "limit": limit, "offset": 0 }),
        ),
        QuerySpec::Variants { query, mode } => post_json(
            c,
            &format!("{}/search/variants", base),
            &json!({ "query": query, "mode": mode_str(*mode), "filters": filters }),
        ),
        QuerySpec::PageLoad { pages } => {
            let mut n = 0u64;
            let mut elapsed = 0.0;
            for &(id, part, page) in pages {
                pace();
                let t = Instant::now();
                let v = get_json(c, &format!("{}/page/tokens?id={}&part_index={}&page_id={}", base, id, part, page))?;
                elapsed += t.elapsed().as_secs_f64() * 1e3;
                if v.as_array().map_or(false, |a| !a.is_empty()) {
                    n += 1;
                }
            }
            // client_ms: the request time without the pacing sleeps
            Ok(json!({ "total_hits": n, "results": [], "elapsed_ms": elapsed as u64, "client_ms": elapsed }))
        }
    }
}

fn measure(c: &Client, base: &str, case: &QueryCase, runs: usize, limit: usize) -> RemoteCase {
    let mut times = Vec::with_capacity(runs);
    let mut server = Vec::with_capacity(runs);
    let mut last: Option<Value> = None;
    let mut error = None;
    for _ in 0..runs {
        pace();
        let t = Instant::now();
        match run_case(c, base, case, limit) {
            Ok(v) => {
                times.push(v.get("client_ms").and_then(Value::as_f64).unwrap_or(t.elapsed().as_secs_f64() * 1e3));
                server.push(v.get("elapsed_ms").and_then(Value::as_f64).unwrap_or(0.0));
                last = Some(v);
            }
            Err(e) => {
                times.push(t.elapsed().as_secs_f64() * 1e3);
                error = Some(e.to_string());
                break;
            }
        }
    }
    let first_ms = times.first().copied().unwrap_or(0.0);
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    server.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let v = last.unwrap_or(Value::Null);
    let results: Vec<(u64, u64, u64)> = v
        .get("results")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|r| (r["id"].as_u64().unwrap_or(0), r["part_index"].as_u64().unwrap_or(0), r["page_id"].as_u64().unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default();
    let highlights: Vec<Vec<u32>> = v
        .get("results")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .take(50)
                .map(|r| r["matched_token_indices"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|x| x as u32)).collect()).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    RemoteCase {
        name: case.name.clone(),
        runs: times.len(),
        first_ms,
        p50_ms: pct(&times, 0.5),
        p95_ms: pct(&times, 0.95),
        server_p50_ms: pct(&server, 0.5),
        total_hits: v.get("total_hits").and_then(Value::as_u64).unwrap_or(0),
        was_capped: v.get("was_capped").and_then(Value::as_bool).unwrap_or(false),
        complete: v.get("complete").and_then(Value::as_bool),
        results,
        highlights,
        error,
    }
}

fn wait_walks_idle(c: &Client, base: &str) {
    for _ in 0..600 {
        if let Ok(h) = get_json(c, &format!("{}/health", base)) {
            if h["walks_active"].as_u64().unwrap_or(0) == 0 && h["walks_queued"].as_u64().unwrap_or(0) == 0 {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// N concurrent proximity requests with a side poller; the scenarios of
/// CAPPED_WALKS_REPORT.md §6.
fn concurrency_scenario(c: &Client, base: &str, n: usize, name: &str, term1: &str, term2: &str, mode2: &str, distinct: bool, limit: usize) -> Result<Value> {
    let probe = get_json(c, &format!("{}/search?q={}&mode=lemma&limit=1", base, enc("كتاب")))?;
    let row = probe["results"].get(0).cloned().ok_or_else(|| anyhow!("no probe row"))?;
    let page_url = format!("{}/page?id={}&part_index={}&page_id={}", base, row["id"], row["part_index"], row["page_id"]);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let side = Arc::new(Mutex::new((Vec::<f64>::new(), Vec::<f64>::new(), 0u64, 0u64, 0.0f64)));
    let poller = {
        let (c, base, stop, side, page_url) = (c.clone(), base.to_string(), stop.clone(), side.clone(), page_url.clone());
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let t = Instant::now();
                if let Ok(h) = get_json(&c, &format!("{}/health", base)) {
                    let hm = t.elapsed().as_secs_f64() * 1e3;
                    let t2 = Instant::now();
                    let ok = get_json(&c, &page_url).is_ok();
                    let pm = t2.elapsed().as_secs_f64() * 1e3;
                    let mut s = side.lock().unwrap();
                    s.0.push(hm);
                    if ok {
                        s.1.push(pm);
                    }
                    s.2 = s.2.max(h["walks_queued"].as_u64().unwrap_or(0));
                    s.3 = s.3.max(h["walks_active"].as_u64().unwrap_or(0));
                    s.4 = s.4.max(h["peak_rss_mb"].as_f64().unwrap_or(0.0));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    let t_all = Instant::now();
    let handles: Vec<_> = (0..n)
        .map(|i| {
            let (c, base) = (c.clone(), base.to_string());
            let (t1, t2, m2) = (term1.to_string(), term2.to_string(), mode2.to_string());
            std::thread::spawn(move || {
                let d = if distinct { (i % 100) + 1 } else { 10 };
                let body = json!({ "term1": { "query": t1, "mode": "surface" }, "term2": { "query": t2, "mode": m2 }, "distance": d, "limit": limit, "offset": 0 });
                let t = Instant::now();
                let r = post_json(&c, &format!("{}/search/proximity", base), &body);
                (t.elapsed().as_secs_f64() * 1e3, r)
            })
        })
        .collect();
    let mut lat = Vec::new();
    let mut totals = Vec::new();
    let mut errors = Vec::new();
    for h in handles {
        let (ms, r) = h.join().unwrap();
        match r {
            Ok(v) => {
                lat.push(ms);
                totals.push(json!([v["total_hits"], v["was_capped"].as_bool().unwrap_or(false), v["complete"]]));
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    let wall = t_all.elapsed().as_secs_f64() * 1e3;
    wait_walks_idle(c, base);
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = poller.join();
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let s = side.lock().unwrap();
    let mut hs = s.0.clone();
    hs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut ps = s.1.clone();
    ps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let after = get_json(c, &format!("{}/health", base)).unwrap_or(Value::Null);
    Ok(json!({
        "scenario": name, "n": n, "distinct": distinct, "wall_ms": wall,
        "first_window_ms": { "p50": pct(&lat, 0.5), "p95": pct(&lat, 0.95), "min": lat.first(), "max": lat.last() },
        "errors": errors, "totals_distinct": totals.len(),
        "walks_queued_peak": s.2, "walks_active_peak": s.3,
        "health_ms_max": hs.last(), "health_ms_p50": pct(&hs, 0.5), "page_ms_max": ps.last(), "page_ms_p50": pct(&ps, 0.5),
        "side_samples": hs.len(), "peak_rss_mb": s.4.max(after["peak_rss_mb"].as_f64().unwrap_or(0.0)),
        "private_mb_after": after["private_mb"], "prefix_cache_entries": after["prefix_cache_entries"], "prefix_cache_bytes": after["prefix_cache_bytes"],
    }))
}

/// The smoke assertions of api/deploy/smoke.sh.
fn check_compat(c: &Client, base: &str) -> Value {
    let mut checks: Vec<Value> = Vec::new();
    let mut ok_all = true;
    let mut record = |name: &str, ok: bool, detail: String| {
        ok_all &= ok;
        println!("{} {} {}", if ok { "ok  " } else { "FAIL" }, name, detail);
        checks.push(json!({ "check": name, "ok": ok, "detail": detail }));
    };
    let h = get_json(c, &format!("{}/health", base)).unwrap_or(Value::Null);
    record("health status ok", h["status"] == "ok", h["version"].to_string());
    let wc = h["warm_cache"].as_str().unwrap_or("disabled");
    record("warm_cache complete|disabled", wc == "complete" || wc == "disabled", wc.to_string());

    let r = get_json(c, &format!("{}/search?q={}&mode=lemma&limit=5", base, enc("قال"))).unwrap_or(Value::Null);
    let th = r["total_hits"].as_u64().unwrap_or(0);
    let el = r["elapsed_ms"].as_u64().unwrap_or(99_999);
    record("/search قال total_hits > 0", th > 0, format!("total_hits={}", th));
    record("/search elapsed < 500 ms", el < 500, format!("{} ms", el));

    let r = post_json(c, &format!("{}/search/proximity", base), &json!({ "term1": { "query": "الله", "mode": "surface" }, "term2": { "query": "قال", "mode": "lemma" }, "distance": 10, "limit": 5, "offset": 0 })).unwrap_or(Value::Null);
    let th = r["total_hits"].as_u64().unwrap_or(0);
    let el = r["elapsed_ms"].as_u64().unwrap_or(99_999);
    let rows = r["results"].as_array().map_or(0, Vec::len);
    record("/search/proximity total_hits > 0 and rows", th > 0 && rows > 0, format!("total_hits={} rows={}", th, rows));
    record("/search/proximity elapsed < 2000 ms", el < 2000, format!("{} ms", el));
    match r["walk_key"].as_str() {
        Some(k) => {
            let s = get_json(c, &format!("{}/search/status?key={}", base, enc(k)));
            record("/search/status for the walk", s.is_ok(), s.map(|v| v.to_string()).unwrap_or_else(|e| e.to_string()));
        }
        None => record("/search/status for the walk", false, "no walk_key in the proximity response".into()),
    }

    let r = get_json(c, &format!("{}/search/wildcard?q={}&limit=5", base, enc("ابن ال*"))).unwrap_or(Value::Null);
    let th = r["total_hits"].as_u64().unwrap_or(0);
    let el = r["elapsed_ms"].as_u64().unwrap_or(99_999);
    record("/search/wildcard ابن ال* total_hits > 0", th > 0, format!("total_hits={}{}", th, if r["was_capped"].as_bool().unwrap_or(false) { "+" } else { "" }));
    record("/search/wildcard elapsed < 3000 ms", el < 3000, format!("{} ms", el));

    let probe = get_json(c, &format!("{}/search?q={}&mode=lemma&limit=1", base, enc("كتاب"))).unwrap_or(Value::Null);
    if let Some(row) = probe["results"].get(0) {
        let url = format!("{}/page/tokens?id={}&page_id={}", base, row["id"], row["page_id"]);
        let status = c.get(&url).send().map(|r| r.status().as_u16()).unwrap_or(0);
        record("/page/tokens without part_index -> 200 (0.4.x shim)", status == 200, format!("HTTP {}", status));
    } else {
        record("/page/tokens without part_index -> 200 (0.4.x shim)", false, "no probe row".into());
    }

    // Burst: 60 concurrent cheap requests; at least one 429 with a JSON error body.
    settle_limiter();
    let handles: Vec<_> = (0..60)
        .map(|_| {
            let (c, base) = (c.clone(), base.to_string());
            std::thread::spawn(move || {
                c.get(format!("{}/genres", base)).send().map(|r| (r.status().as_u16(), r.text().unwrap_or_default())).unwrap_or((0, String::new()))
            })
        })
        .collect();
    let mut n429 = 0;
    let mut body = String::new();
    for h in handles {
        let (s, b) = h.join().unwrap();
        if s == 429 {
            n429 += 1;
            if body.is_empty() {
                body = b.chars().take(120).collect();
            }
        }
    }
    record("burst of 60 yields a JSON 429", n429 > 0 && body.contains("\"error\""), format!("{} x 429 {}", n429, body));
    json!({ "ok": ok_all, "checks": checks })
}

pub fn run(opts: RemoteOpts) -> Result<()> {
    let base = opts.base.trim_end_matches('/').to_string();
    let _ = PACER.set(Mutex::new((Instant::now(), Duration::from_secs_f64(1.0 / opts.rps.max(0.1)))));
    let c = client()?;
    let health_before = get_json(&c, &format!("{}/health", base)).with_context(|| format!("{}/health", base))?;
    eprintln!(
        "remote {}: version {} corpus {} walks max {} warm_cache {} rss {:.0} MiB",
        base, health_before["version"], health_before["corpus_version"], health_before["max_concurrent_walks"], health_before["warm_cache"], health_before["rss_mb"].as_f64().unwrap_or(0.0)
    );

    let mut cases_out = Vec::new();
    for qf in &opts.queries {
        let cases: Vec<QueryCase> = serde_json::from_str(&std::fs::read_to_string(qf)?).with_context(|| format!("parsing {:?}", qf))?;
        for case in cases {
            let r = measure(&c, &base, &case, opts.runs, opts.limit);
            eprintln!(
                "{:44} first {:8.1} ms  p50 {:8.1} ms  p95 {:8.1} ms  server p50 {:7.1} ms  hits {:>9}{}{}",
                r.name, r.first_ms, r.p50_ms, r.p95_ms, r.server_p50_ms, r.total_hits, if r.was_capped { "+" } else { " " },
                r.error.as_deref().map(|e| format!("  ERROR {}", e)).unwrap_or_default()
            );
            // Capped walks: page 20 from the prefix cache.
            let page20 = if r.was_capped || r.complete.is_some() { case.at_offset(4750, "page 20") } else { None };
            cases_out.push(r);
            if let Some(p) = page20 {
                wait_walks_idle(&c, &base);
                let r = measure(&c, &base, &p, opts.runs, opts.limit);
                eprintln!(
                    "{:44} first {:8.1} ms  p50 {:8.1} ms  p95 {:8.1} ms  server p50 {:7.1} ms  hits {:>9}{}",
                    r.name, r.first_ms, r.p50_ms, r.p95_ms, r.server_p50_ms, r.total_hits, if r.was_capped { "+" } else { " " }
                );
                cases_out.push(r);
            }
        }
    }

    let mut concurrency = Vec::new();
    if let Some(n) = opts.concurrency {
        for (name, t1, t2, m2, distinct) in [
            ("shared: N x الله ~10 lemma:قال", "الله", "قال", "lemma", false),
            ("distinct distances: الله ~d lemma:قال", "الله", "قال", "lemma", true),
            ("distinct phrase walks: قال ~d \"رسول الله\"", "قال", "رسول الله", "surface", true),
        ] {
            settle_limiter();
            let v = concurrency_scenario(&c, &base, n, name, t1, t2, m2, distinct, opts.limit)?;
            eprintln!(
                "{:44} first-window p50 {:7.1} ms p95 {:7.1} ms  queued peak {} active peak {}  /health max {:.1} ms  /page max {:.1} ms  peak rss {:.0} MiB",
                name, v["first_window_ms"]["p50"].as_f64().unwrap_or(0.0), v["first_window_ms"]["p95"].as_f64().unwrap_or(0.0),
                v["walks_queued_peak"], v["walks_active_peak"], v["health_ms_max"].as_f64().unwrap_or(0.0), v["page_ms_max"].as_f64().unwrap_or(0.0), v["peak_rss_mb"].as_f64().unwrap_or(0.0)
            );
            concurrency.push(v);
        }
    }

    let compat = if opts.check_compat {
        settle_limiter();
        Some(check_compat(&c, &base))
    } else {
        None
    };
    let health_after = get_json(&c, &format!("{}/health", base)).unwrap_or(Value::Null);
    let report = RemoteReport { base: base.clone(), health_before, limit: opts.limit, cases: cases_out, concurrency, compat: compat.clone(), health_after };
    let json = serde_json::to_string_pretty(&report)?;
    match &opts.out {
        Some(p) => {
            std::fs::write(p, json)?;
            eprintln!("wrote {:?}", p);
        }
        None => println!("{}", json),
    }
    if let Some(cp) = compat {
        if cp["ok"] != true {
            return Err(anyhow!("compatibility checks failed"));
        }
    }
    Ok(())
}
