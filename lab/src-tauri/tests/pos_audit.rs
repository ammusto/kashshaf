//! POS audit over the gold transmitter spans, three ways on the same tokens:
//!
//! (a) as `LocalSource::page` returns them (Lab's path: `TokenCache::book_pages`
//!     + `resolve_pages`, or `get` for a single page);
//! (c) as Kashshaf's `get_page_tokens` command returns them — that command is
//!     `token_cache.get(&PageKey)` on a `TokenCache::new(corpus.db, 1000)`,
//!     which is what this calls, so the numbers are the command's.
//!
//! (b), the ground truth from the pipeline's JSONL, is computed by the Python
//! one-liner in the Phase 2 audit; this prints (a) and (c) in the same shape
//! so the three can be laid side by side.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`:
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
//!     cargo test -p kashshaf-lab --release --test pos_audit -- --nocapture
//! ```

use kashshaf_engine::{PageKey, TokenCache};
use kashshaf_lab_lib::source::{local::LocalSource, BookSource};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone)]
struct GoldChain {
    book_id: u64,
    part_index: u32,
    page_id: u64,
    matn: Option<[usize; 2]>,
    transmitters: Vec<[usize; 2]>,
}

#[derive(Deserialize)]
struct Gold {
    chains: Vec<GoldChain>,
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

#[derive(Default)]
struct Hist {
    transmitter: BTreeMap<String, usize>,
    matn: BTreeMap<String, usize>,
    other: BTreeMap<String, usize>,
}

impl Hist {
    fn add(&mut self, pos: &str, in_tr: bool, in_matn: bool) {
        let m = if in_tr { &mut self.transmitter } else if in_matn { &mut self.matn } else { &mut self.other };
        *m.entry(pos.to_string()).or_insert(0) += 1;
    }
    fn line(m: &BTreeMap<String, usize>) -> String {
        let total: usize = m.values().sum();
        let mut v: Vec<(&String, &usize)> = m.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        let top: Vec<String> = v.iter().take(8).map(|(p, n)| format!("{} {} ({:.1}%)", p, n, 100.0 * **n as f64 / total.max(1) as f64)).collect();
        format!("n={:5}  {}", total, top.join(", "))
    }
    fn print(&self, title: &str) {
        println!("=== {}", title);
        println!("  {:18} {}", "transmitter spans", Self::line(&self.transmitter));
        println!("  {:18} {}", "matn spans", Self::line(&self.matn));
        println!("  {:18} {}", "other", Self::line(&self.other));
    }
}

fn spans(chains: &[GoldChain]) -> (HashSet<usize>, HashSet<usize>) {
    let mut tr = HashSet::new();
    let mut matn = HashSet::new();
    for c in chains {
        for [s, e] in &c.transmitters {
            tr.extend(*s..*e);
        }
        if let Some([s, e]) = c.matn {
            matn.extend(s..e);
        }
    }
    (tr, matn)
}

#[test]
fn pos_three_ways_on_the_gold_spans() {
    let Some(dir) = sample_dir() else { return };
    let gold: Gold = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/isnad_gold.json")).unwrap()).unwrap();
    let mut by_page: HashMap<(u64, u32, u64), Vec<GoldChain>> = HashMap::new();
    for c in &gold.chains {
        by_page.entry((c.book_id, c.part_index, c.page_id)).or_default().push(c.clone());
    }
    let mut pages: Vec<_> = by_page.keys().copied().collect();
    pages.sort();

    // (a) Lab: LocalSource.
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open sample");
    let mut a = Hist::default();
    let mut a_pages: HashMap<(u64, u32, u64), Vec<String>> = HashMap::new();
    for key in &pages {
        let page = source.page(key.0, key.1, key.2).expect("page").expect("gold page exists");
        let (tr, matn) = spans(&by_page[key]);
        for (i, t) in page.tokens.iter().enumerate() {
            a.add(&t.pos, tr.contains(&i), matn.contains(&i));
        }
        a_pages.insert(*key, page.tokens.iter().map(|t| t.pos.clone()).collect());
    }
    a.print("(a) LocalSource::page (Lab), all 28 gold pages");

    // Also the bulk path Lab's statistics and the extractor use.
    let mut a_bulk = Hist::default();
    let mut books: Vec<u64> = pages.iter().map(|k| k.0).collect();
    books.sort_unstable();
    books.dedup();
    for book in books {
        for page in source.book_pages(book, &|_, _| {}).expect("book_pages") {
            let key = (page.book_id, page.part_index, page.page_id);
            if let Some(chains) = by_page.get(&key) {
                let (tr, matn) = spans(chains);
                for (i, t) in page.tokens.iter().enumerate() {
                    a_bulk.add(&t.pos, tr.contains(&i), matn.contains(&i));
                }
                assert_eq!(a_pages[&key], page.tokens.iter().map(|t| t.pos.clone()).collect::<Vec<_>>(), "page() and book_pages() agree on POS");
            }
        }
    }
    a_bulk.print("(a') LocalSource::book_pages (Lab bulk path), same pages");

    // (c) Kashshaf's get_page_tokens: TokenCache::new(corpus.db, 1000).get(key).
    let cache = TokenCache::new(dir.join("corpus.db"), 1000).expect("Kashshaf's cache");
    let mut c = Hist::default();
    let three: Vec<_> = [(527u64, 0u32, 2u64), (5128, 0, 2), (6038, 0, 30)].into_iter().filter(|k| by_page.contains_key(k)).collect();
    for key in &three {
        let tokens = cache.get(&PageKey::new(key.0, key.1 as u64, key.2)).expect("get_page_tokens path");
        let (tr, matn) = spans(&by_page[key]);
        for (i, t) in tokens.iter().enumerate() {
            c.add(&t.pos, tr.contains(&i), matn.contains(&i));
        }
        assert_eq!(a_pages[key], tokens.iter().map(|t| t.pos.clone()).collect::<Vec<_>>(), "(a) and (c) agree on {:?}", key);
    }
    c.print("(c) TokenCache::get = Kashshaf get_page_tokens, three pages 527:2, 5128:2, 6038:30");

    // (a) restricted to the same three pages, for a like-for-like line.
    let mut a3 = Hist::default();
    for key in &three {
        let (tr, matn) = spans(&by_page[key]);
        for (i, pos) in a_pages[key].iter().enumerate() {
            a3.add(pos, tr.contains(&i), matn.contains(&i));
        }
    }
    a3.print("(a) LocalSource::page, the same three pages");
}
