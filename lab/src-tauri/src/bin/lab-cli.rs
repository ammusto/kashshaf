//! `lab-cli`: the evaluation hooks of spec §4.3 and §4.4, run against a
//! local corpus directory.
//!
//! ```text
//! lab-cli reuse-eval  [--corpus DIR] [--gold FILE] [--threshold 0.35]
//! lab-cli reuse-find  [--corpus DIR] --book ID [--from PAGE] [--to PAGE] [--min-score 0.35]
//! lab-cli quran-scan  [--corpus DIR] --book ID [--from PAGE] [--to PAGE]
//! ```
//!
//! `--corpus` defaults to `KASHSHAF_SAMPLE_DIR`, then Kashshaf's data
//! directory. `reuse-eval` reports precision and recall at the threshold over
//! the gold pairs (`lab/fixtures/reuse_gold.json` by default): recall is the
//! share of gold pairs whose target page and span Lab finds from the query
//! side; precision is the share of Lab's above-threshold matches for those
//! queries that are gold — a lower bound, since a query may have true reuse
//! the gold does not list. `reuse-find` and `quran-scan` print what Lab finds
//! on a page range, for building and checking the gold sets by hand.

use anyhow::{anyhow, Context, Result};
use kashshaf_lab_lib::analysis::quran::{self, QuranIndex};
use kashshaf_lab_lib::analysis::reuse::{self, Params, Zone};
use kashshaf_lab_lib::lexicon;
use kashshaf_lab_lib::quran_data::QuranText;
use kashshaf_lab_lib::source::{local::LocalSource, BookSource, FreqLayer, Page, PageRef};
use kashshaf_lab_lib::store::Store;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone)]
struct Anchor {
    book_id: u64,
    part_index: u32,
    page_id: u64,
    tok_start: usize,
    tok_end: usize,
}

#[derive(Deserialize, Clone)]
struct GoldPair {
    id: u32,
    #[serde(default)]
    note: String,
    #[serde(default)]
    expected_type: Option<String>,
    q: Anchor,
    t: Anchor,
}

#[derive(Deserialize)]
struct Gold {
    pairs: Vec<GoldPair>,
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn index_dir(dir: &Path) -> PathBuf {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join("tantivy_index"))
}

fn corpus_dir(args: &[String]) -> Result<PathBuf> {
    if let Some(d) = arg(args, "--corpus") {
        return Ok(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("KASHSHAF_SAMPLE_DIR") {
        return Ok(PathBuf::from(d));
    }
    kashshaf_common::resolve_data_dir().map(|(p, _)| p).map_err(|e| anyhow!("no corpus: {}", e))
}

fn text_of(page: &Page, a: usize, b: usize) -> String {
    page.tokens[a.min(page.tokens.len())..b.min(page.tokens.len())].iter().map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ")
}

struct Ctx {
    source: LocalSource,
    freq: std::sync::Arc<kashshaf_lab_lib::source::FreqTable>,
    params: Params,
    lex: lexicon::Lexicon,
    quran: Option<(QuranText, QuranIndex)>,
}

impl Ctx {
    fn open(args: &[String]) -> Result<Self> {
        let dir = corpus_dir(args)?;
        let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).with_context(|| format!("opening {}", dir.display()))?;
        let freq = source.freq_table(FreqLayer::Lemma).map_err(|e| anyhow!("{}", e))?;
        let mut params = Params::default();
        if let Some(t) = arg(args, "--threshold").or_else(|| arg(args, "--min-score")) {
            params.threshold = t.parse().context("--threshold")?;
        }
        if let Some(r) = arg(args, "--banality-rank") {
            params.banality_rank = r.parse().context("--banality-rank")?;
        }
        if let Some(r) = arg(args, "--count-budget") {
            params.count_budget = r.parse().context("--count-budget")?;
        }
        if let Some(r) = arg(args, "--anchors") {
            params.anchors = r.parse().context("--anchors")?;
        }
        if args.iter().any(|a| a == "--anchor-zones") {
            params.exclude_zones_from_anchoring = false;
        }
        if let Some(r) = arg(args, "--rare-df") {
            params.rare_df = r.parse().context("--rare-df")?;
        }
        params.banality_baseline = Some(reuse::corpus_banal_share(&freq, params.banality_rank));
        let lab_dir = kashshaf_common::lab_data_dir()?;
        let store = Store::open(&lab_dir)?;
        let conn = store.connect()?;
        let lex = lexicon::load(&conn)?;
        let quran = match QuranText::load(&lab_dir) {
            Ok(t) => {
                let i = QuranIndex::build(&t);
                Some((t, i))
            }
            Err(e) => {
                eprintln!("[lab-cli] Qurʾān unavailable: {}", e);
                None
            }
        };
        Ok(Self { source, freq, params, lex, quran })
    }

    fn zones(&self, page: &Page) -> Vec<Option<Zone>> {
        let n = page.tokens.len();
        let mut z = vec![None; n];
        if let Some((t, i)) = &self.quran {
            for h in quran::detect_page(i, t, &page.tokens, &page.body, Some(&self.freq), &quran::Params::default()) {
                for x in h.tok_start..h.tok_end.min(n) {
                    z[x] = Some(Zone::Quran);
                }
            }
        }
        let no = HashMap::new();
        for c in kashshaf_lab_lib::analysis::isnad::extract_page(&page.tokens, &page.body, &self.lex, &Default::default(), &no) {
            if c.confidence.total >= 0.6 {
                for x in c.tok_start..c.tok_end.min(n) {
                    if z[x].is_none() {
                        z[x] = Some(Zone::Isnad);
                    }
                }
            }
        }
        z
    }

    fn passage(&self, page: &Page, a: usize, b: usize, exclude_book: Option<u64>) -> Result<reuse::PassageRun> {
        let zones = self.zones(page);
        let load = |r: &PageRef| self.source.page(r.book_id, r.part_index, r.page_id);
        let count = |t: &[String]| reuse::phrase_df(&self.source, t);
        reuse::passage(&self.source, &self.freq, &self.params, &[], page, a..b, &zones, exclude_book, &count, &load, &|| false)
    }
}

fn reuse_eval(args: &[String]) -> Result<()> {
    let ctx = Ctx::open(args)?;
    let gold_path = arg(args, "--gold").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/reuse_gold.json"));
    let gold: Gold = serde_json::from_str(&std::fs::read_to_string(&gold_path).with_context(|| gold_path.display().to_string())?)?;
    let t = ctx.params.threshold;
    println!("reuse-eval: {} gold pairs, threshold {:.2}, banality rank {} (baseline {:.3}), corpus {}", gold.pairs.len(), t, ctx.params.banality_rank, ctx.params.banality_baseline.unwrap_or(0.0), ctx.source.corpus_version());
    let mut found = 0usize;
    let mut found_any = 0usize;
    let mut above = 0usize;
    let mut above_gold = 0usize;
    let mut types: HashMap<String, usize> = HashMap::new();
    let mut type_agree = 0usize;
    let mut typed = 0usize;
    let mut zones: HashMap<String, usize> = HashMap::new();
    let started = std::time::Instant::now();
    for g in &gold.pairs {
        let Some(page) = ctx.source.page(g.q.book_id, g.q.part_index, g.q.page_id)? else {
            println!("  #{:2} MISSING query page {}:{}:{}", g.id, g.q.book_id, g.q.part_index, g.q.page_id);
            continue;
        };
        let run = ctx.passage(&page, g.q.tok_start, g.q.tok_end, None)?;
        let hit = run.matches.iter().find(|m| {
            m.target.book_id == g.t.book_id && m.target.part_index == g.t.part_index && m.target.page_id == g.t.page_id && m.t_start < g.t.tok_end && g.t.tok_start < m.t_end
        });
        let n_above = run.matches.iter().filter(|m| m.score >= t).count();
        above += n_above;
        match hit {
            Some(m) => {
                found_any += 1;
                let ok = m.score >= t;
                if ok {
                    found += 1;
                    above_gold += 1;
                }
                *types.entry(m.kind.as_str().to_string()).or_insert(0) += 1;
                if let Some(z) = m.zone {
                    *zones.entry(z.as_str().to_string()).or_insert(0) += 1;
                }
                if let Some(e) = &g.expected_type {
                    typed += 1;
                    if e == m.kind.as_str() {
                        type_agree += 1;
                    }
                }
                println!(
                    "  #{:2} {} score {:.3} {:<10} cov {:.2} lem {:.2} root {:.2} surf {:.2} banal {:.2}→{:.2} aligned {:>3} zone {:<5} anchors {} cands {} {}",
                    g.id,
                    if ok { "FOUND" } else { "below" },
                    m.score,
                    m.kind.as_str(),
                    m.components.coverage,
                    m.components.lemma_agree,
                    m.components.root_agree,
                    m.components.surface_agree,
                    m.components.banal_share,
                    m.components.banality_factor,
                    m.components.aligned,
                    m.zone.map(|z| z.as_str()).unwrap_or("-"),
                    run.anchors.len(),
                    run.candidates,
                    g.note
                );
            }
            None => {
                let best = run.matches.first();
                println!(
                    "  #{:2} MISS  anchors {} ({}) cands {} matches {} best {} {}",
                    g.id,
                    run.anchors.len(),
                    run.fallback.unwrap_or("-"),
                    run.candidates,
                    run.matches.len(),
                    best.map(|m| format!("{:.3} → {}:{}:{}", m.score, m.target.book_id, m.target.part_index, m.target.page_id)).unwrap_or_else(|| "-".into()),
                    g.note
                );
            }
        }
    }
    let n = gold.pairs.len().max(1) as f64;
    println!();
    println!("recall@{:.2}: {}/{} = {:.3}   (target found at any score: {}/{} = {:.3})", t, found, gold.pairs.len(), found as f64 / n, found_any, gold.pairs.len(), found_any as f64 / n);
    println!("precision@{:.2} (lower bound): {}/{} = {:.3}", t, above_gold, above, if above == 0 { 0.0 } else { above_gold as f64 / above as f64 });
    let mut tv: Vec<_> = types.into_iter().collect();
    tv.sort();
    println!("types of found pairs: {:?}", tv);
    if typed > 0 {
        println!("expected type agreement: {}/{}", type_agree, typed);
    }
    let mut zv: Vec<_> = zones.into_iter().collect();
    zv.sort();
    println!("zones: {:?}", zv);
    println!("elapsed {} ms ({} ms per query)", started.elapsed().as_millis(), started.elapsed().as_millis() / gold.pairs.len().max(1) as u128);
    Ok(())
}

fn page_range(args: &[String], source: &LocalSource, book: u64) -> Result<Vec<PageRef>> {
    let refs = source.page_refs(book)?;
    let from: usize = arg(args, "--from").map(|s| s.parse()).transpose()?.unwrap_or(0);
    let to: usize = arg(args, "--to").map(|s| s.parse()).transpose()?.unwrap_or(refs.len());
    Ok(refs.into_iter().skip(from).take(to.saturating_sub(from)).collect())
}

fn reuse_find(args: &[String]) -> Result<()> {
    let ctx = Ctx::open(args)?;
    let book: u64 = arg(args, "--book").ok_or_else(|| anyhow!("--book ID"))?.parse()?;
    let exclude_same = args.iter().any(|a| a == "--exclude-same-book");
    let limit: usize = arg(args, "--limit").map(|s| s.parse()).transpose()?.unwrap_or(5);
    let p = &ctx.params;
    for r in page_range(args, &ctx.source, book)? {
        let Some(page) = ctx.source.page(r.book_id, r.part_index, r.page_id)? else { continue };
        for w in reuse::windows(page.tokens.len(), p.window, p.stride, p.min_aligned) {
            let run = ctx.passage(&page, w.start, w.end, if exclude_same { Some(book) } else { None })?;
            for m in run.matches.iter().filter(|m| m.score >= p.threshold).take(limit) {
                let Some(tp) = ctx.source.page(m.target.book_id, m.target.part_index, m.target.page_id)? else { continue };
                let title = ctx.source.book(m.target.book_id)?.map(|b| b.title).unwrap_or_default();
                println!(
                    "Q {}:{}:{} [{}..{}]  →  T {}:{}:{} [{}..{}]  score {:.3} {} cov {:.2} lem {:.2} surf {:.2} banal {:.2} zone {}  {}",
                    page.book_id, page.part_index, page.page_id, m.q_start, m.q_end,
                    m.target.book_id, m.target.part_index, m.target.page_id, m.t_start, m.t_end,
                    m.score, m.kind.as_str(), m.components.coverage, m.components.lemma_agree, m.components.surface_agree, m.components.banal_share,
                    m.zone.map(|z| z.as_str()).unwrap_or("-"), title
                );
                println!("   q: {}", text_of(&page, m.q_start, m.q_end));
                println!("   t: {}", text_of(&tp, m.t_start, m.t_end));
            }
        }
    }
    Ok(())
}

fn quran_scan(args: &[String]) -> Result<()> {
    let ctx = Ctx::open(args)?;
    let (qt, qi) = ctx.quran.as_ref().ok_or_else(|| anyhow!("the Qurʾān is not available"))?;
    let book: u64 = arg(args, "--book").ok_or_else(|| anyhow!("--book ID"))?.parse()?;
    let mut total = 0usize;
    for r in page_range(args, &ctx.source, book)? {
        let Some(page) = ctx.source.page(r.book_id, r.part_index, r.page_id)? else { continue };
        let hits = quran::detect_page(qi, qt, &page.tokens, &page.body, Some(&ctx.freq), &quran::Params::default());
        for h in &hits {
            total += 1;
            let name = qt.sura(h.sura).map(|s| s.name.clone()).unwrap_or_default();
            println!(
                "{}:{}:{} [{}..{}] {} {}:{}-{} aligned {} lem {:.2} surf {:.2} cue {}  | {}",
                page.book_id, page.part_index, page.page_id, h.tok_start, h.tok_end, name, h.sura, h.aya_start, h.aya_end, h.aligned, h.lemma_agree, h.surface_agree,
                h.cue.as_deref().unwrap_or("-"), text_of(&page, h.tok_start, h.tok_end)
            );
        }
    }
    println!("{} quotations", total);
    Ok(())
}

/// Build the frequency snapshot the way the app does (spec 1.4, fix 4) and
/// report the time: `lab-cli freq-build [--corpus DIR] [--out DIR]`.
fn freq_build(args: &[String]) -> Result<()> {
    let dir = corpus_dir(args)?;
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).with_context(|| format!("opening {}", dir.display()))?;
    let ids: Vec<u64> = source.books()?.into_iter().map(|b| b.id).collect();
    let started = std::time::Instant::now();
    let last = std::sync::Mutex::new(std::time::Instant::now());
    let progress = |done: u64, total: u64| {
        let mut l = last.lock().unwrap();
        if l.elapsed().as_secs() >= 5 || done == total {
            eprintln!("  {}/{} books, {} s", done, total, started.elapsed().as_secs());
            *l = std::time::Instant::now();
        }
    };
    let built = kashshaf_lab_lib::source::freq::build_from_corpus(source.token_cache(), source.corpus_db(), &ids, source.corpus_version(), &progress, &|| false)?
        .ok_or_else(|| anyhow!("cancelled"))?;
    let ms = started.elapsed().as_millis();
    println!("built {} lemmas / {} roots over {} books ({} tokens) in {} ms", built.0.len(), built.1.len(), ids.len(), built.0.total, ms);
    if let Some(out) = arg(args, "--out") {
        let out = PathBuf::from(out);
        std::fs::create_dir_all(&out)?;
        built.0.write(&out.join("lemma_freq.bin"))?;
        built.1.write(&out.join("root_freq.bin"))?;
        println!("wrote {}", out.display());
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("freq-build") => freq_build(&args[1..]),
        Some("reuse-eval") => reuse_eval(&args[1..]),
        Some("reuse-find") => reuse_find(&args[1..]),
        Some("quran-scan") => quran_scan(&args[1..]),
        _ => {
            eprintln!("usage: lab-cli reuse-eval|reuse-find|quran-scan [options]  (see the module doc)");
            std::process::exit(2);
        }
    }
}
