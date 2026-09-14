//! What "banal by lemma rank ≤ 300" (spec §4.3) actually covers in the
//! corpus: the share of running text those lemmas make up, page by page and
//! in the gold isnād chains, and where the basmala and the transmission
//! formulae sit in the ranking. This is the evidence behind the banality
//! penalty's baseline (`analysis/reuse.rs`).
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` (frequency snapshot from
//! `KASHSHAF_FREQ_DIR` or beside the corpus):
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR=… KASHSHAF_FREQ_DIR=… \
//!     cargo test -p kashshaf-lab --release --test banality_probe -- --nocapture
//! ```

use kashshaf_lab_lib::analysis::reuse::{self, Params};
use kashshaf_lab_lib::source::{local::LocalSource, BookSource, FreqLayer, PageRef};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct GoldChain {
    book_id: u64,
    part_index: u32,
    page_id: u64,
    isnad: [usize; 2],
    matn: Option<[usize; 2]>,
}

fn gold() -> Gold {
    serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/isnad_gold.json")).unwrap()).unwrap()
}

#[derive(Deserialize)]
struct Gold {
    chains: Vec<GoldChain>,
}

fn index_dir(dir: &Path) -> PathBuf {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join("tantivy_index"))
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return 0.0;
    }
    v[((v.len() - 1) as f64 * p).round() as usize]
}

#[test]
fn banal_share_of_running_text_and_of_formulae() {
    let Some(dir) = std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from) else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open sample");
    let freq = source.freq_table(FreqLayer::Lemma).expect("lemma frequency snapshot");

    // 1. Corpus share of the top-N lemmas.
    let mut counts: Vec<u64> = freq.entries().map(|(_, c)| c).collect();
    counts.sort_unstable_by(|a, b| b.cmp(a));
    let total: u64 = counts.iter().sum();
    println!("=== corpus share of the top-N lemmas (snapshot for corpus {}, {} lemmas, {} tokens)", freq.corpus_version, freq.len(), total);
    for n in [50usize, 100, 200, 300, 500, 1000, 2000] {
        let s: u64 = counts.iter().take(n).sum();
        println!("  top {:5}: {:.1}%", n, 100.0 * s as f64 / total as f64);
    }

    // 2. Banal share per page, on the books that have pages here.
    let books: Vec<u64> = source.books().unwrap().into_iter().map(|b| b.id).filter(|id| !source.page_refs(*id).unwrap_or_default().is_empty()).take(12).collect();
    let mut shares = Vec::new();
    for id in &books {
        for page in source.book_pages(*id, &|_, _| {}).unwrap().into_iter().take(40) {
            if page.tokens.len() < 30 {
                continue;
            }
            let banal = page.tokens.iter().filter(|t| freq.get(&t.lemma).rank.map(|r| r <= 300).unwrap_or(false)).count();
            shares.push(banal as f64 / page.tokens.len() as f64);
        }
    }
    let mean = shares.iter().sum::<f64>() / shares.len().max(1) as f64;
    println!("=== banal share (rank ≤ 300) per page, {} pages of {} books", shares.len(), books.len());
    println!("  mean {:.3}  p10 {:.3}  p50 {:.3}  p90 {:.3}", mean, pct(&mut shares, 0.1), pct(&mut shares, 0.5), pct(&mut shares, 0.9));

    // 3. Gold isnād chains: the chain span (without matn) and the matn.
    let gold = gold();
    let mut chain_shares = Vec::new();
    let mut matn_shares = Vec::new();
    for c in &gold.chains {
        let Some(page) = source.page(c.book_id, c.part_index, c.page_id).unwrap() else { continue };
        let share = |s: usize, e: usize| {
            let toks = &page.tokens[s.min(page.tokens.len())..e.min(page.tokens.len())];
            if toks.is_empty() {
                return None;
            }
            Some(toks.iter().filter(|t| freq.get(&t.lemma).rank.map(|r| r <= 300).unwrap_or(false)).count() as f64 / toks.len() as f64)
        };
        if let Some(x) = share(c.isnad[0], c.isnad[1]) {
            chain_shares.push(x);
        }
        if let Some([s, e]) = c.matn {
            if let Some(x) = share(s, e) {
                matn_shares.push(x);
            }
        }
    }
    let m = |v: &mut Vec<f64>| (v.iter().sum::<f64>() / v.len().max(1) as f64, pct(v, 0.1), pct(v, 0.5), pct(v, 0.9));
    let (a, b, c, d) = m(&mut chain_shares);
    println!("=== gold isnād chain spans ({}): banal share mean {:.3} p10 {:.3} p50 {:.3} p90 {:.3}", chain_shares.len(), a, b, c, d);
    let (a, b, c, d) = m(&mut matn_shares);
    println!("=== gold matn spans ({}): banal share mean {:.3} p10 {:.3} p50 {:.3} p90 {:.3}", matn_shares.len(), a, b, c, d);

    // 4. Where the formulae sit.
    println!("=== ranks of formula lemmas");
    for w in ["سم", "الله", "رحمن", "رحيم", "حدث", "أخبر", "عن", "بن", "قال", "أبو", "محمد", "عبد", "رسول", "نبي", "صلى", "سلم", "حمد", "رب", "عالم"] {
        let f = freq.get(w);
        println!("  {:8} rank {:?} count {}", w, f.rank, f.count);
    }
}

/// The claim §4.3 makes: the banality penalty suppresses isnād formulae and
/// the basmala *without a phrase list*. Measured by running passage mode
/// on (a) every gold isnād chain span and (b) opening formulae taken from
/// real pages, and reporting what comes back at the default threshold.
#[test]
fn formulae_through_passage_mode() {
    let Some(dir) = std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from) else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open sample");
    let freq = source.freq_table(FreqLayer::Lemma).expect("lemma frequency snapshot");
    let mut params = Params::default();
    params.banality_baseline = Some(reuse::corpus_banal_share(&freq, params.banality_rank));
    let spec_params = Params { banality_baseline: Some(0.0), ..params.clone() };
    println!("=== baseline {:.3} (corpus share of the top-{} lemmas)", params.banality_baseline.unwrap(), params.banality_rank);
    let load = |r: &PageRef| source.page(r.book_id, r.part_index, r.page_id);
    let count = |t: &[String]| reuse::phrase_df(&source, t);

    let report = |title: &str, runs: &[(String, reuse::PassageRun)], p: &Params| {
        println!("=== {} ({} spans, threshold {:.2}, baseline {:.3})", title, runs.len(), p.threshold, p.banality_baseline.unwrap_or(0.0));
        let mut types: HashMap<&str, usize> = HashMap::new();
        let mut above = 0usize;
        let mut with_matches = 0usize;
        let mut top_scores = Vec::new();
        let mut top_factors = Vec::new();
        let mut cands = 0usize;
        for (_, r) in runs {
            cands += r.candidates;
            if let Some(m) = r.matches.first() {
                with_matches += 1;
                top_scores.push(m.score);
                top_factors.push(m.components.banality_factor);
                *types.entry(m.kind.as_str()).or_insert(0) += 1;
                if m.score >= p.threshold {
                    above += 1;
                }
            }
        }
        let mut tv: Vec<_> = types.into_iter().collect();
        tv.sort();
        println!("  spans with a match: {}  above threshold: {}  candidates/span {:.1}", with_matches, above, cands as f64 / runs.len().max(1) as f64);
        println!("  top-match score  mean {:.3} p50 {:.3} p90 {:.3}", top_scores.iter().sum::<f64>() / top_scores.len().max(1) as f64, pct(&mut top_scores, 0.5), pct(&mut top_scores, 0.9));
        println!("  top-match factor mean {:.3} p50 {:.3} p90 {:.3}", top_factors.iter().sum::<f64>() / top_factors.len().max(1) as f64, pct(&mut top_factors, 0.5), pct(&mut top_factors, 0.9));
        println!("  top-match types {:?}", tv);
        for (label, r) in runs.iter().take(6) {
            if let Some(m) = r.matches.first() {
                println!("    {:<60} → {:.3} {:<10} banal {:.2} factor {:.2} cov {:.2} aligned {} zone {:?} target {}:{}:{}", label.chars().take(60).collect::<String>(), m.score, m.kind.as_str(), m.components.banal_share, m.components.banality_factor, m.components.coverage, m.components.aligned, m.zone, m.target.book_id, m.target.part_index, m.target.page_id);
            } else {
                println!("    {:<60} → no match ({} anchors, {} candidates)", label.chars().take(60).collect::<String>(), r.anchors.len(), r.candidates);
            }
        }
    };

    // (a) Gold isnād chains, chain span only, against the corpus (own page excluded).
    let mut chains = Vec::new();
    for c in &gold().chains {
        let Some(page) = source.page(c.book_id, c.part_index, c.page_id).unwrap() else { continue };
        let (a, b) = (c.isnad[0].min(page.tokens.len()), c.isnad[1].min(page.tokens.len()));
        if b <= a {
            continue;
        }
        let label: String = page.tokens[a..b].iter().map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ");
        let run = reuse::passage(&source, &freq, &params, &[], &page, a..b, &[], None, &count, &load, &|| false).unwrap();
        chains.push((label, run));
    }
    report("gold isnād chains, corpus-baseline penalty", &chains, &params);
    let mut chains_spec = Vec::new();
    for c in gold().chains.iter().take(12) {
        let Some(page) = source.page(c.book_id, c.part_index, c.page_id).unwrap() else { continue };
        let (a, b) = (c.isnad[0].min(page.tokens.len()), c.isnad[1].min(page.tokens.len()));
        if b <= a {
            continue;
        }
        let run = reuse::passage(&source, &freq, &spec_params, &[], &page, a..b, &[], None, &count, &load, &|| false).unwrap();
        chains_spec.push((String::new(), run));
    }
    report("gold isnād chains (first 12), spec's formula (baseline 0)", &chains_spec, &spec_params);

    // (b) Opening formulae: the first 12 tokens of pages that start with the
    // basmala, across books.
    let mut openings = Vec::new();
    let mut basmala_only = Vec::new();
    for b in source.books().unwrap().into_iter().map(|b| b.id) {
        let refs = source.page_refs(b).unwrap_or_default();
        for r in refs.iter().take(3) {
            let Some(page) = source.page(r.book_id, r.part_index, r.page_id).unwrap() else { continue };
            if page.tokens.len() < 20 || page.tokens[0].surface != "بسم" {
                continue;
            }
            let label: String = page.tokens[..12].iter().map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ");
            let run = reuse::passage(&source, &freq, &params, &[], &page, 0..12, &[], None, &count, &load, &|| false).unwrap();
            openings.push((label, run));
            // The basmala alone: four tokens.
            let run = reuse::passage(&source, &freq, &Params { min_aligned: 3, ..params.clone() }, &[], &page, 0..4, &[], None, &count, &load, &|| false).unwrap();
            basmala_only.push(("بسم الله الرحمن الرحيم".to_string(), run));
            if openings.len() >= 10 {
                break;
            }
        }
        if openings.len() >= 10 {
            break;
        }
    }
    report("page openings (basmala + 8 tokens)", &openings, &params);
    report("basmala alone (min_aligned lowered to 3 so it can align at all)", &basmala_only, &params);
}
