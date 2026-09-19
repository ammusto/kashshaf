//! How long a book's spine takes to list:
//! `cargo run --release -p kashshaf-engine --example spine_profile -- <data_dir> <book_id>...`
use kashshaf_engine::search::{EngineConfig, SearchEngine};
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index"), Some(&dir.join("corpus.db")), EngineConfig::default())?;
    for id in args {
        let id: u64 = id.parse()?;
        for pass in ["cold", "warm"] {
            let t = Instant::now();
            let spine = engine.book_pages(id)?;
            let took = t.elapsed();
            let t = Instant::now();
            let json = serde_json::to_string(&spine)?;
            println!(
                "book {id} {pass}: {} pages; book_pages {:.0} ms; serialise {:.1} ms ({} bytes)",
                spine.len(),
                took.as_secs_f64() * 1e3,
                t.elapsed().as_secs_f64() * 1e3,
                json.len()
            );
        }
        // Cross-check against the stored documents, the source the columns replaced.
        let t = Instant::now();
        let spine = engine.book_pages(id)?;
        let mut wrong = 0;
        for e in &spine {
            let page = engine.get_page(id, e.part_index, e.page_id)?.expect("page exists");
            if page.part_label != e.part_label || page.page_number != e.page_number {
                wrong += 1;
                if wrong <= 3 {
                    println!("  mismatch {}:{} column ({}, {}) store ({}, {})", e.part_index, e.page_id, e.part_label, e.page_number, page.part_label, page.page_number);
                }
            }
        }
        println!("book {id}: {wrong} of {} entries differ from the stored documents (checked in {:.0} ms)", spine.len(), t.elapsed().as_secs_f64() * 1e3);
    }
    Ok(())
}
