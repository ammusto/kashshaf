//! Matches across page breaks, end to end on the sample corpus.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` — a directory holding `corpus.db`,
//! `tantivy_index_compound_root/` and `boundary_index/` (built by
//! `build_boundary_index.py --data-dir data/sample`). Without it every test
//! passes vacuously.
//!
//!     KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data/data/sample" cargo test --release --test boundary_sample

use kashshaf_engine::{EngineConfig, PageKey, SearchEngine, SearchFilters, SearchMode, SearchResult, SearchTerm, TokenCache};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

struct Sample {
    engine: SearchEngine,
    cache: Arc<TokenCache>,
    /// Every page's key in reading order per book: `book -> [(part, page)]`.
    spines: HashMap<u64, Vec<PageKey>>,
}

fn open() -> Option<Sample> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    if !dir.join("boundary_index").is_dir() {
        eprintln!("sample has no boundary_index; skipping");
        return None;
    }
    let db = dir.join("corpus.db");
    let mut config = EngineConfig::default();
    config.exact_counts = true;
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), config).expect("open sample engine");
    let cache = Arc::new(TokenCache::new(db.clone(), 100_000).expect("token cache"));
    engine.set_token_cache(cache.clone());
    let conn = rusqlite::Connection::open(&db).expect("sqlite");
    let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens ORDER BY book_id, part_index, page_id").unwrap();
    let mut spines: HashMap<u64, Vec<PageKey>> = HashMap::new();
    for k in stmt.query_map([], |r| Ok(PageKey::new(r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64))).unwrap() {
        let k = k.unwrap();
        spines.entry(k.id).or_default().push(k);
    }
    Some(Sample { engine, cache, spines })
}

/// Surfaces of a page's tokens.
fn surfaces(s: &Sample, key: PageKey) -> Vec<String> {
    s.cache.get(&key).map(|t| t.iter().map(|x| x.surface.clone()).collect()).unwrap_or_default()
}

fn term(q: &str) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode: SearchMode::Surface }
}

fn one_book(id: u64) -> SearchFilters {
    SearchFilters { book_ids: Some(vec![id]), ..SearchFilters::default() }
}

/// A word that is plain enough to survive the query normaliser: letters only.
fn plain(w: &str) -> bool {
    w.chars().count() >= 2 && w.chars().all(|c| ('\u{0621}'..='\u{064A}').contains(&c))
}

/// Consecutive page pairs `(left, right)` of a book, with their surfaces.
fn pairs(s: &Sample, book: u64) -> Vec<(PageKey, PageKey, Vec<String>, Vec<String>)> {
    let spine = &s.spines[&book];
    spine
        .windows(2)
        .map(|w| (w[0], w[1], surfaces(s, w[0]), surfaces(s, w[1])))
        .collect()
}

/// The first page break of the book where a phrase of `left_n` words from the
/// end of one page and `right_n` from the start of the next is searchable and
/// found by the engine as a cross hit; `(phrase, left, right, result)`.
fn find_straddle(s: &Sample, book: u64, left_n: usize, right_n: usize, want_part_break: Option<bool>) -> Option<(String, PageKey, PageKey, SearchResult)> {
    for (l, r, ls, rs) in pairs(s, book) {
        if let Some(pb) = want_part_break {
            if (l.part_index != r.part_index) != pb {
                continue;
            }
        }
        if ls.len() < left_n || rs.len() < right_n {
            continue;
        }
        let words: Vec<&str> = ls[ls.len() - left_n..].iter().chain(rs[..right_n].iter()).map(|x| x.as_str()).collect();
        if !words.iter().all(|w| plain(w)) {
            continue;
        }
        let phrase = words.join(" ");
        let res = s.engine.combined_search(&[term(&phrase)], &[], &one_book(book), 50, 0).expect("search");
        if let Some(hit) = res.results.iter().find(|h| h.crosses_page) {
            return Some((phrase, l, r, hit.clone()));
        }
    }
    None
}

#[test]
fn the_engine_opens_the_boundary_index() {
    let Some(s) = open() else { return };
    assert!(s.engine.has_boundary_index());
    assert!(s.engine.capabilities().boundary_index);
    let b = s.engine.boundary_index().unwrap();
    let pages: usize = s.spines.values().map(|v| v.len()).sum();
    assert_eq!(b.document_count(), (pages - s.spines.len()) as u64, "one document per page break");
}

#[test]
fn a_phrase_split_seven_two_is_attributed_to_the_left_page() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let found = books.iter().find_map(|&b| find_straddle(&s, b, 7, 2, None));
    let (phrase, l, r, hit) = found.expect("a 7/2 straddling phrase somewhere in the sample");
    assert_eq!((hit.id, hit.part_index, hit.page_id), (l.id, l.part_index, l.page_id), "primary is the left page for {phrase}");
    let sec = hit.secondary.as_ref().expect("secondary page");
    assert_eq!((sec.part_index, sec.page_id), (r.part_index, r.page_id));
    // Seven tokens on the left page: its last seven; two on the right: its first two.
    let left_len = surfaces(&s, l).len() as u32;
    assert_eq!(hit.matched_token_indices, (left_len - 7..left_len).collect::<Vec<_>>());
    assert_eq!(sec.matched_token_indices, vec![0, 1]);
}

#[test]
fn a_phrase_split_two_seven_is_attributed_to_the_right_page() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let (phrase, l, r, hit) = books.iter().find_map(|&b| find_straddle(&s, b, 2, 7, None)).expect("a 2/7 straddling phrase");
    assert_eq!((hit.id, hit.part_index, hit.page_id), (r.id, r.part_index, r.page_id), "primary is the right page for {phrase}");
    let sec = hit.secondary.as_ref().unwrap();
    assert_eq!((sec.part_index, sec.page_id), (l.part_index, l.page_id));
    assert_eq!(hit.matched_token_indices, (0..7).collect::<Vec<_>>());
    let left_len = surfaces(&s, l).len() as u32;
    assert_eq!(sec.matched_token_indices, vec![left_len - 2, left_len - 1]);
}

#[test]
fn an_even_split_goes_to_the_earlier_page() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let (_, l, _, hit) = books.iter().find_map(|&b| find_straddle(&s, b, 4, 4, None)).expect("a 4/4 straddling phrase");
    assert_eq!((hit.part_index, hit.page_id), (l.part_index, l.page_id));
}

#[test]
fn a_phrase_wholly_inside_a_page_is_never_a_cross_hit() {
    let Some(s) = open() else { return };
    // The last four words of a page, wholly in the left 20 of the boundary
    // document: the main index has that page; the boundary index must not add it.
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let mut checked = 0;
    for &b in &books {
        for (l, _r, ls, _rs) in pairs(&s, b) {
            if ls.len() < 4 {
                continue;
            }
            let words: Vec<&str> = ls[ls.len() - 4..].iter().map(|x| x.as_str()).collect();
            if !words.iter().all(|w| plain(w)) {
                continue;
            }
            let res = s.engine.combined_search(&[term(&words.join(" "))], &[], &one_book(b), 250, 0).expect("search");
            let on_page: Vec<&SearchResult> = res.results.iter().filter(|h| h.part_index == l.part_index && h.page_id == l.page_id).collect();
            assert!(on_page.iter().any(|h| !h.crosses_page), "the page itself is a result");
            assert!(on_page.iter().all(|h| !h.crosses_page), "no cross hit for a phrase the page holds whole");
            checked += 1;
            if checked >= 5 {
                return;
            }
        }
    }
    assert!(checked > 0);
}

#[test]
fn proximity_needs_one_term_on_each_side() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    for &b in &books {
        for (l, r, ls, rs) in pairs(&s, b) {
            if ls.len() < 3 || rs.len() < 3 {
                continue;
            }
            // Last word of the left page, second word of the right page: a
            // pair three apart across the break.
            let (a, c) = (&ls[ls.len() - 1], &rs[1]);
            if !plain(a) || !plain(c) || a == c {
                continue;
            }
            let res = s.engine.proximity_search(&term(a), &term(c), 5, &one_book(b), 250, 0).expect("prox");
            let Some(hit) = res.results.iter().find(|h| h.crosses_page && ((h.part_index, h.page_id) == (l.part_index, l.page_id) || (h.part_index, h.page_id) == (r.part_index, r.page_id))) else {
                continue;
            };
            // 19 + 21 = 40 > 39: the right page owns it.
            assert_eq!((hit.part_index, hit.page_id), (r.part_index, r.page_id), "attribution of {a} ~5 {c}");
            let sec = hit.secondary.as_ref().unwrap();
            assert_eq!(sec.matched_token_indices, vec![ls.len() as u32 - 1]);
            assert_eq!(hit.matched_token_indices, vec![1]);
            // Both terms on one side of the break: the main index's business.
            let same_side = s.engine.proximity_search(&term(&rs[0]), &term(&rs[1]), 5, &one_book(b), 250, 0).expect("prox");
            for h in &same_side.results {
                if h.crosses_page {
                    let sec = h.secondary.as_ref().unwrap();
                    assert!(
                        !(sec.matched_token_indices.is_empty() || h.matched_token_indices.is_empty()),
                        "a cross hit has a share on both pages"
                    );
                }
            }
            return;
        }
    }
    panic!("no proximity pair across a page break was searchable");
}

#[test]
fn a_boundary_across_a_part_break_is_found() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.iter().filter(|(_, v)| v.iter().any(|k| k.part_index > 0)).map(|(b, _)| *b).collect();
    books.sort();
    if books.is_empty() {
        eprintln!("sample has no multi-part book; skipping");
        return;
    }
    let found = books.iter().find_map(|&b| find_straddle(&s, b, 3, 3, Some(true)));
    let (phrase, l, r, hit) = found.expect("a phrase across a part break");
    assert_ne!(l.part_index, r.part_index);
    assert!(hit.crosses_page, "{phrase}");
    let sec = hit.secondary.as_ref().unwrap();
    assert_ne!(hit.part_index, sec.part_index, "the two pages are in different parts");
}

#[test]
fn a_short_padded_page_still_matches() {
    let Some(s) = open() else { return };
    // A page of fewer than 20 tokens followed by a longer one: the boundary
    // document is padded on the left; the phrase still straddles and maps
    // back through the real length.
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    for &b in &books {
        for (l, r, ls, rs) in pairs(&s, b) {
            if ls.len() >= 20 || ls.len() < 2 || rs.len() < 2 {
                continue;
            }
            let words: Vec<&str> = ls[ls.len() - 2..].iter().chain(rs[..2].iter()).map(|x| x.as_str()).collect();
            if !words.iter().all(|w| plain(w)) {
                continue;
            }
            let res = s.engine.combined_search(&[term(&words.join(" "))], &[], &one_book(b), 50, 0).expect("search");
            let Some(hit) = res.results.iter().find(|h| h.crosses_page && (h.part_index, h.page_id) == (l.part_index, l.page_id)) else {
                continue;
            };
            assert_eq!(hit.matched_token_indices, vec![ls.len() as u32 - 2, ls.len() as u32 - 1]);
            assert_eq!(hit.secondary.as_ref().unwrap().matched_token_indices, vec![0, 1]);
            let _ = r;
            return;
        }
    }
    eprintln!("no short page with a searchable straddle in the sample; nothing to check");
}

#[test]
fn page_matches_say_where_a_match_continues() {
    let Some(s) = open() else { return };
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let (phrase, l, r, _) = books.iter().find_map(|&b| find_straddle(&s, b, 3, 2, None)).expect("a straddling phrase");
    let left = s.engine.get_page_matches(l.id, l.part_index, l.page_id, &[term(&phrase)]).unwrap();
    assert!(left.continues_next, "{phrase} runs off the end of {:?}", l);
    let left_len = surfaces(&s, l).len() as u32;
    assert!((left_len - 3..left_len).all(|i| left.indices.contains(&i)));
    let right = s.engine.get_page_matches(r.id, r.part_index, r.page_id, &[term(&phrase)]).unwrap();
    assert!(right.continues_prev);
    assert!(right.indices.contains(&0) && right.indices.contains(&1));
}

#[test]
fn no_result_appears_twice_and_the_count_adds_the_cross_hits_once() {
    let Some(s) = open() else { return };
    // A short, common phrase: many page hits and some across breaks.
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    let (phrase, _, _, _) = books.iter().find_map(|&b| find_straddle(&s, b, 1, 1, None)).expect("a two-word straddle");
    let filters = SearchFilters::default();
    let first = s.engine.combined_search(&[term(&phrase)], &[], &filters, 250, 0).expect("search");
    let total = first.total_hits;
    let mut seen: HashSet<(u64, u64, u64, bool, Option<(u64, u64)>)> = HashSet::new();
    let mut cross = 0usize;
    let mut offset = 0;
    let mut n = 0usize;
    loop {
        let page = s.engine.combined_search(&[term(&phrase)], &[], &filters, 250, offset).expect("page");
        if page.results.is_empty() {
            break;
        }
        for h in &page.results {
            n += 1;
            if h.crosses_page {
                cross += 1;
            }
            let key = (h.id, h.part_index, h.page_id, h.crosses_page, h.secondary.as_ref().map(|x| (x.part_index, x.page_id)));
            assert!(seen.insert(key), "result appeared twice: {:?}", key);
        }
        offset += page.results.len();
        if offset >= total {
            break;
        }
    }
    assert_eq!(n, total, "every counted hit is served once");
    assert!(cross >= 1, "{phrase} straddles at least one break");
    // The main index's own count (phrase_hits never consults the boundary
    // index) plus the cross hits, each once, is the total.
    let (_, main_only) = s.engine.phrase_hits(&phrase, SearchMode::Surface, 0, &filters).expect("phrase_hits");
    assert_eq!(total, main_only + cross);
}
