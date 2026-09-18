//! Parity and pagination tests against a real (sample) compound corpus.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` — a directory holding `corpus.db` (schema 4)
//! and `tantivy_index_compound_root/`. Without it every test passes
//! trivially (skips). Run with
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" cargo test --release --test sample_parity
//! ```

use kashshaf_engine::forward::{self, Members};
use kashshaf_engine::glob::GlobPattern;
use kashshaf_engine::{
    normalize_arabic, EngineConfig, PageKey, SearchEngine, SearchFilters, SearchMode, SearchResults, SearchTerm,
    TokenCache, TripleMaps,
};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

struct Sample {
    engine: SearchEngine,
    cache: Arc<TokenCache>,
    triples: TripleMaps,
    /// Every page's triple ids, by key.
    pages: HashMap<PageKey, Vec<u32>>,
}

fn sample_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from)
}

fn open(config: EngineConfig) -> Option<Sample> {
    let dir = sample_dir()?;
    let db = dir.join("corpus.db");
    let index = dir.join("tantivy_index_compound_root");
    let mut engine = SearchEngine::open_with_corpus(&index, Some(&db), config).expect("open sample engine");
    let cache = Arc::new(TokenCache::new(db.clone(), 100_000).expect("token cache"));
    engine.set_token_cache(cache.clone());
    let triples = TripleMaps::load(&db).expect("triples").expect("schema 4");

    // Every page of the corpus, as triple ids.
    let conn = rusqlite::Connection::open(&db).expect("sqlite");
    let mut stmt = conn.prepare("SELECT book_id, part_index, page_id FROM page_tokens").unwrap();
    let keys: Vec<PageKey> = stmt
        .query_map([], |r| Ok(PageKey::new(r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))
        .unwrap()
        .map(|k| k.unwrap())
        .collect();
    let mut pages = HashMap::with_capacity(keys.len());
    for chunk in keys.chunks(2000) {
        let ids = cache.get_ids_batch(chunk).expect("ids");
        for (k, defs) in ids {
            pages.insert(k, defs.iter().map(|&d| triples.triple_of_def(d)).collect());
        }
    }
    assert!(pages.len() > 1000, "sample has {} pages", pages.len());
    Some(Sample { engine, cache, triples, pages })
}

fn key_of(r: &kashshaf_engine::SearchResult) -> PageKey {
    PageKey::new(r.id, r.part_index, r.page_id)
}

/// All pages of a wildcard query through the engine (exact mode).
fn all_wildcard_pages(engine: &SearchEngine, query: &str) -> (usize, Vec<PageKey>) {
    let filters = SearchFilters::default();
    let mut keys = Vec::new();
    let mut offset = 0;
    let mut total;
    loop {
        let r = engine.wildcard_search(query, &filters, 250, offset).expect("wildcard");
        total = r.total_hits;
        if r.results.is_empty() {
            break;
        }
        keys.extend(r.results.iter().map(key_of));
        offset += r.results.len();
        if offset >= total {
            break;
        }
    }
    (total, keys)
}

/// Brute-force wildcard matching over every page: membership of each
/// token's triple in the slot set (adjacent slots for phrases).
fn brute_force_wildcard(s: &Sample, query: &str) -> BTreeSet<PageKey> {
    let normalized = normalize_arabic(query);
    let members: Vec<Members> = normalized
        .split_whitespace()
        .map(|w| Members::from_ids(&s.triples.triples_for_glob(&GlobPattern::parse(w)), 0))
        .collect();
    s.pages
        .iter()
        .filter(|(_, ids)| match members.len() {
            1 => !forward::member_positions(ids, &members[0]).is_empty(),
            _ => !forward::phrase_starts(ids, &members).is_empty(),
        })
        .map(|(k, _)| *k)
        .collect()
}

#[test]
fn every_wildcard_shape_matches_brute_force() {
    let Some(s) = open(EngineConfig { exact_counts: true, ..EngineConfig::default() }) else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    // prefix, suffix, infix, contains, multi-segment, one-letter infix,
    // phrase with a wide slot (walk), phrase with a narrow slot (regex),
    // phrase with two wildcard words.
    for q in ["أب*", "*رف", "أح*مد", "*قول*", "مع*رف*", "م*رف", "ال*", "ابن ال*", "ابو *الله", "ابن *ال*", "*ية"] {
        let expected = brute_force_wildcard(&s, q);
        let (total, keys) = all_wildcard_pages(&s.engine, q);
        let got: BTreeSet<PageKey> = keys.iter().copied().collect();
        assert_eq!(total, expected.len(), "{}: total_hits", q);
        assert_eq!(keys.len(), got.len(), "{}: duplicate pages across pages", q);
        assert_eq!(got, expected, "{}: page set", q);
        assert!(!expected.is_empty(), "{}: expected some hits on the sample", q);
        eprintln!("{:12} {:>6} pages ok", q, total);
    }
}

fn page_json(r: &SearchResults) -> String {
    serde_json::to_string(&r.results).unwrap()
}

#[test]
fn pages_are_identical_from_cache_and_fresh_walk() {
    let Some(s) = open(EngineConfig::default()) else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let filters = SearchFilters::default();
    let limit = 250;
    // Wildcard phrase with a wide slot (hybrid walk) and a proximity walk.
    let prox = (SearchTerm { query: "الله".into(), mode: SearchMode::Surface }, SearchTerm { query: "قال".into(), mode: SearchMode::Lemma });
    let run_wc = |offset: usize| s.engine.wildcard_search("ابن ال*", &filters, limit, offset).unwrap();
    let run_px = |offset: usize| s.engine.proximity_search(&prox.0, &prox.1, 10, &filters, limit, offset).unwrap();

    for (name, run) in [("wildcard", &run_wc as &dyn Fn(usize) -> SearchResults), ("proximity", &run_px)] {
        // Warm: page 1 starts the walk; wait for the prefix to settle.
        let first = run(0);
        s.engine.wait_walks();
        let settled = run(0);
        let n_pages = (settled.total_hits + limit - 1) / limit;
        assert!(n_pages >= 3, "{}: need several pages on the sample, got {}", name, settled.total_hits);
        let cached: Vec<String> = (0..n_pages).map(|p| page_json(&run(p * limit))).collect();
        let cached_total = settled.total_hits;
        assert!(first.results.len() == limit || first.total_hits == settled.total_hits);

        // Fresh: clear the cache before every page so each one is served by
        // a brand-new walk (which may still be running when the page returns).
        for (p, expect) in cached.iter().enumerate() {
            s.engine.clear_walk_cache();
            let fresh = run(p * limit);
            assert_eq!(&page_json(&fresh), expect, "{}: page {} differs between cache and fresh walk", name, p + 1);
            s.engine.wait_walks();
            let after = run(p * limit);
            assert_eq!(after.total_hits, cached_total, "{}: settled total differs", name);
            assert_eq!(page_json(&after), *expect);
        }
        eprintln!("{}: {} pages identical ({} hits)", name, n_pages, cached_total);
    }
}

#[test]
fn exact_and_capped_share_the_same_prefix() {
    let cap = 500;
    let Some(s) = open(EngineConfig { max_verified_hits: cap, ..EngineConfig::default() }) else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set: skipped");
        return;
    };
    let filters = SearchFilters::default();
    let t1 = SearchTerm { query: "الله".into(), mode: SearchMode::Surface };
    let t2 = SearchTerm { query: "قال".into(), mode: SearchMode::Lemma };

    s.engine.set_exact_counts(true);
    let exact1 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, 0).unwrap();
    let exact2 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, 250).unwrap();
    assert!(exact1.was_capped.is_none());
    assert!(exact1.total_hits > cap, "sample proximity has {} hits", exact1.total_hits);

    s.engine.set_exact_counts(false);
    let capped1 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, 0).unwrap();
    s.engine.wait_walks();
    let capped1 = if capped1.total_hits == cap { capped1 } else { s.engine.proximity_search(&t1, &t2, 10, &filters, 250, 0).unwrap() };
    let capped2 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, 250).unwrap();
    assert_eq!(capped1.total_hits, cap);
    assert_eq!(capped1.was_capped, Some(true));
    assert_eq!(page_json(&capped1), page_json(&exact1));
    assert_eq!(page_json(&capped2), page_json(&exact2));
    // Beyond the cap the capped walk has nothing; the exact one continues.
    let capped3 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, cap).unwrap();
    assert!(capped3.results.is_empty());
    s.engine.set_exact_counts(true);
    let exact3 = s.engine.proximity_search(&t1, &t2, 10, &filters, 250, cap).unwrap();
    assert!(!exact3.results.is_empty());
    eprintln!("exact {} hits, capped {} (+), first {} identical", exact1.total_hits, capped1.total_hits, cap);

    // The wildcard highlight path agrees with membership on the page.
    let r = s.engine.wildcard_search("ابن ال*", &filters, 5, 0).unwrap();
    for row in &r.results {
        let key = key_of(row);
        let ids = &s.pages[&key];
        let members: Vec<Members> = ["ابن", "ال*"]
            .iter()
            .map(|w| Members::from_ids(&s.triples.triples_for_glob(&GlobPattern::parse(w)), 0))
            .collect();
        let expect = forward::phrase_positions(ids, &members);
        assert_eq!(row.matched_token_indices, expect[..expect.len().min(50)].to_vec());
        let via_page = s.engine.wildcard_match_positions(&s.cache, row.id, row.part_index, row.page_id, "ابن ال*").unwrap();
        assert_eq!(via_page, expect);
    }
}

/// The reader's spine: `book_pages` has to be the book in reading order, one
/// entry per page the reader can actually show, with the labels the book
/// prints. The continuous scroll steps through it instead of adding one to a
/// page id, which is wrong in every book whose parts restart their numbering.
#[test]
fn book_pages_is_the_book_in_reading_order() {
    let Some(s) = open(EngineConfig::default()) else { return };

    let conn = rusqlite::Connection::open(sample_dir().unwrap().join("corpus.db")).unwrap();
    let mut stmt = conn
        .prepare("SELECT book_id, COUNT(*) c FROM page_tokens GROUP BY book_id ORDER BY c DESC LIMIT 3")
        .unwrap();
    let books: Vec<u64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .map(|id| id as u64)
        .collect();
    assert!(!books.is_empty(), "the sample has no pages");

    for book in books {
        let spine = s.engine.book_pages(book).unwrap();
        assert!(!spine.is_empty(), "book {book} has no pages");

        // Reading order, strictly: no duplicates, no page out of place.
        let keys: Vec<(u64, u64)> = spine.iter().map(|e| (e.part_index, e.page_id)).collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(keys, sorted, "book {book}'s spine is not in reading order");

        // Every entry is a page the reader can open, and the labels agree
        // with what the page itself reports.
        for entry in spine.iter().take(40) {
            let page = s
                .engine
                .get_page(book, entry.part_index, entry.page_id)
                .unwrap()
                .unwrap_or_else(|| panic!("book {book} spine names a page that cannot be opened: {entry:?}"));
            assert_eq!(page.part_label, entry.part_label);
            assert_eq!(page.page_number, entry.page_number);
        }

        // The step the reader takes at a part boundary is the one the spine
        // gives, and it is not "the next page id".
        let boundary = spine.windows(2).find(|w| w[0].part_index != w[1].part_index);
        if let Some(w) = boundary {
            eprintln!(
                "book {book}: part boundary {}:{} -> {}:{}",
                w[0].part_index, w[0].page_id, w[1].part_index, w[1].page_id
            );
            assert!(w[1].part_index > w[0].part_index);
        }
    }
}
