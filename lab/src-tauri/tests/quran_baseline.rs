//! Spec §4.4's baseline test: Lab's Qurʾān detector against `Quran_Detector`
//! on 20 sample pages (`lab/fixtures/quran_baseline.json`, produced by
//! `lab/scripts/quran_baseline.py`; Python is never run here).
//!
//! A baseline match is *recovered* when Lab reports a hit on the same page
//! with the same sūra and an overlapping āya range. Lab's recall on the
//! baseline's matches must be ≥ the baseline's own recall on Lab's — i.e.
//! Lab finds at least what the baseline finds — and every disagreement is
//! printed for review. Gated on `KASHSHAF_SAMPLE_DIR`.
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR=… cargo test -p kashshaf-lab --release --test quran_baseline -- --nocapture
//! ```

use kashshaf_lab_lib::analysis::quran::{self, QuranIndex};
use kashshaf_lab_lib::quran_data::QuranText;
use kashshaf_lab_lib::source::{local::LocalSource, BookSource, FreqLayer};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct BaseMatch {
    sura_name: String,
    aya_start: u32,
    aya_end: u32,
    #[serde(default)]
    verses: Vec<String>,
}

#[derive(Deserialize)]
struct BasePage {
    book_id: u64,
    part_index: u32,
    page_id: u64,
    matches: Vec<BaseMatch>,
}

#[derive(Deserialize)]
struct Baseline {
    pages: Vec<BasePage>,
}

fn index_dir(dir: &Path) -> PathBuf {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join("tantivy_index"))
}

#[test]
fn lab_recall_is_at_least_the_baselines() {
    let Some(dir) = std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from) else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open sample");
    let freq = source.freq_table(FreqLayer::Lemma).ok();
    let tmp = std::env::temp_dir().join(format!("kashshaf-lab-quran-baseline-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let text = QuranText::load(&tmp).expect("embedded Qurʾān");
    let index = QuranIndex::build(&text);
    let baseline: Baseline = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/quran_baseline.json")).unwrap()).unwrap();
    let sura_by_name: std::collections::HashMap<&str, u32> = text.suras.iter().map(|s| (s.name.as_str(), s.sura)).collect();

    let params = quran::Params::default();
    let mut base_total = 0usize;
    let mut base_recovered = 0usize;
    let mut lab_total = 0usize;
    let mut lab_in_base = 0usize;
    let mut with_cue = 0usize;
    let started = std::time::Instant::now();
    for bp in &baseline.pages {
        let Some(page) = source.page(bp.book_id, bp.part_index, bp.page_id).unwrap() else {
            println!("page {}:{}:{} not in the sample", bp.book_id, bp.part_index, bp.page_id);
            continue;
        };
        let hits = quran::detect_page(&index, &text, &page.tokens, &page.body, freq.as_deref(), &params);
        lab_total += hits.len();
        with_cue += hits.iter().filter(|h| h.cue.is_some()).count();
        let mut lab_used = vec![false; hits.len()];
        for b in &bp.matches {
            base_total += 1;
            let sura = sura_by_name.get(b.sura_name.as_str()).copied();
            let found = hits.iter().enumerate().find(|(_, h)| Some(h.sura) == sura && h.aya_start <= b.aya_end && b.aya_start <= h.aya_end);
            match found {
                Some((i, h)) => {
                    base_recovered += 1;
                    lab_used[i] = true;
                    let _ = h;
                }
                None => println!(
                    "  BASELINE ONLY  {}:{}:{}  {} {}-{}  «{}»",
                    bp.book_id, bp.part_index, bp.page_id, b.sura_name, b.aya_start, b.aya_end,
                    b.verses.join(" | ").chars().take(80).collect::<String>()
                ),
            }
        }
        for (i, h) in hits.iter().enumerate() {
            if lab_used[i] {
                lab_in_base += 1;
                continue;
            }
            // Lab found something the baseline did not: list it for review.
            let snippet: String = page.tokens[h.tok_start..h.tok_end].iter().map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ");
            let name = text.sura(h.sura).map(|s| s.name.as_str()).unwrap_or("?");
            println!(
                "  LAB ONLY       {}:{}:{}  {} {}:{}-{} aligned {} lem {:.2} surf {:.2} cue {}  «{}»",
                bp.book_id, bp.part_index, bp.page_id, name, h.sura, h.aya_start, h.aya_end, h.aligned, h.lemma_agree, h.surface_agree,
                h.cue.as_deref().unwrap_or("-"), snippet.chars().take(80).collect::<String>()
            );
        }
    }
    let lab_recall = base_recovered as f64 / base_total.max(1) as f64;
    let base_recall = lab_in_base as f64 / lab_total.max(1) as f64;
    println!();
    println!("Quran_Detector matches: {}   recovered by Lab: {}  → Lab recall on the baseline {:.3}", base_total, base_recovered, lab_recall);
    println!("Lab matches: {} ({} cued)   found by the baseline: {}  → baseline recall on Lab {:.3}", lab_total, with_cue, lab_in_base, base_recall);
    println!("{} pages in {} ms", baseline.pages.len(), started.elapsed().as_millis());
    let _ = std::fs::remove_dir_all(&tmp);
    assert!(lab_recall >= base_recall, "Lab recall {:.3} < baseline recall {:.3}", lab_recall, base_recall);
}
