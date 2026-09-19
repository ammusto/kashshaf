//! Where one table-of-contents load spends its time, book by book:
//! `cargo run --release -p kashshaf-engine --example toc_profile -- <data_dir> <book_id>...`
use kashshaf_engine::toc::{nest, TocDb};
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("data dir"));
    let db = TocDb::open_in(&dir)?;
    for id in args {
        let id: u64 = id.parse()?;
        // Warm the page cache once so the query time is the query, not the disk.
        let _ = db.rows(id)?;
        let t = Instant::now();
        let rows = db.rows(id)?;
        let t_rows = t.elapsed();
        let n = rows.len();
        let t = Instant::now();
        let tree = nest(rows);
        let t_nest = t.elapsed();
        let t = Instant::now();
        let json = serde_json::to_string(&tree)?;
        let t_json = t.elapsed();
        let t = Instant::now();
        let _back: Vec<kashshaf_engine::TocNode> = serde_json::from_str(&json)?;
        let t_parse = t.elapsed();
        println!(
            "book {id}: {n} rows; query {:.1} ms; nest {:.1} ms; serialise {:.1} ms ({} bytes); parse-back {:.1} ms",
            t_rows.as_secs_f64() * 1e3,
            t_nest.as_secs_f64() * 1e3,
            t_json.as_secs_f64() * 1e3,
            json.len(),
            t_parse.as_secs_f64() * 1e3
        );
    }
    Ok(())
}
