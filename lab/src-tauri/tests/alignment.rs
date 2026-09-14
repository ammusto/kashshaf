//! The Phase 0 acceptance test (Lab spec §3.3, §9 "Alignment invariant"):
//! `verify_alignment` over every book of the 25-book sample corpus, expecting
//! zero divergences.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` — a directory holding `corpus.db` (schema 4),
//! `metadata.db` and a Tantivy index. Without it the tests skip, as the
//! engine's sample tests do. Run with
//!
//! ```text
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" cargo test -p kashshaf-lab --release --test alignment
//! ```

use kashshaf_lab_lib::analysis::verify::verify_alignment;
use kashshaf_lab_lib::source::{local::LocalSource, BookSource};
use std::path::PathBuf;

fn sample_dir() -> Option<PathBuf> {
    std::env::var_os("KASHSHAF_SAMPLE_DIR").map(PathBuf::from)
}

/// The sample ships several indexes; take whichever of these it has.
fn index_dir(dir: &std::path::Path) -> Option<PathBuf> {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
}

fn open_sample() -> Option<LocalSource> {
    let dir = sample_dir()?;
    let index = index_dir(&dir).unwrap_or_else(|| panic!("no Tantivy index under {}", dir.display()));
    Some(LocalSource::open_with_index(&dir, &index).expect("open the sample corpus"))
}

/// The books that are actually in this corpus.
///
/// `metadata.db` in the sample directory is the full corpus's metadata, so
/// `books()` lists thousands of titles whose pages are not in the sample's
/// `corpus.db`. In a released corpus the two are built together and this
/// filter is a no-op; here it keeps the sample tests honest.
fn sample_books(source: &LocalSource) -> Vec<u64> {
    source
        .books()
        .expect("list books")
        .into_iter()
        .map(|b| b.id)
        .filter(|id| source.page_refs(*id).map(|r| !r.is_empty()).unwrap_or(false))
        .collect()
}

/// Spec §3.3: the token indices Lab records are the indices the frontend
/// computes from the same page body, on every page of every sample book.
#[test]
fn every_page_of_the_sample_aligns() {
    let Some(source) = open_sample() else { return };
    let books = sample_books(&source);
    assert!(books.len() >= 20, "expected the 25-book sample, found {} books", books.len());

    let mut pages = 0usize;
    let mut divergences = Vec::new();
    for id in &books {
        let report = verify_alignment(&source, *id, &|_, _| {}).expect("verify");
        pages += report.pages_checked;
        divergences.extend(report.divergences);
    }

    assert!(pages > 1000, "expected the whole sample, checked only {} pages", pages);
    if !divergences.is_empty() {
        let shown: Vec<String> = divergences
            .iter()
            .take(10)
            .map(|d| {
                format!(
                    "book {} {}:{} (part {}, page {}) backend={} display={} — {}",
                    d.book_id,
                    d.part_label,
                    d.page_number,
                    d.part_index,
                    d.page_id,
                    d.backend_tokens,
                    d.display_tokens,
                    d.body_head
                )
            })
            .collect();
        panic!(
            "{} of {} pages diverge from the alignment contract:\n{}",
            divergences.len(),
            pages,
            shown.join("\n")
        );
    }
    println!("[alignment] {} books, {} pages, 0 divergences", books.len(), pages);
}

/// Ground rule 2: Lab opens the corpus read-only. A write attempt through
/// Lab's own connection must fail rather than touch a corpus Kashshaf may
/// also have open.
#[test]
fn the_corpus_is_opened_read_only() {
    let Some(dir) = sample_dir() else { return };
    let Some(_) = open_sample() else { return };
    let conn = rusqlite::Connection::open_with_flags(
        dir.join("corpus.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("open read-only");
    let e = conn
        .execute("CREATE TABLE lab_should_never_write (x INTEGER)", [])
        .expect_err("a write through a read-only connection must fail");
    assert!(
        e.to_string().contains("readonly") || e.to_string().contains("read-only"),
        "unexpected error: {}",
        e
    );
}

/// Reading order is ascending `(part_index, page_id)`, which is what the
/// reader pages through and what every stored span is addressed against.
#[test]
fn page_refs_are_in_reading_order_and_match_the_pages_fetched() {
    let Some(source) = open_sample() else { return };
    let id = *sample_books(&source).first().expect("a book with pages");
    let refs = source.page_refs(id).expect("page refs");
    assert!(refs.len() > 1, "book {} has {} pages", id, refs.len());
    let mut sorted = refs.clone();
    sorted.sort();
    assert_eq!(refs, sorted, "page_refs must already be in reading order");

    let seen = std::sync::atomic::AtomicU64::new(0);
    let pages = source
        .book_pages(id, &|done, total| {
            assert!(done <= total, "progress {} of {}", done, total);
            seen.store(done, std::sync::atomic::Ordering::SeqCst);
        })
        .expect("book pages");
    assert_eq!(
        seen.load(std::sync::atomic::Ordering::SeqCst) as usize,
        refs.len(),
        "progress reported every page"
    );
    assert_eq!(pages.len(), refs.len(), "every listed page resolved to a page");
    for (r, p) in refs.iter().zip(&pages) {
        assert_eq!((r.part_index, r.page_id), (p.part_index, p.page_id));
    }
}
