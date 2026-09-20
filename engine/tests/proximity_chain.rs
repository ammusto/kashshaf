//! Proximity chains on the sample corpus: the two-term unordered search is
//! span for span the search it always was; three terms, ordered and not,
//! agree with a brute force over the pages' tokens; a chain straddling a
//! page break is found; and a page-level AND term on the second page of a
//! straddle keeps the hit, an absent one drops it.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` with `boundary_index/` built beside the
//! sample; without it every test passes vacuously.
//!
//!     KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data/data/sample" cargo test --release --test proximity_chain

use kashshaf_engine::{forward, EngineConfig, PageKey, ProximityQuery, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache, TripleMaps};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

struct Sample {
    engine: SearchEngine,
    cache: Arc<TokenCache>,
    triples: TripleMaps,
    /// Every page's triple ids, in reading order per book.
    spines: HashMap<u64, Vec<PageKey>>,
    pages: HashMap<PageKey, Vec<u32>>,
}

fn open() -> Option<Sample> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), EngineConfig { exact_counts: true, ..EngineConfig::default() }).ok()?;
    let cache = Arc::new(TokenCache::new(db.clone(), 100_000).ok()?);
    engine.set_token_cache(cache.clone());
    let triples = TripleMaps::load(&db).ok()??;
    let conn = rusqlite::Connection::open(&db).ok()?;
    let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens ORDER BY book_id, part_index, page_id").ok()?;
    let keys: Vec<PageKey> = stmt
        .query_map([], |r| Ok(PageKey::new(r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))
        .ok()?
        .filter_map(|k| k.ok())
        .collect();
    let mut spines: HashMap<u64, Vec<PageKey>> = HashMap::new();
    for k in &keys {
        spines.entry(k.id).or_default().push(*k);
    }
    let mut pages = HashMap::with_capacity(keys.len());
    for chunk in keys.chunks(2000) {
        for (k, defs) in cache.get_ids_batch(chunk).ok()? {
            pages.insert(k, defs.iter().map(|&d| triples.triple_of_def(d)).collect());
        }
    }
    Some(Sample { engine, cache, triples, spines, pages })
}

fn surface(q: &str) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode: SearchMode::Surface }
}

fn plain(w: &str) -> bool {
    w.chars().count() >= 2 && w.chars().all(|c| ('\u{0621}'..='\u{064A}').contains(&c))
}

/// Surfaces of a page.
fn surfaces(s: &Sample, key: PageKey) -> Vec<String> {
    s.cache.get(&key).map(|t| t.iter().map(|x| x.surface.clone()).collect()).unwrap_or_default()
}

fn key_of(r: &kashshaf_engine::SearchResult) -> (u64, u64, u64, bool, Vec<u32>) {
    (r.id, r.part_index, r.page_id, r.crosses_page, r.matched_token_indices.clone())
}

/// Every page of a search, walked to the end.
fn all_results(s: &Sample, q: &ProximityQuery) -> Vec<kashshaf_engine::SearchResult> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let page = s.engine.proximity_chain_search(q, &SearchFilters::default(), 250, offset).expect("chain");
        if page.results.is_empty() {
            break;
        }
        out.extend(page.results.iter().cloned());
        offset += page.results.len();
        if offset >= page.total_hits {
            break;
        }
    }
    out
}

/// Brute force over single pages: the chain's tuples on a page's triples.
fn brute_pages(s: &Sample, terms: &[&str], distances: &[u32], ordered: bool) -> BTreeSet<(u64, u64, u64)> {
    let sets: Vec<HashSet<u32>> = terms.iter().map(|w| s.triples.triples_for_surface(w).into_iter().collect()).collect();
    let mut out = BTreeSet::new();
    for (k, ids) in &s.pages {
        let starts: Vec<Vec<u32>> = sets.iter().map(|set| forward::member_positions(ids, set)).collect();
        if forward::has_chain(&starts, distances, ordered) {
            out.insert((k.id, k.part_index, k.page_id));
        }
    }
    out
}

#[test]
fn two_terms_unordered_are_the_search_they_always_were() {
    let Some(s) = open() else { return };
    // Common words, so the walk covers many pages and some breaks.
    for (a, b, d) in [("قال", "الله", 5), ("بن", "عن", 3), ("في", "من", 2)] {
        let old = {
            let mut out = Vec::new();
            let mut offset = 0;
            loop {
                let page = s.engine.proximity_search(&surface(a), &surface(b), d, &SearchFilters::default(), 250, offset).expect("old");
                if page.results.is_empty() {
                    break;
                }
                out.extend(page.results.iter().cloned());
                offset += page.results.len();
                if offset >= page.total_hits {
                    break;
                }
            }
            out
        };
        let new = all_results(&s, &ProximityQuery { terms: vec![surface(a), surface(b)], distances: vec![d], ordered: false, and_terms: vec![] });
        assert!(!old.is_empty(), "{a} ~{d} {b} finds something");
        assert_eq!(old.len(), new.len(), "{a} ~{d} {b}: the same number of results");
        for (o, n) in old.iter().zip(new.iter()) {
            assert_eq!(key_of(o), key_of(n), "{a} ~{d} {b}: the same page and the same spans, in the same order");
        }
    }
}

#[test]
fn three_terms_agree_with_brute_force_unordered_and_ordered() {
    let Some(s) = open() else { return };
    let terms = ["قال", "بن", "عن"];
    for ordered in [false, true] {
        let q = ProximityQuery { terms: terms.iter().map(|w| surface(w)).collect(), distances: vec![4, 4], ordered, and_terms: vec![] };
        let got: BTreeSet<(u64, u64, u64)> = all_results(&s, &q).iter().filter(|r| !r.crosses_page).map(|r| (r.id, r.part_index, r.page_id)).collect();
        let want = brute_pages(&s, &terms, &[4, 4], ordered);
        assert!(!want.is_empty(), "the sample has the chain (ordered {ordered})");
        assert_eq!(got, want, "ordered {ordered}: page set");
    }
    // Ordered is a subset of unordered, and a strict one somewhere.
    let un = brute_pages(&s, &terms, &[4, 4], false);
    let or = brute_pages(&s, &terms, &[4, 4], true);
    assert!(or.is_subset(&un) && or.len() < un.len());
    // Spans: every highlighted token is one of the chain's words.
    let q = ProximityQuery { terms: terms.iter().map(|w| surface(w)).collect(), distances: vec![4, 4], ordered: true, and_terms: vec![] };
    let sets: Vec<HashSet<u32>> = terms.iter().map(|w| s.triples.triples_for_surface(w).into_iter().collect()).collect();
    for r in all_results(&s, &q).iter().filter(|r| !r.crosses_page).take(50) {
        let ids = &s.pages[&PageKey::new(r.id, r.part_index, r.page_id)];
        assert!(!r.matched_token_indices.is_empty());
        for &p in &r.matched_token_indices {
            assert!(sets.iter().any(|set| set.contains(&ids[p as usize])), "position {p} is a chain word");
        }
    }
}

/// A break where the chain A ~ B ~ C has A and B on the left page's tail and
/// C at the head of the right page, with all three plain words.
fn straddle_case(s: &Sample) -> Option<(PageKey, PageKey, [String; 3], u32, u32)> {
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    for b in books {
        let spine = &s.spines[&b];
        for w in spine.windows(2) {
            let (l, r) = (w[0], w[1]);
            let ls = surfaces(s, l);
            let rs = surfaces(s, r);
            if ls.len() < 6 || rs.len() < 2 {
                continue;
            }
            let n = ls.len();
            let (a, bb, c) = (&ls[n - 3], &ls[n - 1], &rs[0]);
            if !(plain(a) && plain(bb) && plain(c)) || a == bb || bb == c || a == c {
                continue;
            }
            return Some((l, r, [a.clone(), bb.clone(), c.clone()], 2, 1));
        }
    }
    None
}

#[test]
fn a_three_term_chain_straddling_a_break_is_found_ordered_and_unordered() {
    let Some(s) = open() else { return };
    if !s.engine.has_boundary_index() {
        eprintln!("sample has no boundary_index; skipping");
        return;
    }
    let (l, r, [a, b, c], d1, d2) = straddle_case(&s).expect("a break with a chain across it");
    for ordered in [false, true] {
        let q = ProximityQuery {
            terms: vec![surface(&a), surface(&b), surface(&c)],
            distances: vec![d1 as usize, d2 as usize],
            ordered,
            and_terms: vec![],
        };
        let hits = all_results(&s, &q);
        let hit = hits
            .iter()
            .find(|h| h.crosses_page && h.id == l.id && ((h.part_index, h.page_id) == (l.part_index, l.page_id) || (h.part_index, h.page_id) == (r.part_index, r.page_id)))
            .unwrap_or_else(|| panic!("{a} ~{d1} {b} ~{d2} {c} (ordered {ordered}) straddles {:?}|{:?}", l, r));
        // Two words on the left page, one on the right: the left page owns it.
        assert_eq!((hit.part_index, hit.page_id), (l.part_index, l.page_id));
        let sec = hit.secondary.as_ref().unwrap();
        assert_eq!((sec.part_index, sec.page_id), (r.part_index, r.page_id));
        assert_eq!(sec.matched_token_indices, vec![0]);
        assert_eq!(hit.matched_token_indices.len(), 2);
    }
}

#[test]
fn a_page_term_on_the_second_page_of_a_straddle_keeps_the_hit() {
    let Some(s) = open() else { return };
    if !s.engine.has_boundary_index() {
        eprintln!("sample has no boundary_index; skipping");
        return;
    }
    let (l, r, [a, b, c], d1, d2) = straddle_case(&s).expect("a break with a chain across it");
    // A word of the right page that the left page does not have.
    let ls: HashSet<String> = surfaces(&s, l).into_iter().collect();
    let rs = surfaces(&s, r);
    let only_right = rs.iter().skip(1).find(|w| plain(w) && !ls.contains(*w)).expect("a word only on the second page").clone();
    let chain = |and: Vec<SearchTerm>| ProximityQuery {
        terms: vec![surface(&a), surface(&b), surface(&c)],
        distances: vec![d1 as usize, d2 as usize],
        ordered: false,
        and_terms: and,
    };
    let is_ours = |h: &kashshaf_engine::SearchResult| h.crosses_page && h.id == l.id && (h.part_index, h.page_id) == (l.part_index, l.page_id);
    // Present on the second page only: the hit stays, on the same page.
    let kept = all_results(&s, &chain(vec![surface(&only_right)]));
    assert!(kept.iter().any(is_ours), "the page term {only_right} is on the second page: the hit is kept");
    // A word on neither page: the hit goes.
    let nowhere = "كلمةلاتوجد";
    let dropped = all_results(&s, &chain(vec![surface(nowhere)]));
    assert!(!dropped.iter().any(is_ours), "a page term on neither page drops the hit");
    // And on a single page: the AND term narrows the page set, never widens it.
    let base: BTreeSet<_> = all_results(&s, &chain(vec![])).iter().map(key_of).collect();
    let narrowed: BTreeSet<_> = kept.iter().map(key_of).collect();
    assert!(narrowed.is_subset(&base));
}
