//! `lab-cli`: the evaluation hooks of spec §4.3 and §4.4, run against a
//! local corpus directory.
//!
//! ```text
//! lab-cli reuse-eval  [--corpus DIR] [--gold FILE] [--threshold 0.35]
//! lab-cli reuse-find  [--corpus DIR] --book ID [--from PAGE] [--to PAGE] [--min-score 0.35]
//!                     [--target-book ID] [--pairwise] [--target-neighbours N] [--jsonl FILE]
//!                     [--anchor-slots 3:4:500,2:4:200]
//!                     [--window N] [--stride N] [--min-aligned N] [--fallback-max-tokens N]
//!                     [--include-formulaic]
//! lab-cli quran-scan  [--corpus DIR] --book ID [--from PAGE] [--to PAGE]
//! lab-cli reuse-trace [--corpus DIR] --book ID --spans FILE [--rare-one-df N] [--jsonl FILE]
//! lab-cli isnad-scan  [--corpus DIR] --book ID [--from PAGE] [--to PAGE] [--groups core,sama,…] [--show] [--jsonl FILE]
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
    /// Candidate pages and book page lists, so spanning does not re-read a
    /// neighbour once per candidate.
    pages: std::cell::RefCell<HashMap<(u64, u32, u64), Option<Page>>>,
    refs: std::cell::RefCell<HashMap<u64, Vec<PageRef>>>,
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
        // A single-key experiment: --anchor-gram / --anchor-skip mean one
        // key, so they clear the two the default now carries.
        if args.iter().any(|a| a == "--anchor-gram" || a == "--anchor-skip") {
            params.anchor_slots.clear();
        }
        for (flag, slot) in [("--anchor-gram", 0), ("--anchor-df-cap", 1)] {
            if let Some(r) = arg(args, flag) {
                let v: usize = r.parse().with_context(|| flag.to_string())?;
                match slot {
                    0 => params.anchor_gram = v,
                    _ => params.anchor_df_cap = v,
                }
            }
        }
        if let Some(r) = arg(args, "--anchor-slop") {
            params.anchor_slop = r.parse().context("--anchor-slop")?;
        }
        if let Some(r) = arg(args, "--anchor-skip") {
            params.anchor_skip = r.parse().context("--anchor-skip")?;
        }
        // Pairwise: push --target-book into retrieval instead of filtering
        // results afterwards, so the index never leaves the two books.
        if args.iter().any(|a| a == "--pairwise") {
            if let Some(t) = arg(args, "--target-book") {
                params.target_books = vec![t.parse().context("--target-book")?];
            }
        }
        // --anchor-slots 3:4:500,2:4:200 -- gram:anchors:df_cap.
        if let Some(spec) = arg(args, "--anchor-slots") {
            let mut slots = Vec::new();
            for part in spec.split(',').filter(|s| !s.is_empty()) {
                let f: Vec<&str> = part.split(':').collect();
                if f.len() != 3 {
                    return Err(anyhow!("--anchor-slots wants gram:anchors:df_cap, got {:?}", part));
                }
                slots.push(reuse::AnchorSlot { gram: f[0].parse()?, anchors: f[1].parse()?, df_cap: f[2].parse()? });
            }
            params.anchor_slots = slots;
        }
        if let Some(r) = arg(args, "--target-neighbours") {
            params.target_neighbours = r.parse().context("--target-neighbours")?;
        }
        if let Some(r) = arg(args, "--isnad-zone-confidence") {
            params.isnad_zone_confidence = r.parse().context("--isnad-zone-confidence")?;
        }
        if let Some(r) = arg(args, "--rare-df") {
            params.rare_df = r.parse().context("--rare-df")?;
        }
        // The four book-mode settings, so each can be moved on its own.
        if let Some(r) = arg(args, "--window") {
            params.window = r.parse().context("--window")?;
        }
        if let Some(r) = arg(args, "--stride") {
            params.stride = r.parse().context("--stride")?;
        }
        if let Some(r) = arg(args, "--min-aligned") {
            params.min_aligned = r.parse().context("--min-aligned")?;
        }
        if let Some(r) = arg(args, "--fallback-max-tokens") {
            params.fallback_max_tokens = r.parse().context("--fallback-max-tokens")?;
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
        Ok(Self { source, pages: Default::default(), refs: Default::default(), freq, params, lex, quran })
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
            if c.confidence.total >= self.params.isnad_zone_confidence {
                for x in c.tok_start..c.tok_end.min(n) {
                    if z[x].is_none() {
                        z[x] = Some(Zone::Isnad);
                    }
                }
            }
        }
        z
    }

    fn load(&self, r: &PageRef) -> Result<Option<Page>> {
        let key = (r.book_id, r.part_index, r.page_id);
        if let Some(p) = self.pages.borrow().get(&key) {
            return Ok(p.clone());
        }
        let p = self.source.page(r.book_id, r.part_index, r.page_id)?;
        let mut c = self.pages.borrow_mut();
        if c.len() > 5000 {
            c.clear();
        }
        c.insert(key, p.clone());
        Ok(p)
    }

    fn around(&self, r: &PageRef, radius: usize) -> Result<Vec<PageRef>> {
        if !self.refs.borrow().contains_key(&r.book_id) {
            let l = self.source.page_refs(r.book_id).unwrap_or_default();
            self.refs.borrow_mut().insert(r.book_id, l);
        }
        Ok(reuse::span_around(&self.refs.borrow()[&r.book_id], r, radius))
    }

    fn passage(&self, page: &Page, a: usize, b: usize, exclude_book: Option<u64>) -> Result<reuse::PassageRun> {
        let zones = self.zones(page);
        self.passage_over(std::slice::from_ref(page), a..b, &zones, exclude_book)
    }

    /// The same over a run of pages in reading order, which is what a window
    /// cut against the book's token stream needs.
    fn passage_over(&self, pages: &[Page], range: std::ops::Range<usize>, zones: &[Option<Zone>], exclude_book: Option<u64>) -> Result<reuse::PassageRun> {
        let load = |r: &PageRef| self.load(r);
        let around = |r: &PageRef, n: usize| self.around(r, n);
        let count = |t: &[String]| reuse::phrase_df(&self.source, t);
        reuse::passage(&self.source, &self.freq, &self.params, &[], pages, range, zones, exclude_book, &count, &load, &around, &|| false)
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
    // One book to compare against, for a head-to-head with another system.
    // `--pairwise` pushes it into retrieval; without it the search is still
    // the whole corpus and only the matches landing here are reported.
    let only: Option<u64> = arg(args, "--target-book").map(|s| s.parse()).transpose()?;
    let keep_formulaic = args.iter().any(|a| a == "--include-formulaic");
    let mut jsonl = match arg(args, "--jsonl") {
        Some(path) => Some(std::io::BufWriter::new(std::fs::File::create(path)?)),
        None => None,
    };
    let started = std::time::Instant::now();
    let mut found = 0usize;
    let p = &ctx.params;

    // Windows are cut against the book's token stream, not per page, so a
    // first pass reads the page lengths. Matches are then grouped by the page
    // each one starts on, and a page is written out once the windows have
    // moved past it -- a window reaches into the next page, so a page's last
    // match is not known until then.
    let refs = page_range(args, &ctx.source, book)?;
    let mut lens: Vec<usize> = Vec::with_capacity(refs.len());
    for r in &refs {
        lens.push(ctx.load(r)?.map(|x| x.tokens.len()).unwrap_or(0));
    }
    let wins = reuse::stream_windows(&lens, p.window, p.stride, p.min_aligned);
    let mut pending: HashMap<usize, Vec<(PageRef, reuse::Match)>> = HashMap::new();
    let mut zcache: HashMap<usize, Vec<Option<Zone>>> = HashMap::new();
    let mut flushed = 0usize;

    for w in &wins {
        let mut pages: Vec<Page> = Vec::new();
        let mut zones: Vec<Option<Zone>> = Vec::new();
        for pi in w.first_page..=w.last_page {
            let Some(pg) = ctx.load(&refs[pi])? else { continue };
            if !zcache.contains_key(&pi) {
                let z = ctx.zones(&pg);
                zcache.insert(pi, z);
            }
            zones.extend(zcache[&pi].iter().copied());
            pages.push(pg);
        }
        if pages.is_empty() {
            continue;
        }
        let run = ctx.passage_over(&pages, w.range.clone(), &zones, if exclude_same { Some(book) } else { None })?;
        for m in run.matches {
            let pi = (w.first_page..=w.last_page)
                .find(|&k| refs[k].part_index == m.query.part_index && refs[k].page_id == m.query.page_id)
                .unwrap_or(w.first_page);
            pending.entry(pi).or_default().push((m.query, m));
        }
        while flushed < w.first_page {
            emit_page(&ctx, &refs, flushed, &mut pending, &mut found, &mut jsonl, limit, only, keep_formulaic)?;
            flushed += 1;
        }
        zcache.retain(|k, _| *k >= w.first_page);
    }
    for pi in flushed..refs.len() {
        emit_page(&ctx, &refs, pi, &mut pending, &mut found, &mut jsonl, limit, only, keep_formulaic)?;
    }
    if jsonl.is_some() {
        println!("{} matches in {} ms", found, started.elapsed().as_millis());
    }
    Ok(())
}

/// One page's matches, merged and reported. `--limit` is per page, over the
/// merged matches sorted by score, which is what it reads as.
#[allow(clippy::too_many_arguments)]
fn emit_page(
    ctx: &Ctx,
    refs: &[PageRef],
    pi: usize,
    pending: &mut HashMap<usize, Vec<(PageRef, reuse::Match)>>,
    found: &mut usize,
    jsonl: &mut Option<std::io::BufWriter<std::fs::File>>,
    limit: usize,
    only: Option<u64>,
    keep_formulaic: bool,
) -> Result<()> {
    let Some(ms) = pending.remove(&pi) else { return Ok(()) };
    let Some(page) = ctx.load(&refs[pi])? else { return Ok(()) };
    let p = &ctx.params;
    let mut merged = reuse::merge_overlapping(ms);
    merged.sort_by(|a, b| b.1.score.partial_cmp(&a.1.score).unwrap_or(std::cmp::Ordering::Equal));
    for m in merged
        .iter()
        .map(|(_, m)| m)
        .filter(|m| {
            m.score >= p.threshold
                && only.map_or(true, |t| m.target.book_id == t)
                // Formulaic is recorded, not reported -- the panel's type
                // filter leaves it out by default, and a report that included
                // it would not be the one a reader sees.
                && (keep_formulaic || m.kind != reuse::MatchType::Formulaic)
        })
        .take(limit)
    {
        *found += 1;
        if let Some(w) = jsonl.as_mut() {
            use std::io::Write;
            writeln!(
                w,
                "{}",
                serde_json::json!({
                    "q_book": page.book_id, "q_part": page.part_index, "q_page": page.page_id,
                    "q_end_part": m.query_end.map(|x| x.part_index), "q_end_page": m.query_end.map(|x| x.page_id),
                    "q_start": m.q_start, "q_end": m.q_end,
                    "t_book": m.target.book_id, "t_part": m.target.part_index, "t_page": m.target.page_id,
                    "t_end_part": m.target_end.map(|x| x.part_index), "t_end_page": m.target_end.map(|x| x.page_id),
                    "t_start": m.t_start, "t_end": m.t_end,
                    "score": m.score, "kind": m.kind.as_str(), "zone": m.zone.map(|z| z.as_str()),
                    "coverage": m.components.coverage,
                    "lemma_agree": m.components.lemma_agree,
                    "root_agree": m.components.root_agree,
                    "surface_agree": m.components.surface_agree,
                    "banal_share": m.components.banal_share,
                    "aligned": m.components.aligned,
                })
            )?;
            continue;
        }
        let Some(tp) = ctx.source.page(m.target.book_id, m.target.part_index, m.target.page_id)? else { continue };
        let title = ctx.source.book(m.target.book_id)?.map(|b| b.title).unwrap_or_default();
        println!(
            "Q {}:{}:{} [{}..{}]  \u{2192}  T {}:{}:{} [{}..{}]  score {:.3} {} cov {:.2} lem {:.2} surf {:.2} banal {:.2} zone {}  {}",
            page.book_id, page.part_index, page.page_id, m.q_start, m.q_end,
            m.target.book_id, m.target.part_index, m.target.page_id, m.t_start, m.t_end,
            m.score, m.kind.as_str(), m.components.coverage, m.components.lemma_agree, m.components.surface_agree, m.components.banal_share,
            m.zone.map(|z| z.as_str()).unwrap_or("-"), title
        );
        println!("   q: {}", text_of(&page, m.q_start, m.q_end));
        println!("   t: {}", text_of(&tp, m.t_start, m.t_end));
    }
    Ok(())
}

/// Where a passage somebody else found is lost.
///
/// `--spans FILE` is one tab-separated row per passage:
/// `part page tok_start tok_end t_part t_page t_tok_start t_tok_end text`.
/// For each, this reports the window that covers it, the anchors chosen from
/// that window with their phrase document frequencies, whether the target
/// page became a candidate and on how many anchor hits, and -- when it did --
/// the best local alignment on it and which gate turned it away.
///
/// `--rare-one-df N` re-asks retrieval with `rare_df = N`, which promotes a
/// page on a single hit of an anchor that rare. Note the default is already
/// 50; a smaller number promotes fewer pages, not more.
fn reuse_trace(args: &[String]) -> Result<()> {
    let ctx = Ctx::open(args)?;
    let book: u64 = arg(args, "--book").ok_or_else(|| anyhow!("--book ID"))?.parse()?;
    let spans_path = arg(args, "--spans").ok_or_else(|| anyhow!("--spans FILE"))?;
    let rare_one: Option<usize> = arg(args, "--rare-one-df").map(|s| s.parse()).transpose()?;
    let mut out = match arg(args, "--jsonl") {
        Some(p) => Some(std::io::BufWriter::new(std::fs::File::create(p)?)),
        None => None,
    };
    let p = &ctx.params;
    let text = std::fs::read_to_string(&spans_path)?;

    for (row, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 8 {
            continue;
        }
        let (qpart, qpage): (u32, u64) = (f[0].parse()?, f[1].parse()?);
        let (qa, qb): (usize, usize) = (f[2].parse()?, f[3].parse()?);
        let (tpart, tpage): (u32, u64) = (f[4].parse()?, f[5].parse()?);
        let want = PageRef { book_id: 0, part_index: tpart, page_id: tpage };

        let Some(page) = ctx.source.page(book, qpart, qpage)? else {
            eprintln!("row {}: no page {}:{}", row, qpart, qpage);
            continue;
        };
        // The window Lab would have used: the one covering most of the span.
        let ws = reuse::windows(page.tokens.len(), p.window, p.stride, p.min_aligned);
        let w = ws
            .iter()
            .max_by_key(|w| w.end.min(qb).saturating_sub(w.start.max(qa)))
            .cloned()
            .unwrap_or(0..page.tokens.len());

        let zones = ctx.zones(&page);
        let mut intern = reuse::Interner::default();
        let tokens = &page.tokens[w.clone()];
        let page_zones: Vec<Option<Zone>> = w.clone().map(|i| zones.get(i).copied().flatten()).collect();
        let q = reuse::Seq::build(tokens, &mut intern, &ctx.freq, p, &[], &page_zones);
        let non_banal = q.non_banal();
        let own = PageRef { book_id: page.book_id, part_index: page.part_index, page_id: page.page_id };
        let count = |t: &[String]| reuse::phrase_df(&ctx.source, t);
        let anchors = reuse::anchors(&q, tokens, p, &count)?;

        let mut pr = p.clone();
        if let Some(n) = rare_one {
            pr.rare_df = n;
        }
        let cands = if anchors.is_empty() {
            Vec::new()
        } else {
            reuse::candidates(&ctx.source, &anchors, std::slice::from_ref(&own), None, non_banal, &pr)?
        };
        let hit = cands.iter().find(|c| c.page.part_index == want.part_index && c.page.page_id == want.page_id && c.page.book_id != book);

        // Did any single anchor reach that page at all?
        let mut anchor_hits: Vec<(String, usize, bool, usize)> = Vec::new();
        for a in &anchors {
            let cq = kashshaf_lab_lib::source::CandidateQuery { layer: kashshaf_lab_lib::source::Layer::Lemma, terms: a.terms.clone(), limit: pr.max_candidates.max(1), slop: a.slop, book_ids: pr.book_filter() };
            let probe = match ctx.source.find_pages(&cq) {
                Ok(h) => h,
                Err(_) if a.slop > 0 => ctx.source.find_pages(&kashshaf_lab_lib::source::CandidateQuery { slop: 0, ..cq.clone() })?,
                Err(e) => return Err(e),
            };
            let reached = probe
                .pages
                .iter()
                .any(|x| x.part_index == want.part_index && x.page_id == want.page_id && x.book_id != book);
            anchor_hits.push((a.terms.join(" "), a.df, reached, a.start));
        }

        let mut cause = "retrieval: no anchor reaches the page";
        let mut aligned = 0usize;
        let mut score = 0.0f64;
        let mut kind = String::new();
        if anchor_hits.iter().any(|(_, _, r, _)| *r) && hit.is_none() {
            cause = "retrieval: anchors reach it but it is not promoted";
        }
        if let Some(c) = hit {
            let Some(tp) = ctx.source.page(c.page.book_id, c.page.part_index, c.page.page_id)? else { continue };
            let refs = if p.target_neighbours > 0 { ctx.around(&c.page, p.target_neighbours)? } else { vec![c.page] };
            let load = |r: &kashshaf_lab_lib::source::PageRef| ctx.load(r);
            let Some(span) = reuse::TargetSpan::load(&refs, &c.page, &load)? else { continue };
            let _ = tp;
            let t = reuse::Seq::build(&span.tokens, &mut intern, &ctx.freq, p, &[], &[]);
            let all = reuse::align_all_upto(&q, &t, p, reuse::MAX_ALIGNMENTS_PER_PAGE * span.pages.len());
            match all.first() {
                None => cause = "alignment: nothing reaches min_aligned",
                Some(a) => {
                    let lo = a.pairs.iter().map(|x| x.0).min().unwrap();
                    let hi = a.pairs.iter().map(|x| x.0).max().unwrap() + 1;
                    let nb = q.banal[lo..hi].iter().filter(|b| !**b).count().max(1);
                    let comp = reuse::components(&q, &t, &a.pairs, nb, p);
                    let zone = reuse::zone_of(&q, &a.pairs);
                    aligned = comp.aligned;
                    score = reuse::score(&comp, p);
                    let k = reuse::match_type_in(&comp, zone, p);
                    kind = k.as_str().to_string();
                    cause = if k == reuse::MatchType::Formulaic {
                        "typing: formulaic, withheld"
                    } else if score < p.threshold {
                        "alignment: score below threshold"
                    } else {
                        "found"
                    };
                }
            }
        }

        let record = serde_json::json!({
            "row": row,
            "q": format!("{}:{} [{}..{})", qpart, qpage, qa, qb),
            "window": format!("{}..{}", w.start, w.end),
            "target": format!("{}:{}", tpart, tpage),
            "candidate": hit.is_some(),
            "candidate_hits": hit.map(|c| c.hits).unwrap_or(0),
            "candidates": cands.len(),
            "anchors": anchor_hits.iter().map(|(t, d, r, st)| serde_json::json!({
                "terms": t, "df": d, "reaches": r, "start": st,
                // Does this anchor sit on the passage somebody else found,
                // or elsewhere in the window that retrieved it?
                "on_passage": *st + w.start + 2 >= qa && *st + w.start < qb,
            })).collect::<Vec<_>>(),
            "aligned": aligned,
            "score": score,
            "kind": kind,
            "cause": cause,
            "text": f.get(8).copied().unwrap_or(""),
        });
        println!("{:2}  {:<20} {:<9} cand={:<5} hits={} aligned={:<3} score={:.3} {}", row, record["q"].as_str().unwrap(), record["target"].as_str().unwrap(), hit.is_some(), record["candidate_hits"], aligned, score, cause);
        if let Some(w) = out.as_mut() {
            use std::io::Write;
            writeln!(w, "{}", record)?;
        }
    }
    Ok(())
}

/// What the isnād extractor finds in a book, in numbers.
///
/// Chains, their links, how much of the text they cover and at what
/// confidence -- enough to see what a lexicon change does to a genre the
/// gold set does not cover. `--groups` overrides the enabled groups
/// (`core,history,written,citation,sama`), so before and after are one flag
/// apart.
fn isnad_scan(args: &[String]) -> Result<()> {
    let ctx = Ctx::open(args)?;
    let book: u64 = arg(args, "--book").ok_or_else(|| anyhow!("--book ID"))?.parse()?;
    let mut params = kashshaf_lab_lib::analysis::isnad::Params::default();
    if let Some(g) = arg(args, "--groups") {
        params.groups = g
            .split(',')
            .filter(|x| !x.is_empty())
            .map(|x| lexicon::Group::parse(x).ok_or_else(|| anyhow!("unknown group {:?}", x)))
            .collect::<Result<Vec<_>>>()?;
    }
    let show = args.iter().any(|a| a == "--show");
    // Every chain's confidence components, to ask whether the formula's
    // weights suit a genre the gold set does not cover.
    let mut jsonl = match arg(args, "--jsonl") {
        Some(path) => Some(std::io::BufWriter::new(std::fs::File::create(path)?)),
        None => None,
    };
    let mut pages = 0usize;
    let mut tokens = 0usize;
    let mut chains = 0usize;
    let mut confident = 0usize;
    let mut covered = 0usize;
    let mut links: std::collections::BTreeMap<usize, usize> = Default::default();
    let mut conf_sum = 0.0f64;
    let started = std::time::Instant::now();
    for r in page_range(args, &ctx.source, book)? {
        let Some(page) = ctx.source.page(r.book_id, r.part_index, r.page_id)? else { continue };
        pages += 1;
        tokens += page.tokens.len();
        let no = HashMap::new();
        for c in kashshaf_lab_lib::analysis::isnad::extract_page(&page.tokens, &page.body, &ctx.lex, &params, &no) {
            chains += 1;
            conf_sum += c.confidence.total;
            *links.entry(c.links.min(9)).or_insert(0) += 1;
            if c.confidence.total >= 0.6 {
                confident += 1;
                covered += c.tok_end.saturating_sub(c.tok_start);
            }
            if let Some(w) = jsonl.as_mut() {
                use std::io::Write;
                writeln!(
                    w,
                    "{}",
                    serde_json::json!({
                        "part": page.part_index, "page": page.page_id,
                        "start": c.tok_start, "end": c.tok_end, "kind": format!("{:?}", c.kind),
                        "links": c.links,
                        "links_score": c.confidence.links,
                        "noun_prop": c.confidence.noun_prop,
                        "terminal": c.confidence.terminal,
                        "clean": c.confidence.clean,
                        "total": c.confidence.total,
                        "text": text_of(&page, c.tok_start, c.tok_end.min(c.tok_start + 40)),
                    })
                )?;
            }
            if show {
                println!(
                    "  {}:{} [{}..{}) {} links conf {:.2} matn {:?}  «{}»",
                    page.part_index, page.page_id, c.tok_start, c.tok_end, c.links, c.confidence.total, c.matn.map(|m| m.0),
                    text_of(&page, c.tok_start, c.tok_end).chars().take(150).collect::<String>()
                );
            }
        }
    }
    let groups: Vec<&str> = params.groups.iter().map(|g| g.as_str()).collect();
    println!("book {} groups [{}]", book, groups.join(","));
    println!("  {} pages, {} tokens, {} ms", pages, tokens, started.elapsed().as_millis());
    println!("  {} chains ({:.2} per page), {} at confidence >= 0.6", chains, chains as f64 / pages.max(1) as f64, confident);
    println!("  mean confidence {:.3}; confident chains cover {} tokens ({:.1}% of the book)", conf_sum / chains.max(1) as f64, covered, 100.0 * covered as f64 / tokens.max(1) as f64);
    let hist: Vec<String> = links.iter().map(|(k, v)| format!("{}:{}", k, v)).collect();
    println!("  links {}", hist.join(" "));
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
        Some("reuse-trace") => reuse_trace(&args[1..]),
        Some("isnad-scan") => isnad_scan(&args[1..]),
        Some("quran-scan") => quran_scan(&args[1..]),
        _ => {
            eprintln!("usage: lab-cli reuse-eval|reuse-find|quran-scan [options]  (see the module doc)");
            std::process::exit(2);
        }
    }
}
