//! The isnād gold set (Lab spec §9): `lab/fixtures/isnad_gold.json`, 40
//! hand-labelled chains from the sample corpus, scored for span F1 and
//! transmitter F1. The numbers are the Phase 2 baseline, not a gate: the
//! test asserts only that every gold page was processed, and prints the rest.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`:
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
//!     cargo test -p kashshaf-lab --release --test isnad_gold -- --nocapture
//! ```
//!
//! Matching: an isnād span matches a gold span on the same page when their
//! intersection over union is ≥ 0.5 (greedy, best IoU first, one-to-one). A
//! transmitter span matches exactly, or leniently at IoU ≥ 0.8. Matn
//! boundary accuracy is the share of matched chains whose predicted matn
//! start equals the gold one.

use kashshaf_lab_lib::analysis::isnad::{extract_page, extract_stream, page_starts, Candidate, Kind, Params, View, MATN_MAX_PAGES};
use kashshaf_lab_lib::lexicon::Lexicon;
use kashshaf_lab_lib::source::{local::LocalSource, BookSource, Page, Token};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Gold {
    chains: Vec<GoldChain>,
    /// Chains given as tokens (`surface/pos`, `+place` for a `ب`-fused
    /// proper noun) rather than corpus coordinates — for text that is not in
    /// the sample corpus (amendment 1.4, fix 2). Scored without a corpus.
    #[serde(default)]
    inline: Vec<InlineChain>,
}

#[derive(Deserialize, Clone)]
struct InlineChain {
    id: u32,
    #[serde(default)]
    note: String,
    tokens: String,
    /// Stream offsets at which a new page starts (fix 1: cross-page chains).
    #[serde(default)]
    page_breaks: Vec<usize>,
    isnad: [usize; 2],
    matn_start: Option<usize>,
    #[serde(default)]
    matn_end: Option<usize>,
    transmitters: Vec<[usize; 2]>,
    #[serde(default)]
    places: Vec<Option<String>>,
}

/// A page and the pages after it a chain may run on to (amendment 1.4):
/// the extractor's window for a whole-book run.
fn window(source: &LocalSource, book: u64, part: u32, page_id: u64) -> Vec<Page> {
    let refs = source.page_refs(book).expect("page_refs");
    let start = refs.iter().position(|r| r.part_index == part && r.page_id == page_id).expect("gold page in the book");
    refs[start..(start + 1 + MATN_MAX_PAGES).min(refs.len())]
        .iter()
        .map(|r| source.page(r.book_id, r.part_index, r.page_id).expect("page").expect("page exists"))
        .collect()
}

/// Candidates that *start* on the window's first page, stream offsets.
fn extract_window(pages: &[Page], lex: &Lexicon, params: &Params) -> Vec<Candidate> {
    let refs: Vec<(&[Token], &str)> = pages.iter().map(|p| (p.tokens.as_slice(), p.body.as_str())).collect();
    let first = pages[0].tokens.len();
    extract_stream(&refs, lex, params, &HashMap::new()).into_iter().filter(|c| c.tok_start < first).collect()
}

#[derive(Deserialize, Clone)]
struct GoldChain {
    id: u32,
    genre: String,
    book_id: u64,
    part_index: u32,
    page_id: u64,
    kind: String,
    isnad: [usize; 2],
    matn: Option<[usize; 2]>,
    transmitters: Vec<[usize; 2]>,
}

fn sample_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from)
}

fn index_dir(dir: &Path) -> PathBuf {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join("tantivy_index"))
}

fn gold() -> Gold {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/isnad_gold.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("read isnad_gold.json")).expect("parse isnad_gold.json")
}

fn iou(a: [usize; 2], b: [usize; 2]) -> f64 {
    let inter = a[1].min(b[1]).saturating_sub(a[0].max(b[0]));
    let union = a[1].max(b[1]) - a[0].min(b[0]);
    if union == 0 { 0.0 } else { inter as f64 / union as f64 }
}

/// Greedy one-to-one matching by IoU; returns (gold idx, pred idx) pairs.
fn match_spans(gold: &[[usize; 2]], pred: &[[usize; 2]], min_iou: f64) -> Vec<(usize, usize)> {
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (g, gs) in gold.iter().enumerate() {
        for (p, ps) in pred.iter().enumerate() {
            let v = iou(*gs, *ps);
            if v >= min_iou {
                pairs.push((v, g, p));
            }
        }
    }
    pairs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let mut used_g = vec![false; gold.len()];
    let mut used_p = vec![false; pred.len()];
    let mut out = Vec::new();
    for (_, g, p) in pairs {
        if !used_g[g] && !used_p[p] {
            used_g[g] = true;
            used_p[p] = true;
            out.push((g, p));
        }
    }
    out
}

fn prf(tp: usize, fp: usize, fn_: usize) -> (f64, f64, f64) {
    let p = if tp + fp == 0 { 0.0 } else { tp as f64 / (tp + fp) as f64 };
    let r = if tp + fn_ == 0 { 0.0 } else { tp as f64 / (tp + fn_) as f64 };
    let f = if p + r == 0.0 { 0.0 } else { 2.0 * p * r / (p + r) };
    (p, r, f)
}

#[derive(Default)]
struct Tally {
    span_tp: usize,
    span_fp: usize,
    span_fn: usize,
    tr_exact_tp: usize,
    tr_lenient_tp: usize,
    tr_pred: usize,
    tr_gold: usize,
    matn_ok: usize,
    matn_n: usize,
    kind_ok: usize,
}

impl Tally {
    fn add(&mut self, o: &Tally) {
        self.span_tp += o.span_tp;
        self.span_fp += o.span_fp;
        self.span_fn += o.span_fn;
        self.tr_exact_tp += o.tr_exact_tp;
        self.tr_lenient_tp += o.tr_lenient_tp;
        self.tr_pred += o.tr_pred;
        self.tr_gold += o.tr_gold;
        self.matn_ok += o.matn_ok;
        self.matn_n += o.matn_n;
        self.kind_ok += o.kind_ok;
    }
}

/// Score one page: its gold chains against the extractor's candidates.
fn score_page(gold: &[GoldChain], pred: &[Candidate]) -> (Tally, Vec<String>) {
    let mut t = Tally::default();
    let mut notes = Vec::new();
    let gspans: Vec<[usize; 2]> = gold.iter().map(|g| g.isnad).collect();
    let pspans: Vec<[usize; 2]> = pred.iter().map(|p| [p.tok_start, p.tok_end]).collect();
    let pairs = match_spans(&gspans, &pspans, 0.5);
    t.span_tp = pairs.len();
    t.span_fp = pred.len() - pairs.len();
    t.span_fn = gold.len() - pairs.len();

    // Transmitters are pooled per page: every gold span against every predicted span.
    let gt: Vec<[usize; 2]> = gold.iter().flat_map(|g| g.transmitters.iter().copied()).collect();
    let pt: Vec<[usize; 2]> = pred.iter().flat_map(|p| p.transmitters.iter().map(|x| [x.tok_start, x.tok_end])).collect();
    t.tr_gold = gt.len();
    t.tr_pred = pt.len();
    t.tr_exact_tp = match_spans(&gt, &pt, 0.999).len();
    t.tr_lenient_tp = match_spans(&gt, &pt, 0.8).len();

    for (g, p) in &pairs {
        let (gc, pc) = (&gold[*g], &pred[*p]);
        if let Some(gm) = gc.matn {
            t.matn_n += 1;
            if pc.matn.map(|m| m.0) == Some(gm[0]) {
                t.matn_ok += 1;
            } else {
                notes.push(format!(
                    "chain {}: matn start {} vs gold {}",
                    gc.id,
                    pc.matn.map(|m| m.0 as i64).unwrap_or(-1),
                    gm[0]
                ));
            }
        }
        let pk = match pc.kind { Kind::Isnad => "isnad", Kind::Citation => "citation" };
        if pk == gc.kind {
            t.kind_ok += 1;
        }
        if iou(gc.isnad, [pc.tok_start, pc.tok_end]) < 0.9 {
            notes.push(format!("chain {}: span [{}, {}) vs gold [{}, {})", gc.id, pc.tok_start, pc.tok_end, gc.isnad[0], gc.isnad[1]));
        }
    }
    let matched_g: Vec<usize> = pairs.iter().map(|x| x.0).collect();
    for (i, g) in gold.iter().enumerate() {
        if !matched_g.contains(&i) {
            notes.push(format!("chain {} ({}): MISSED gold [{}, {})", g.id, g.genre, g.isnad[0], g.isnad[1]));
        }
    }
    let matched_p: Vec<usize> = pairs.iter().map(|x| x.1).collect();
    for (i, p) in pred.iter().enumerate() {
        if !matched_p.contains(&i) {
            notes.push(format!("spurious [{}, {}) links={} conf={:.2}", p.tok_start, p.tok_end, p.links, p.confidence.total));
        }
    }
    (t, notes)
}

#[test]
fn the_gold_set_baseline() {
    let Some(dir) = sample_dir() else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open the sample corpus");
    let gold = gold();
    let lex = Lexicon::shipped();
    let params = Params::default();

    // Group gold chains by page.
    let mut by_page: HashMap<(u64, u32, u64), Vec<GoldChain>> = HashMap::new();
    for c in &gold.chains {
        by_page.entry((c.book_id, c.part_index, c.page_id)).or_default().push(c.clone());
    }
    let mut pages: Vec<_> = by_page.keys().copied().collect();
    pages.sort();

    let mut total = Tally::default();
    let mut by_genre: HashMap<String, Tally> = HashMap::new();
    let mut processed = 0;
    let mut all_notes = Vec::new();
    for key in pages {
        let chains = &by_page[&key];
        let pages = window(&source, key.0, key.1, key.2);
        let pred = extract_window(&pages, &lex, &params);
        let (t, notes) = score_page(chains, &pred);
        total.add(&t);
        for c in chains {
            by_genre.entry(c.genre.clone()).or_default();
        }
        // Genre tallies: attribute the page's tally to its (single) genre.
        by_genre.get_mut(&chains[0].genre).unwrap().add(&t);
        all_notes.extend(notes.into_iter().map(|n| format!("[{} {}:{}] {}", key.0, key.1, key.2, n)));
        processed += 1;
    }
    assert_eq!(processed, by_page.len(), "every gold page was processed");

    let (sp, sr, sf) = prf(total.span_tp, total.span_fp, total.span_fn);
    let (tep, ter, tef) = prf(total.tr_exact_tp, total.tr_pred - total.tr_exact_tp, total.tr_gold - total.tr_exact_tp);
    let (tlp, tlr, tlf) = prf(total.tr_lenient_tp, total.tr_pred - total.tr_lenient_tp, total.tr_gold - total.tr_lenient_tp);
    println!();
    println!("== isnād gold baseline ({} chains, {} pages, draft gold) ==", gold.chains.len(), processed);
    println!("isnād spans (IoU ≥ 0.5):     P {:.3}  R {:.3}  F1 {:.3}   (tp {}, fp {}, fn {})", sp, sr, sf, total.span_tp, total.span_fp, total.span_fn);
    println!("transmitters, exact:         P {:.3}  R {:.3}  F1 {:.3}   ({} gold, {} predicted)", tep, ter, tef, total.tr_gold, total.tr_pred);
    println!("transmitters, IoU ≥ 0.8:     P {:.3}  R {:.3}  F1 {:.3}", tlp, tlr, tlf);
    println!("matn start exact:            {}/{} of matched chains", total.matn_ok, total.matn_n);
    println!("kind agrees:                 {}/{} of matched chains", total.kind_ok, total.span_tp);
    let mut genres: Vec<_> = by_genre.iter().collect();
    genres.sort_by_key(|(g, _)| g.to_string());
    for (g, t) in genres {
        let (_, _, f) = prf(t.span_tp, t.span_fp, t.span_fn);
        let (_, _, tf) = prf(t.tr_lenient_tp, t.tr_pred - t.tr_lenient_tp, t.tr_gold - t.tr_lenient_tp);
        println!("  {:<8} span F1 {:.3}  transmitter F1 {:.3}  (gold chains tp {} fn {})", g, f, tf, t.span_tp, t.span_fn);
    }
    println!("-- disagreements --");
    for n in &all_notes {
        println!("  {}", n);
    }
    // Not a gate (spec §9): only sanity, so a broken extractor cannot pass silently.
    assert!(total.span_tp > 0, "the extractor found none of the gold chains");
}

/// Spec §8: a 1M-token book in under 10 s. The sample's largest book is
/// ~6,336 pages; the whole 25-book sample is 4.1M tokens.
/// The inline chains (fix 2): scored from their tokens, no corpus needed.
#[test]
fn the_inline_gold_chains() {
    let gold = gold();
    let lex = Lexicon::shipped();
    let params = Params::default();
    for g in &gold.inline {
        let mut views: Vec<View> = Vec::new();
        for w in g.tokens.split_whitespace() {
            let (w, place) = match w.strip_suffix("+place") {
                Some(x) => (x, true),
                None => (w, false),
            };
            let (sf, pos) = w.split_once('/').unwrap_or((w, "noun"));
            let t = Token { idx: views.len(), surface: sf.to_string(), noclitic_surface: None, lemma: sf.to_string(), root: None, pos: pos.to_string(), features: vec![], clitics: vec![] };
            let mut v = View::of(&t);
            v.place = place;
            views.push(v);
        }
        let pred = if g.page_breaks.is_empty() {
            kashshaf_lab_lib::analysis::isnad::extract_views(&views, &[], &[], &lex, &params, &HashMap::new())
        } else {
            // Split the tokens into pages at the breaks and run the stream.
            let tokens: Vec<Token> = views
                .iter()
                .enumerate()
                .map(|(i, v)| Token {
                    idx: i,
                    surface: v.surface.clone(),
                    noclitic_surface: None,
                    lemma: v.surface.clone(),
                    root: None,
                    pos: v.pos.clone(),
                    features: vec![],
                    // A place tag is a `ب` proclitic on a proper noun, as the pipeline writes it.
                    clitics: if v.place { vec![kashshaf_lab_lib::source::TokenClitic { clitic_type: "bi_prep".into(), display: "بـ".into() }] } else { vec![] },
                })
                .collect();
            let mut bounds = vec![0usize];
            bounds.extend(g.page_breaks.iter().copied());
            bounds.push(tokens.len());
            let pages: Vec<Vec<Token>> = bounds.windows(2).map(|w| tokens[w[0]..w[1]].iter().cloned().map(|mut t| { t.idx -= w[0]; t }).collect()).collect();
            let refs: Vec<(&[Token], &str)> = pages.iter().map(|p| (p.as_slice(), "")).collect();
            extract_stream(&refs, &lex, &params, &HashMap::new())
        };
        let hit = pred.iter().find(|c| c.tok_start == g.isnad[0]).unwrap_or_else(|| panic!("inline #{} ({}): no chain starts at {}: {:?}", g.id, g.note, g.isnad[0], pred.iter().map(|c| (c.tok_start, c.tok_end)).collect::<Vec<_>>()));
        assert_eq!(hit.tok_end, g.isnad[1], "inline #{} ({}): chain end", g.id, g.note);
        let spans: Vec<[usize; 2]> = hit.transmitters.iter().map(|t| [t.tok_start, t.tok_end]).collect();
        assert_eq!(spans, g.transmitters, "inline #{} ({}): transmitters", g.id, g.note);
        assert_eq!(hit.matn.map(|m| m.0), g.matn_start, "inline #{} ({}): matn start", g.id, g.note);
        if let Some(e) = g.matn_end {
            assert_eq!(hit.matn.map(|m| m.1), Some(e), "inline #{} ({}): matn end", g.id, g.note);
        }
        for (k, p) in g.places.iter().enumerate() {
            assert_eq!(hit.transmitters.get(k).and_then(|t| t.place.clone()), *p, "inline #{} ({}): place of transmitter {}", g.id, g.note, k);
        }
        println!("inline #{} ok: {} links, matn at {:?}", g.id, hit.links, hit.matn.map(|m| m.0));
    }
    assert!(!gold.inline.is_empty(), "the gold set has inline chains");
}

/// Lists chains that cross a page break in the sample's ḥadīth books — the
/// pool the cross-page gold entries were checked from. Prints only.
#[test]
fn cross_page_candidates() {
    let Some(dir) = sample_dir() else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open the sample corpus");
    let lex = Lexicon::shipped();
    let params = Params::default();
    let books: Vec<u64> = source.books().unwrap().into_iter().map(|b| b.id).filter(|id| !source.page_refs(*id).unwrap_or_default().is_empty()).collect();
    for book in books {
        let refs = source.page_refs(book).expect("page_refs");
        let mut shown = 0;
        for (i, r) in refs.iter().enumerate().take(400) {
            let pages = window(&source, book, r.part_index, r.page_id);
            let first = pages[0].tokens.len();
            let starts = page_starts(&pages.iter().map(|p| (p.tokens.as_slice(), p.body.as_str())).collect::<Vec<_>>());
            for c in extract_window(&pages, &lex, &params) {
                let matn_end = c.matn.map(|m| m.1).unwrap_or(0);
                if c.links >= 3 && (c.tok_end > first || matn_end > first) {
                    let text: String = pages.iter().flat_map(|p| p.tokens.iter()).skip(c.tok_start).take(c.tok_end - c.tok_start).map(|t| t.surface.as_str()).collect::<Vec<_>>().join(" ");
                    println!(
                        "{} {}:{} (#{}) chain [{}..{}) {} links, page-1 len {}, matn {:?}, ends page {}  «{}»",
                        book, r.part_index, r.page_id, i, c.tok_start, c.tok_end, c.links, first, c.matn, kashshaf_lab_lib::analysis::isnad::locate(&starts, c.tok_end - 1).0, text.chars().take(160).collect::<String>()
                    );
                    shown += 1;
                }
            }
            if shown >= 12 {
                break;
            }
        }
    }
}

#[test]
fn whole_sample_extraction_is_fast() {
    let Some(dir) = sample_dir() else { return };
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open the sample corpus");
    let lex = Lexicon::shipped();
    let params = Params::default();
    let books: Vec<u64> = source.books().unwrap().into_iter().map(|b| b.id).filter(|id| source.page_refs(*id).map(|r| !r.is_empty()).unwrap_or(false)).collect();
    let mut tokens = 0usize;
    let mut candidates = 0usize;
    let mut extract_ms = 0u128;
    for id in books {
        let pages = source.book_pages(id, &|_, _| {}).unwrap();
        let t0 = std::time::Instant::now();
        for p in &pages {
            tokens += p.tokens.len();
            candidates += extract_page(&p.tokens, &p.body, &lex, &params, &HashMap::new()).len();
            let _ = &page_starts;
        }
        extract_ms += t0.elapsed().as_millis();
    }
    let per_million = extract_ms as f64 / (tokens as f64 / 1e6);
    println!("[isnad] {} tokens, {} candidates, extraction {} ms = {:.0} ms per 1M tokens (spec §8: < 10 000)", tokens, candidates, extract_ms, per_million);
    assert!(per_million < 10_000.0, "{:.0} ms per 1M tokens", per_million);
}


