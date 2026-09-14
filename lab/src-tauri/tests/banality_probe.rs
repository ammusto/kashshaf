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

use kashshaf_lab_lib::source::{local::LocalSource, BookSource, FreqLayer};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct GoldChain {
    book_id: u64,
    part_index: u32,
    page_id: u64,
    isnad: [usize; 2],
    matn: Option<[usize; 2]>,
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
    let gold: Gold = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/isnad_gold.json")).unwrap()).unwrap();
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
