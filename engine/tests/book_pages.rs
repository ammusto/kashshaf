//! `TokenCache::book_pages` / `resolve_pages` against the per-page path.
//!
//! The bulk path exists to make a whole book affordable (Lab spec §8); it is
//! only usable if it returns exactly what the per-page path returns, in
//! reading order, for every page. That is what these check.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` (a directory with `corpus.db`, schema 3 or
//! 4); skipped without it.
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
//!     cargo test --release --test book_pages -- --nocapture
//! ```

use kashshaf_engine::{PageKey, TokenCache};
use std::path::PathBuf;

fn cache() -> Option<TokenCache> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    Some(TokenCache::new(dir.join("corpus.db"), 1000).expect("open the sample corpus.db"))
}

/// A few books that actually have pages, biggest first.
fn books(cache: &TokenCache) -> Vec<u64> {
    let conn = rusqlite::Connection::open(cache.db_path()).expect("open");
    let mut stmt = conn
        .prepare(
            "SELECT book_id, COUNT(*) c FROM page_tokens GROUP BY book_id ORDER BY c DESC LIMIT 5",
        )
        .expect("prepare");
    stmt.query_map([], |r| r.get::<_, i64>(0))
        .expect("query")
        .filter_map(|r| r.ok())
        .map(|id| id as u64)
        .collect()
}

#[test]
fn bulk_ids_match_the_per_page_path_and_are_in_reading_order() {
    let Some(cache) = cache() else { return };
    let books = books(&cache);
    assert!(!books.is_empty(), "the sample corpus has no pages");

    for book in books {
        let bulk = cache.book_pages(book).expect("book_pages");
        assert!(bulk.len() > 1, "book {} has {} pages", book, bulk.len());

        // Reading order is ascending (part_index, page_id) — the same key the
        // index is built on.
        let coords: Vec<(u64, u64)> = bulk.iter().map(|(p, g, _)| (*p, *g)).collect();
        let mut sorted = coords.clone();
        sorted.sort_unstable();
        assert_eq!(coords, sorted, "book {} is not in reading order", book);
        sorted.dedup();
        assert_eq!(sorted.len(), coords.len(), "book {} lists a page twice", book);

        for (part_index, page_id, ids) in &bulk {
            let one = cache
                .get_ids(&PageKey::new(book, *part_index, *page_id))
                .expect("get_ids");
            assert_eq!(
                &*one, ids,
                "book {} part {} page {}: bulk ids differ from get_ids",
                book, part_index, page_id
            );
        }
    }
}

#[test]
fn resolved_tokens_match_the_per_page_path() {
    let Some(cache) = cache() else { return };
    let book = *books(&cache).first().expect("a book");
    let bulk = cache.book_pages(book).expect("book_pages");

    // The whole book at once, then every page compared against `get`.
    let ids: Vec<Vec<u32>> = bulk.iter().map(|(_, _, ids)| ids.clone()).collect();
    let resolved = cache.resolve_pages(&ids).expect("resolve_pages");
    assert_eq!(resolved.len(), bulk.len());

    for ((part_index, page_id, _), tokens) in bulk.iter().zip(&resolved) {
        let one = cache.get(&PageKey::new(book, *part_index, *page_id)).expect("get");
        assert_eq!(one.len(), tokens.len(), "part {} page {}", part_index, page_id);
        for (a, b) in one.iter().zip(tokens) {
            assert_eq!(a.idx, b.idx);
            assert_eq!(a.surface, b.surface);
            assert_eq!(a.lemma, b.lemma);
            assert_eq!(a.root, b.root);
            assert_eq!(a.pos, b.pos);
            assert_eq!(a.features, b.features);
        }
    }
}

#[test]
fn an_unknown_book_is_empty_not_an_error() {
    let Some(cache) = cache() else { return };
    assert!(cache.book_pages(u64::MAX).expect("book_pages").is_empty());
    assert!(cache.resolve_pages(&[]).expect("resolve_pages").is_empty());
    // A page of no tokens resolves to no tokens, not to a placeholder.
    let empty = cache.resolve_pages(&[vec![]]).expect("resolve_pages");
    assert_eq!(empty.len(), 1);
    assert!(empty[0].is_empty());
}

/// The bulk path must not evict what a reader or a search has warmed: a book
/// is far larger than the LRU.
#[test]
fn the_bulk_path_leaves_the_caches_alone() {
    let Some(cache) = cache() else { return };
    let book = *books(&cache).first().expect("a book");
    let bulk = cache.book_pages(book).expect("book_pages");
    let key = PageKey::new(book, bulk[0].0, bulk[0].1);

    cache.clear();
    let _ = cache.get(&key).expect("warm one page");
    let (warm, _) = cache.stats();   // (pages cached, capacity)
    assert!(warm > 0, "a page was cached");

    let before = cache.stats();
    let _ = cache.book_pages(book).expect("book_pages again");
    assert_eq!(cache.stats(), before, "book_pages must not touch the LRUs");
}
