//! `lab-bench` — measure the Phase 0 paths against the targets in spec §8.
//!
//! ```text
//! cargo run -p kashshaf-lab --release --bin lab-bench -- "D:/…/sample-mini"
//! ```
//!
//! Reports, for a corpus directory: open time, the book list, and for the
//! largest book, `page_refs` (what opening a book costs) and `book_pages`
//! (what a whole-book analysis costs), normalised to 500 pages so it can be
//! read against the "Load a book's pages (500 pages) < 1 s" target.

use kashshaf_lab_lib::source::{local::LocalSource, BookSource};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn index_dir(dir: &Path) -> PathBuf {
    ["tantivy_index", "tantivy_index_compound_root", "tantivy_index_compound"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join("tantivy_index"))
}

fn main() -> anyhow::Result<()> {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or(kashshaf_common::get_data_dir()?);

    let t = Instant::now();
    let source = LocalSource::open_with_index(&dir, &index_dir(&dir))?;
    println!("open                  {:>8} ms", t.elapsed().as_millis());

    let t = Instant::now();
    let books = source.books()?;
    println!("books() [{:>5}]       {:>8} ms", books.len(), t.elapsed().as_millis());

    // The biggest book actually present in this corpus.
    let mut biggest: Option<(u64, usize)> = None;
    for b in &books {
        let n = source.page_refs(b.id).map(|r| r.len()).unwrap_or(0);
        if n > biggest.map(|(_, m)| m).unwrap_or(0) {
            biggest = Some((b.id, n));
        }
    }
    let Some((id, n)) = biggest else {
        println!("no book in this corpus has pages");
        return Ok(());
    };

    let t = Instant::now();
    let refs = source.page_refs(id)?;
    println!("page_refs({}) [{:>5}] {:>8} ms", id, refs.len(), t.elapsed().as_millis());

    let t = Instant::now();
    let first = source.page(id, refs[0].part_index, refs[0].page_id)?;
    println!(
        "page() first          {:>8} ms  ({} tokens)",
        t.elapsed().as_millis(),
        first.map(|p| p.tokens.len()).unwrap_or(0)
    );

    // Which half of book_pages costs what: the index lookup that yields the
    // body and the page labels, or the token fetch. Phase 1 needs the whole
    // book at interactive speed, so it matters which one to batch.
    let t = Instant::now();
    for r in &refs {
        let _ = source.engine().get_page(r.book_id, r.part_index as u64, r.page_id)?;
    }
    let index_ms = t.elapsed().as_millis();
    println!("  index get_page only  {:>8} ms   = {:>6.2} ms/page", index_ms, index_ms as f64 / n as f64);

    let t = Instant::now();
    let pages = source.book_pages(id, &|_, _| {})?;
    let ms = t.elapsed().as_millis();
    println!("book_pages [{:>5}]    {:>8} ms   = {:>6.1} ms/page", pages.len(), ms, ms as f64 / n as f64);
    println!(
        "                              -> {:>6.0} ms per 500 pages (spec §8 target: < 1000)",
        ms as f64 / n as f64 * 500.0
    );
    Ok(())
}
