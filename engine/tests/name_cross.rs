//! The name search on the sample corpus: it retrieves on the minimal
//! patterns with merged first slots and still answers exactly as the OR of
//! every expanded pattern did — the same pages, the same highlight positions
//! — and a name split by a page break is found the way a term phrase is.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` with `boundary_index/` built beside the
//! sample; without it every test passes vacuously.

use kashshaf_engine::{expand_name_patterns, EngineConfig, PageKey, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

struct Sample {
    engine: SearchEngine,
    cache: Arc<TokenCache>,
    spines: HashMap<u64, Vec<PageKey>>,
}

fn open() -> Option<Sample> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    if !dir.join("boundary_index").is_dir() {
        eprintln!("sample has no boundary_index; skipping");
        return None;
    }
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), EngineConfig { exact_counts: true, ..EngineConfig::default() }).ok()?;
    let cache = Arc::new(TokenCache::new(db.clone(), 100_000).ok()?);
    engine.set_token_cache(cache.clone());
    let conn = rusqlite::Connection::open(&db).ok()?;
    let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens ORDER BY book_id, part_index, page_id").ok()?;
    let mut spines: HashMap<u64, Vec<PageKey>> = HashMap::new();
    for k in stmt.query_map([], |r| Ok(PageKey::new(r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64))).ok()? {
        let k = k.ok()?;
        spines.entry(k.id).or_default().push(k);
    }
    Some(Sample { engine, cache, spines })
}

fn surfaces(s: &Sample, key: PageKey) -> Vec<String> {
    s.cache.get(&key).map(|t| t.iter().map(|x| x.surface.clone()).collect()).unwrap_or_default()
}

fn plain(w: &str) -> bool {
    w.chars().count() >= 2 && w.chars().all(|c| ('\u{0621}'..='\u{064A}').contains(&c))
}

fn term(q: &str) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode: SearchMode::Surface }
}

fn one_book(id: u64) -> SearchFilters {
    SearchFilters { book_ids: Some(vec![id]), ..SearchFilters::default() }
}

fn key_of(r: &kashshaf_engine::SearchResult) -> (u64, u64, u64) {
    (r.id, r.part_index, r.page_id)
}

/// A page break where `left_n` words from the end of one page and `right_n`
/// from the start of the next make a plain phrase that the term search finds
/// as a cross hit.
fn straddle(s: &Sample, left_n: usize, right_n: usize) -> Option<(String, PageKey, PageKey, kashshaf_engine::SearchResult)> {
    let mut books: Vec<u64> = s.spines.keys().copied().collect();
    books.sort();
    for b in books {
        for w in s.spines[&b].windows(2) {
            let (l, r) = (w[0], w[1]);
            let (ls, rs) = (surfaces(s, l), surfaces(s, r));
            if ls.len() < left_n || rs.len() < right_n {
                continue;
            }
            let words: Vec<&str> = ls[ls.len() - left_n..].iter().chain(rs[..right_n].iter()).map(|x| x.as_str()).collect();
            if !words.iter().all(|w| plain(w)) {
                continue;
            }
            let phrase = words.join(" ");
            let res = s.engine.combined_search(&[term(&phrase)], &[], &one_book(b), 50, 0).expect("search");
            if let Some(hit) = res.results.iter().find(|h| h.crosses_page) {
                return Some((phrase, l, r, hit.clone()));
            }
        }
    }
    None
}

#[test]
fn a_name_split_by_a_page_break_is_found_as_the_term_phrase_is() {
    let Some(s) = open() else { return };
    for (ln, rn) in [(2, 1), (1, 2)] {
        let (phrase, l, r, term_hit) = straddle(&s, ln, rn).expect("a straddling phrase in the sample");
        // As a displayed name pattern: expanded to the phrase and its proclitic forms.
        let patterns = expand_name_patterns(&[phrase.clone()]);
        assert_eq!(patterns.len(), 6);
        let res = s.engine.name_search(&[patterns], &one_book(l.id), 50, 0).expect("name search");
        let hit = res
            .results
            .iter()
            .find(|h| h.crosses_page && (key_of(h) == (l.id, l.part_index, l.page_id) || key_of(h) == (r.id, r.part_index, r.page_id)))
            .unwrap_or_else(|| panic!("{phrase} as a name straddles {l:?}|{r:?}"));
        // The same hit the term search makes: page, share on each page.
        assert_eq!(key_of(hit), key_of(&term_hit), "{phrase}: the same primary page");
        assert_eq!(hit.matched_token_indices, term_hit.matched_token_indices, "{phrase}: the same positions on the primary");
        let (sec, term_sec) = (hit.secondary.as_ref().unwrap(), term_hit.secondary.as_ref().unwrap());
        assert_eq!((sec.part_index, sec.page_id), (term_sec.part_index, term_sec.page_id));
        assert_eq!(sec.matched_token_indices, term_sec.matched_token_indices);
        // Once, and counted.
        assert_eq!(res.results.iter().filter(|h| h.crosses_page && key_of(h) == key_of(hit)).count(), 1);
        assert!(res.total_hits >= res.results.len());
    }
}

#[test]
fn retrieval_on_the_minimal_merged_patterns_answers_as_the_or_of_every_pattern_did() {
    let Some(s) = open() else { return };
    // A form-shaped list built from words the sample has: a "kunya" shown as
    // اب* plus a run of frequent words, with shorter and longer patterns
    // that contain one another, as the form generates them.
    let display: Vec<String> = ["اب* عبد الله", "اب* عبد الله بن", "عبد الله بن", "عبد الله بن محمد", "اب* عبد", "قال رسول الله"].iter().map(|x| x.to_string()).collect();
    let expanded = expand_name_patterns(&display);
    assert_eq!(expanded.len(), 3 * 18 + 3 * 6);
    let minimal = kashshaf_engine::names::minimal_patterns(&display);
    assert_eq!(minimal, vec!["عبد الله بن".to_string(), "اب* عبد".to_string(), "قال رسول الله".to_string()]);

    let filters = SearchFilters::default();
    // Every hit, so that the cross hits among them do not shorten a window.
    let now = s.engine.name_search(&[expanded.clone()], &filters, 100_000, 0).expect("name search");
    // The old way: every expanded pattern its own phrase query, OR-ed.
    let old = s.engine.probe_tantivy("old", &s.engine.probe_sets(&expanded), &expanded, None, 100_000).expect("probe");
    assert!(old.total_hits > 0, "the sample has these words");
    let now_pages: Vec<_> = now.results.iter().filter(|r| !r.crosses_page).map(key_of).collect();
    let now_hl: Vec<_> = now.results.iter().filter(|r| !r.crosses_page).map(|r| r.matched_token_indices.clone()).collect();
    assert_eq!(now_pages, old.pages, "the same pages in the same order");
    assert_eq!(now_hl, old.highlights, "the same highlight positions, from every pattern");
    let cross = now.results.iter().filter(|r| r.crosses_page).count();
    assert_eq!(now.total_hits, old.total_hits + cross, "the count adds only the cross hits");
    // And what it retrieved on: three phrases, the kunya's eighteen first words as one slot.
    let sets = s.engine.probe_retrieval_sets(&expanded);
    assert_eq!(sets.len(), 3);
    assert!(sets.iter().any(|p| p.len() == 2 && p[0].len() > 6), "the kunya phrase's first slot merges its forms");
}
