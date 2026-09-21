//! The search performance audit's probe: every search path, run as the API
//! runs it (`EngineConfig::api_server()`, limit 250), cold and warm, three
//! runs each, with the engine's stage hooks (`kashshaf_engine::probe`)
//! collected per run — plan, weight, scorer, iteration, the walk's fetch and
//! verify, the positional intersection, the boundary stream, results,
//! highlights, JSON — and the amounts behind them.
//!
//! "Cold" clears the walk cache before the run (the OS page cache and the
//! engine's token and glob caches stay as they are: a server is never colder
//! than that after its first minute). "Warm" repeats the run as is, so a
//! walk-backed query is served from its finished walk. For a walk-backed
//! query the served time is what the API answers in; the walk's own cost to
//! its end is reported beside it.
//!
//!     cargo run --release -p kashshaf-engine --example search_probe -- <data_dir> [section]
//!
//! Sections: all (default), paths, variants, cache, pages, floor.
use kashshaf_engine::probe;
use kashshaf_engine::variants::compute_variants;
use kashshaf_engine::{EngineConfig, ProximityQuery, SearchEngine, SearchFilters, SearchMode, SearchResults, SearchTerm, TokenCache};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

const LIMIT: usize = 250;
const RUNS: usize = 3;

fn term(q: &str, mode: SearchMode) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode }
}
fn s(q: &str) -> SearchTerm {
    term(q, SearchMode::Surface)
}
fn l(q: &str) -> SearchTerm {
    term(q, SearchMode::Lemma)
}
fn r(q: &str) -> SearchTerm {
    term(q, SearchMode::Root)
}

struct Ctx {
    engine: SearchEngine,
    cache: Arc<TokenCache>,
    filters: SearchFilters,
}

type Run = Box<dyn Fn(&Ctx) -> anyhow::Result<SearchResults>>;

struct Case {
    group: &'static str,
    name: String,
    run: Run,
    /// The slot sets behind the query, for the postings-read column.
    sets: Vec<SearchTerm>,
}

fn case(group: &'static str, name: impl Into<String>, sets: Vec<SearchTerm>, run: impl Fn(&Ctx) -> anyhow::Result<SearchResults> + 'static) -> Case {
    Case { group, name: name.into(), run: Box::new(run), sets }
}

#[derive(Default, Clone)]
struct Agg {
    us: BTreeMap<&'static str, u64>,
    amount: BTreeMap<&'static str, u64>,
    by_thread_us: BTreeMap<String, u64>,
}

fn aggregate(entries: Vec<probe::Entry>) -> Agg {
    let mut a = Agg::default();
    for e in entries {
        if e.us > 0 {
            *a.us.entry(e.stage).or_default() += e.us;
            *a.by_thread_us.entry(e.thread.clone()).or_default() += e.us;
        }
        if e.amount > 0 {
            *a.amount.entry(e.stage).or_default() += e.amount;
        }
    }
    a
}

struct Measured {
    served_ms: f64,
    to_end_ms: f64,
    total_hits: usize,
    rows: usize,
    was_capped: bool,
    walk: bool,
    json_ms: f64,
    agg: Agg,
}

fn measure(ctx: &Ctx, c: &Case, cold: bool) -> anyhow::Result<Measured> {
    if cold {
        ctx.engine.clear_walk_cache();
    }
    probe::enable(true);
    let t = Instant::now();
    let r = (c.run)(ctx)?;
    let served = t.elapsed();
    ctx.engine.wait_walks();
    let to_end = t.elapsed();
    let tj = Instant::now();
    let bytes = serde_json::to_vec(&r)?;
    let json = tj.elapsed();
    probe::enable(false);
    let mut agg = aggregate(probe::take());
    agg.amount.insert("json.bytes", bytes.len() as u64);
    Ok(Measured {
        served_ms: served.as_secs_f64() * 1000.0,
        to_end_ms: to_end.as_secs_f64() * 1000.0,
        total_hits: r.total_hits,
        rows: r.results.len(),
        was_capped: r.was_capped.unwrap_or(false),
        walk: r.walk_key.is_some(),
        json_ms: json.as_secs_f64() * 1000.0,
        agg,
    })
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn ms(us: u64) -> String {
    format!("{:.1}", us as f64 / 1000.0)
}

/// The stages worth a column, in order.
const STAGES: &[&str] = &[
    "term_sets", "plan", "walk.key", "weight", "scorer", "iterate", "collect", "walk.wait", "walk.weight", "walk.scorer", "walk.iterate", "walk.fetch", "walk.verify", "walk.total",
    "boundary.wait", "boundary.total", "glob.expand", "results", "results.cross", "highlights", "page.positions", "page.edges",
];
const AMOUNTS: &[&str] = &[
    "iterate.docs", "plan.regex_phrase", "plan.bag_of_words", "plan.slot_ids", "plan.regex_states", "walk.candidates", "walk.hits", "walk.fresh", "walk.reused",
    "pos.cursors", "pos.doc_freq_sum", "pos.doc_freq_min", "pos.co_occurring", "pos.hits", "pos.open_us", "pos.intersect_us", "pos.positions_us",
    "hyb.cursors", "hyb.doc_freq_sum", "hyb.candidates", "hyb.wide_slots", "hyb.open_us", "hyb.intersect_us",
    "boundary.streams", "boundary.hits", "glob.ids", "glob.cache_hit", "results.rows", "highlights.pages", "highlights.sets", "json.bytes",
];

fn report_case(ctx: &Ctx, c: &Case, cold: &[Measured], warm: &[Measured]) {
    let mut cs: Vec<f64> = cold.iter().map(|m| m.served_ms).collect();
    let mut ce: Vec<f64> = cold.iter().map(|m| m.to_end_ms).collect();
    let mut ws: Vec<f64> = warm.iter().map(|m| m.served_ms).collect();
    let mut we: Vec<f64> = warm.iter().map(|m| m.to_end_ms).collect();
    let m0 = &cold[0];
    println!(
        "\n## [{}] {}\n   served cold {:.1} ms (walk to end {:.1}) | warm {:.1} ms (to end {:.1}) | hits {}{} rows {} | walk {} | json {:.2} ms {} KB",
        c.group,
        c.name,
        median(&mut cs),
        median(&mut ce),
        median(&mut ws),
        median(&mut we),
        m0.total_hits,
        if m0.was_capped { "+" } else { "" },
        m0.rows,
        m0.walk,
        m0.json_ms,
        m0.agg.amount.get("json.bytes").copied().unwrap_or(0) / 1024
    );
    // Stage medians, cold and warm.
    let med = |runs: &[Measured], stage: &str| -> Option<f64> {
        let mut v: Vec<f64> = runs.iter().map(|m| m.agg.us.get(stage).copied().unwrap_or(0) as f64 / 1000.0).collect();
        if v.iter().all(|x| *x == 0.0) {
            None
        } else {
            Some(median(&mut v))
        }
    };
    let mut line = String::from("   stages cold/warm ms:");
    for st in STAGES {
        if let (Some(a), b) = (med(cold, st), med(warm, st)) {
            line.push_str(&format!(" {}={:.1}/{:.1}", st, a, b.unwrap_or(0.0)));
        } else if let Some(b) = med(warm, st) {
            line.push_str(&format!(" {}=0.0/{:.1}", st, b));
        }
    }
    println!("{line}");
    let mut line = String::from("   amounts (cold run 1):");
    for am in AMOUNTS {
        if let Some(v) = m0.agg.amount.get(am) {
            line.push_str(&format!(" {}={}", am, v));
        }
    }
    println!("{line}");
    let threads: Vec<String> = m0.agg.by_thread_us.iter().map(|(t, us)| format!("{}={}", t, ms(*us))).collect();
    println!("   time by thread (cold run 1, ms): {}", threads.join(" "));
    if !c.sets.is_empty() {
        // Postings behind each term's slots, and the rarest slot's.
        for t in &c.sets {
            let sets = ctx.engine.probe_term_sets(t);
            let df = ctx.engine.probe_slot_doc_freqs(&sets);
            println!(
                "   slots of {} ({:?}): ids per slot {:?}, doc_freq per slot {:?}, min {}",
                t.query,
                t.mode,
                sets.iter().map(|s| s.len()).collect::<Vec<_>>(),
                df,
                df.iter().min().copied().unwrap_or(0)
            );
        }
    }
}

fn run_cases(ctx: &Ctx, cases: &[Case]) -> anyhow::Result<()> {
    // `KASHSHAF_PROBE_SKIP=a;b` leaves out cases whose name contains a or b.
    let skip: Vec<String> = std::env::var("KASHSHAF_PROBE_SKIP").unwrap_or_default().split(';').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
    // `KASHSHAF_PROBE_ONLY=a;b` runs only cases whose group or name contains a or b.
    let only: Vec<String> = std::env::var("KASHSHAF_PROBE_ONLY").unwrap_or_default().split(';').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
    for c in cases {
        if !only.is_empty() && !only.iter().any(|x| c.name.contains(x.as_str()) || c.group.contains(x.as_str())) {
            continue;
        }
        if skip.iter().any(|x| c.name.contains(x.as_str())) {
            println!("
## [{}] {} — skipped", c.group, c.name);
            continue;
        }
        let mut cold = Vec::new();
        let mut warm = Vec::new();
        for _ in 0..RUNS {
            cold.push(measure(ctx, c, true)?);
        }
        for _ in 0..RUNS {
            warm.push(measure(ctx, c, false)?);
        }
        report_case(ctx, c, &cold, &warm);
    }
    Ok(())
}

fn prox(terms: &[&str], distances: &[usize], ordered: bool, and_terms: &[&str]) -> ProximityQuery {
    ProximityQuery {
        terms: terms.iter().map(|t| s(t)).collect(),
        distances: distances.to_vec(),
        ordered,
        and_terms: and_terms.iter().map(|t| s(t)).collect(),
    }
}

const NAME_FORM: &[&str] = &[
    "اب* منصور معمر بن احمد", "اب* منصور معمر بن احمد الاصبهاني", "اب* منصور معمر بن احمد الحافظ", "اب* منصور معمر بن احمد بن زياد",
    "اب* منصور معمر بن احمد بن زياد الاصبهاني", "اب* منصور معمر بن احمد بن زياد الحافظ", "اب* منصور معمر الاصبهاني", "اب* منصور معمر الحافظ",
    "اب* منصور بن احمد", "اب* منصور بن احمد الاصبهاني", "اب* منصور بن احمد الحافظ", "اب* منصور بن احمد بن زياد", "اب* منصور بن احمد بن زياد الاصبهاني",
    "اب* منصور بن احمد بن زياد الحافظ", "معمر بن احمد بن زياد", "معمر بن احمد بن زياد الاصبهاني", "معمر بن احمد بن زياد الحافظ", "معمر بن احمد الاصبهاني",
    "معمر بن احمد الحافظ",
];

fn paths() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    // single words
    for (mode, mname) in [(SearchMode::Surface, "surface"), (SearchMode::Lemma, "lemma"), (SearchMode::Root, "root")] {
        let words: [(&str, &str); 3] = match mode {
            SearchMode::Root => [("common", "قول"), ("rare", "نصر"), ("worst", "كون")],
            _ => [("common", "قال"), ("rare", "الاصبهاني"), ("worst", "الله")],
        };
        for (kind, w) in words {
            let (w, mode) = (w.to_string(), mode);
            v.push(case("word", format!("{mname} {kind}: {w}"), vec![term(&w, mode)], move |c| c.engine.search(&w, mode, &c.filters, LIMIT, 0)));
        }
    }
    // phrases
    let phrases: [(&str, &str); 6] = [
        ("2 common", "قال رسول"),
        ("2 rare", "معمر بن"),
        ("4 common", "قال رسول الله صلى"),
        ("4 rare", "معمر بن احمد بن"),
        ("8 common", "قال رسول الله صلى الله عليه وسلم من"),
        ("8 rare", "ابو منصور معمر بن احمد بن زياد الاصبهاني"),
    ];
    for (mode, mname) in [(SearchMode::Surface, "surface"), (SearchMode::Lemma, "lemma")] {
        for (kind, p) in phrases {
            let (p, mode) = (p.to_string(), mode);
            v.push(case("phrase", format!("{mname} {kind}: {p}"), vec![term(&p, mode)], move |c| c.engine.search(&p, mode, &c.filters, LIMIT, 0)));
        }
    }
    // wildcard
    for (kind, q) in [("prefix", "أب*"), ("suffix", "*رف"), ("infix", "أح*مد"), ("phrase", "ابن ال*"), ("worst prefix", "ال*"), ("phrase rare", "معمر بن اح*")] {
        let q = q.to_string();
        v.push(case("wildcard", format!("{kind}: {q}"), vec![], move |c| c.engine.wildcard_search(&q, &c.filters, LIMIT, 0)));
    }
    // proximity
    for d in [3usize, 15] {
        for ordered in [false, true] {
            for and in [false, true] {
                let a: &[&str] = if and { &["النبي"] } else { &[] };
                let q2 = prox(&["الله", "قال"], &[d], ordered, a);
                let q3 = prox(&["قال", "رسول", "الله"], &[d, d], ordered, a);
                let label = |n: usize| format!("{n}-term {} d={d}{}", if ordered { "ordered" } else { "unordered" }, if and { " +AND" } else { "" });
                let sets2 = q2.terms.clone();
                let sets3 = q3.terms.clone();
                v.push(case("proximity", label(2), sets2, move |c| c.engine.proximity_chain_search(&q2, &c.filters, LIMIT, 0)));
                v.push(case("proximity", label(3), sets3, move |c| c.engine.proximity_chain_search(&q3, &c.filters, LIMIT, 0)));
            }
        }
    }
    let qr = prox(&["معمر", "زياد"], &[15], false, &[]);
    v.push(case("proximity", "2-term rare unordered d=15", qr.terms.clone(), move |c| c.engine.proximity_chain_search(&qr, &c.filters, LIMIT, 0)));
    // boolean
    let bools: Vec<(&str, Vec<SearchTerm>, Vec<SearchTerm>)> = vec![
        ("AND 2 mixed: قال(s) AND الاصبهاني(l)", vec![s("قال"), l("الاصبهاني")], vec![]),
        ("AND 2 common+rare: الله(s) AND الاصبهاني(s)", vec![s("الله"), s("الاصبهاني")], vec![]),
        ("AND 2 worst: قال(s) AND الله(s)", vec![s("قال"), s("الله")], vec![]),
        ("OR 2 mixed: قال(s) OR الاصبهاني(l)", vec![], vec![s("قال"), l("الاصبهاني")]),
        ("AND 3 mixed: قال(s) رسول(l) نصر(r)", vec![s("قال"), l("رسول"), r("نصر")], vec![]),
        ("OR 3 mixed: منصور(s) معمر(l) نصر(r)", vec![], vec![s("منصور"), l("معمر"), r("نصر")]),
        ("AND 2 phrases: قال رسول(s) AND عبد الله(s)", vec![s("قال رسول"), s("عبد الله")], vec![]),
    ];
    for (name, and, or) in bools {
        let sets: Vec<SearchTerm> = and.iter().chain(or.iter()).cloned().collect();
        v.push(case("boolean", name, sets, move |c| c.engine.combined_search(&and, &or, &c.filters, LIMIT, 0)));
    }
    // names
    let one: Vec<String> = vec!["اب* منصور".to_string()];
    let two: Vec<Vec<String>> = vec![vec!["اب* منصور".to_string()], vec!["معمر بن احمد".to_string()]];
    let form: Vec<String> = NAME_FORM.iter().map(|x| x.to_string()).collect();
    v.push(case("name", "one form, one pattern: اب* منصور", vec![], move |c| c.engine.name_search(&[c.engine.probe_expand(&one)], &c.filters, LIMIT, 0)));
    v.push(case("name", "two forms: اب* منصور AND معمر بن احمد", vec![], move |c| {
        let forms: Vec<Vec<String>> = two.iter().map(|f| c.engine.probe_expand(f)).collect();
        c.engine.name_search(&forms, &c.filters, LIMIT, 0)
    }));
    v.push(case("name", "one form, 19 displayed patterns", vec![], move |c| c.engine.name_search(&[c.engine.probe_expand(&form)], &c.filters, LIMIT, 0)));
    v.extend(variants());
    v
}

/// Variants are a lemma or root search's: the lemma phrase's every surface form.
fn variants() -> Vec<Case> {
    let mut v = Vec::new();
    for (kind, q) in [("common lemma", "قال رسول"), ("rare lemma", "معمر بن احمد"), ("single lemma", "منصور")] {
        let q = q.to_string();
        v.push(case("variants", format!("{kind}: {q}"), vec![], move |c| {
            let vr = compute_variants(&c.engine, &c.cache, &q, SearchMode::Lemma, &c.filters)?;
            Ok(SearchResults {
                query: q.clone(),
                mode: SearchMode::Surface,
                total_hits: vr.variants.len(),
                results: Vec::new(),
                elapsed_ms: vr.elapsed_ms,
                was_capped: None,
                walk_key: None,
                complete: None,
            })
        }));
    }
    v
}

fn floor() -> Vec<Case> {
    let none = "كلمةلاتوجدابدا";
    let mut v = Vec::new();
    let w = none.to_string();
    v.push(case("floor", "word that matches nothing", vec![], move |c| c.engine.search(&w, SearchMode::Surface, &c.filters, LIMIT, 0)));
    let p = format!("{none} {none}");
    v.push(case("floor", "phrase that matches nothing", vec![], move |c| c.engine.search(&p, SearchMode::Surface, &c.filters, LIMIT, 0)));
    let q = prox(&[none, "قال"], &[3], false, &[]);
    v.push(case("floor", "proximity with a term that matches nothing", vec![], move |c| c.engine.proximity_chain_search(&q, &c.filters, LIMIT, 0)));
    let wq = format!("{none}*");
    v.push(case("floor", "wildcard that matches nothing", vec![], move |c| c.engine.wildcard_search(&wq, &c.filters, LIMIT, 0)));
    let (a, b) = (s(none), s("قال"));
    v.push(case("floor", "AND with a term that matches nothing", vec![], move |c| c.engine.combined_search(&[a.clone(), b.clone()], &[], &c.filters, LIMIT, 0)));
    let nm = vec![none.to_string()];
    v.push(case("floor", "name that matches nothing", vec![], move |c| c.engine.name_search(&[c.engine.probe_expand(&nm)], &c.filters, LIMIT, 0)));
    v.push(case("floor", "common word, one result row", vec![], move |c| c.engine.search("قال", SearchMode::Surface, &c.filters, 1, 0)));
    v
}

/// Load-more from the prefix cache: the walk started by offset 0, then
/// offsets 250, 500, 1000 once it has finished.
fn load_more(ctx: &Ctx) -> anyhow::Result<()> {
    println!("\n# load-more from the prefix cache");
    let queries: Vec<(&str, Run)> = vec![
        ("proximity الله ~10 قال", Box::new(|_c: &Ctx| unreachable!())),
        ("wildcard ابن ال*", Box::new(|_c: &Ctx| unreachable!())),
        ("lemma phrase قال رسول الله صلى", Box::new(|_c: &Ctx| unreachable!())),
        ("surface phrase قال رسول الله صلى", Box::new(|_c: &Ctx| unreachable!())),
        ("paged word قال", Box::new(|_c: &Ctx| unreachable!())),
        ("paged AND الله AND الاصبهاني", Box::new(|_c: &Ctx| unreachable!())),
    ];
    for (name, _) in queries {
        ctx.engine.clear_walk_cache();
        let run = |offset: usize| -> anyhow::Result<SearchResults> {
            match name {
                "proximity الله ~10 قال" => ctx.engine.proximity_chain_search(&prox(&["الله", "قال"], &[10], false, &[]), &ctx.filters, LIMIT, offset),
                "wildcard ابن ال*" => ctx.engine.wildcard_search("ابن ال*", &ctx.filters, LIMIT, offset),
                "surface phrase قال رسول الله صلى" => ctx.engine.search("قال رسول الله صلى", SearchMode::Surface, &ctx.filters, LIMIT, offset),
                "paged word قال" => ctx.engine.search("قال", SearchMode::Surface, &ctx.filters, LIMIT, offset),
                "paged AND الله AND الاصبهاني" => ctx.engine.combined_search(&[s("الله"), s("الاصبهاني")], &[], &ctx.filters, LIMIT, offset),
                _ => ctx.engine.search("قال رسول الله صلى", SearchMode::Lemma, &ctx.filters, LIMIT, offset),
            }
        };
        probe::enable(true);
        let t = Instant::now();
        let first = run(0)?;
        let served = t.elapsed().as_secs_f64() * 1000.0;
        ctx.engine.wait_walks();
        let to_end = t.elapsed().as_secs_f64() * 1000.0;
        let a = aggregate(probe::take());
        println!(
            "  {name}: offset 0 served {served:.1} ms, walk to end {to_end:.1} ms, total {}{} walk {} | walk.fresh={} walk.total={} ms",
            first.total_hits,
            if first.was_capped.unwrap_or(false) { "+" } else { "" },
            first.walk_key.is_some(),
            a.amount.get("walk.fresh").copied().unwrap_or(0),
            ms(a.us.get("walk.total").copied().unwrap_or(0))
        );
        for offset in [250usize, 500, 1000] {
            let t = Instant::now();
            let r = run(offset)?;
            let served = t.elapsed().as_secs_f64() * 1000.0;
            let a = aggregate(probe::take());
            println!(
                "    offset {offset}: {served:.1} ms, rows {}, total {} | reused={} wait={} ms key={} ms results={} ms highlights={} ms",
                r.results.len(),
                r.total_hits,
                a.amount.get("walk.reused").copied().unwrap_or(0) + a.amount.get("paged.cache_hit").copied().unwrap_or(0),
                ms(a.us.get("walk.wait").copied().unwrap_or(0)),
                ms(a.us.get("walk.key").copied().unwrap_or(0)),
                ms(a.us.get("results").copied().unwrap_or(0)),
                ms(a.us.get("highlights").copied().unwrap_or(0)),
            );
        }
        probe::enable(false);
    }
    Ok(())
}

/// A realistic sequence: search, load-more three times, click a result,
/// a new search. Which steps hit which cache, and what each costs.
fn cache_sequence(ctx: &Ctx) -> anyhow::Result<()> {
    println!("\n# cache behaviour: search -> load-more x3 -> click result -> new search");
    ctx.engine.clear_walk_cache();
    let stats0 = ctx.engine.walk_stats();
    println!("  walk cache at start: entries {} bytes {}", stats0.prefix_cache_entries, stats0.prefix_cache_bytes);
    let step = |name: &str, f: &dyn Fn() -> anyhow::Result<(usize, usize, bool)>| -> anyhow::Result<()> {
        probe::enable(true);
        let t = Instant::now();
        let (total, rows, walk) = f()?;
        let served = t.elapsed().as_secs_f64() * 1000.0;
        let a = aggregate(probe::take());
        probe::enable(false);
        let st = ctx.engine.walk_stats();
        let mut top: Vec<(&&str, &u64)> = a.us.iter().collect();
        top.sort_by_key(|(_, us)| std::cmp::Reverse(**us));
        let top: Vec<String> = top.iter().take(4).map(|(k, us)| format!("{}={}", k, ms(**us))).collect();
        println!(
            "  {name:<42} {served:>8.1} ms | total {total} rows {rows} walk {walk} | fresh={} reused={} | cache entries {} ({} KB) | {}",
            a.amount.get("walk.fresh").copied().unwrap_or(0),
            a.amount.get("walk.reused").copied().unwrap_or(0),
            st.prefix_cache_entries,
            st.prefix_cache_bytes / 1024,
            top.join(" ")
        );
        Ok(())
    };
    let q = prox(&["الله", "قال"], &[10], false, &[]);
    let first_page: Option<(u64, u64, u64)>;
    step("search: proximity الله ~10 قال", &|| {
        let r = ctx.engine.proximity_chain_search(&q, &ctx.filters, LIMIT, 0)?;
        Ok((r.total_hits, r.results.len(), r.walk_key.is_some()))
    })?;
    {
        let r = ctx.engine.proximity_chain_search(&q, &ctx.filters, 1, 0)?;
        first_page = r.results.first().map(|x| (x.id, x.part_index, x.page_id));
    }
    for offset in [250usize, 500, 750] {
        step(&format!("load-more offset {offset}"), &|| {
            let r = ctx.engine.proximity_chain_search(&q, &ctx.filters, LIMIT, offset)?;
            Ok((r.total_hits, r.results.len(), r.walk_key.is_some()))
        })?;
    }
    if let Some((id, part, page)) = first_page {
        step("click result: page bundle (tokens + matches)", &|| {
            let toks = ctx.cache.get(&kashshaf_engine::PageKey::new(id, part, page))?;
            let m = ctx.engine.get_page_matches(id, part, page, &[s("الله"), s("قال")])?;
            Ok((m.indices.len(), toks.len(), false))
        })?;
        step("click result again (token cache warm)", &|| {
            let toks = ctx.cache.get(&kashshaf_engine::PageKey::new(id, part, page))?;
            let m = ctx.engine.get_page_matches(id, part, page, &[s("الله"), s("قال")])?;
            Ok((m.indices.len(), toks.len(), false))
        })?;
    }
    step("new search: surface phrase قال رسول الله صلى", &|| {
        let r = ctx.engine.search("قال رسول الله صلى", SearchMode::Surface, &ctx.filters, LIMIT, 0)?;
        Ok((r.total_hits, r.results.len(), r.walk_key.is_some()))
    })?;
    step("same search again", &|| {
        let r = ctx.engine.search("قال رسول الله صلى", SearchMode::Surface, &ctx.filters, LIMIT, 0)?;
        Ok((r.total_hits, r.results.len(), r.walk_key.is_some()))
    })?;
    step("first proximity again (cache hit)", &|| {
        let r = ctx.engine.proximity_chain_search(&q, &ctx.filters, LIMIT, 0)?;
        Ok((r.total_hits, r.results.len(), r.walk_key.is_some()))
    })?;
    Ok(())
}

/// `get_page_matches` (the page bundle's highlights and edge marks) for a
/// page with 0, ~5 and 50+ hits of a common word.
fn pages(ctx: &Ctx) -> anyhow::Result<()> {
    println!("\n# page bundle: get_page_matches");
    let r = ctx.engine.search("قال", SearchMode::Surface, &ctx.filters, LIMIT, 0)?;
    let zero = r.results.first().map(|x| (x.id, x.part_index, x.page_id));
    let mut with5: Option<(u64, u64, u64)> = None;
    let mut with50: Option<(u64, u64, u64)> = None;
    // Pages dense in the word sit deeper into the corpus than the first window.
    'find: for offset in (0..20_000).step_by(LIMIT) {
        let r = ctx.engine.search("قال", SearchMode::Surface, &ctx.filters, LIMIT, offset)?;
        for x in &r.results {
            let n = ctx.engine.get_match_positions_combined(x.id, x.part_index, x.page_id, &[s("قال")])?.len();
            if (3..=8).contains(&n) && with5.is_none() {
                with5 = Some((x.id, x.part_index, x.page_id));
            }
            if n >= 50 && with50.is_none() {
                with50 = Some((x.id, x.part_index, x.page_id));
            }
            if with5.is_some() && with50.is_some() {
                break 'find;
            }
        }
    }
    for (label, page, terms) in [
        ("0 hits (a term not on the page)", zero, vec![s("كلمةلاتوجدابدا")]),
        ("~5 hits", with5, vec![s("قال")]),
        ("50+ hits", with50, vec![s("قال")]),
        ("50+ hits, a two-word phrase (edge check runs)", with50, vec![s("قال رسول")]),
    ] {
        let Some((id, part, page)) = page else {
            println!("  {label}: no such page found");
            continue;
        };
        let mut times = Vec::new();
        let mut a = Agg::default();
        for i in 0..6 {
            probe::enable(true);
            let t = Instant::now();
            let m = ctx.engine.get_page_matches(id, part, page, &terms)?;
            let dt = t.elapsed().as_secs_f64() * 1000.0;
            let ag = aggregate(probe::take());
            probe::enable(false);
            if i == 0 {
                a = ag;
                println!("  {label}: {} positions, continues {}/{}", m.indices.len(), m.continues_prev, m.continues_next);
            }
            times.push(dt);
        }
        println!(
            "    first {:.2} ms, then median {:.2} ms | positions={} ms edges={} ms",
            times[0],
            median(&mut times[1..].to_vec()),
            ms(a.us.get("page.positions").copied().unwrap_or(0)),
            ms(a.us.get("page.edges").copied().unwrap_or(0))
        );
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let section = args.next().unwrap_or_else(|| "all".to_string());
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&db), EngineConfig::api_server())?;
    let cache = Arc::new(TokenCache::new(db, 100_000)?);
    engine.set_token_cache(cache.clone());
    // `KASHSHAF_PHRASE_IMPL=tantivy` for the before-numbers of finding 1.
    if std::env::var("KASHSHAF_PHRASE_IMPL").map(|v| v == "tantivy").unwrap_or(false) {
        engine.set_phrase_impl(kashshaf_engine::PhraseImpl::Tantivy);
    }
    println!("boundary index: {}, segments: {}, reading order: {}, phrase impl: {:?}", engine.has_boundary_index(), engine.segment_count(), engine.reading_order(), engine.phrase_impl());
    let ctx = Ctx { engine, cache, filters: SearchFilters::default() };
    // One throwaway query so the index's first touch is not charged to a case.
    let _ = ctx.engine.search("قال", SearchMode::Surface, &ctx.filters, 1, 0)?;

    if section == "all" || section == "floor" {
        println!("\n# floor");
        run_cases(&ctx, &floor())?;
    }
    if section == "all" || section == "paths" {
        println!("\n# paths");
        run_cases(&ctx, &paths())?;
    }
    if section == "variants" {
        println!("\n# variants");
        run_cases(&ctx, &variants())?;
    }
    if section == "all" || section == "cache" {
        load_more(&ctx)?;
        cache_sequence(&ctx)?;
    }
    if section == "all" || section == "pages" {
        pages(&ctx)?;
    }
    Ok(())
}
