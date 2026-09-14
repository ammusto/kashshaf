//! Mode parity (Lab spec §9): `LocalSource` and `ApiSource` must return the
//! same thing.
//!
//! Every statistic in §4.1 is computed from `BookSource` alone, so if the two
//! implementations agree here they agree everywhere — and if they drift, a
//! number a user reads online differs from the same number offline, silently.
//! This runs a real `kashshaf-api` against the sample corpus and compares.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` and on the API binary being built:
//!
//! ```text
//! cargo build --release -p kashshaf-api
//! KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
//!     cargo test -p kashshaf-lab --release --test mode_parity -- --nocapture
//! ```

use kashshaf_lab_lib::source::{api::ApiSource, local::LocalSource, BookSource};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

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

/// `target/<profile>/kashshaf-api`, beside the directory this test runs from.
/// There is no `CARGO_BIN_EXE_` for another crate's binary.
fn api_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?; // .../deps/<test> -> .../<profile>
    let path = dir.join(format!("kashshaf-api{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").expect("bind").local_addr().expect("addr").port()
}

/// A `kashshaf-api` serving the sample corpus, killed when the test ends.
struct Server {
    child: Child,
    base: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    /// Start the server and wait for `/health`. `None` when the sample or the
    /// binary is missing, which is a skip, not a failure.
    fn start() -> Option<Self> {
        let dir = sample_dir()?;
        let Some(bin) = api_binary() else {
            eprintln!("kashshaf-api is not built; run `cargo build --release -p kashshaf-api`. Skipped.");
            return None;
        };
        // The API expects `tantivy_index`; the sample may name it otherwise.
        let index = index_dir(&dir);
        if index.file_name().map(|n| n != "tantivy_index").unwrap_or(true) {
            eprintln!(
                "the sample's index is {}, but kashshaf-api reads <data dir>/tantivy_index. Skipped.",
                index.display()
            );
            return None;
        }

        let port = free_port();
        let child = Command::new(bin)
            .env("KASHSHAF_DATA_DIR", &dir)
            .env("KASHSHAF_BIND", format!("127.0.0.1:{}", port))
            // The bulk route is exempt from the per-request limiter, but leave
            // the limiter off entirely so nothing else in the test trips it.
            .env("KASHSHAF_RATE_LIMIT", "0")
            .spawn()
            .expect("spawn kashshaf-api");
        let base = format!("http://127.0.0.1:{}", port);

        let client = reqwest::blocking::Client::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            if client.get(format!("{}/health", base)).send().map(|r| r.status().is_success()).unwrap_or(false) {
                return Some(Server { child, base });
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        panic!("kashshaf-api did not become healthy at {}", base);
    }

    /// No disk cache: the test must compare what the server sends, not what a
    /// previous run left behind.
    fn source(&self) -> ApiSource {
        ApiSource::connect_with_cache(&self.base, None).expect("connect to the test server")
    }
}

fn local() -> LocalSource {
    let dir = sample_dir().expect("checked by the caller");
    LocalSource::open_with_index(&dir, &index_dir(&dir)).expect("open the sample corpus")
}

/// Books that are actually in this corpus, biggest first, capped so the test
/// stays a few seconds rather than minutes.
fn books_with_pages(local: &LocalSource, n: usize) -> Vec<u64> {
    let mut ids: Vec<(u64, usize)> = local
        .books()
        .expect("books")
        .into_iter()
        .filter_map(|b| local.page_refs(b.id).ok().map(|r| (b.id, r.len())))
        .filter(|(_, len)| *len > 0)
        .collect();
    ids.sort_by_key(|(_, len)| std::cmp::Reverse(*len));
    ids.into_iter().take(n).map(|(id, _)| id).collect()
}

#[test]
fn health_reports_the_bulk_route_and_the_same_corpus() {
    let Some(server) = Server::start() else { return };
    let api = server.source();
    assert!(api.supports_bulk_tokens(), "the server must report bulk_tokens (spec §5.1)");
    assert_eq!(api.corpus_version(), local().corpus_version(), "both modes serve one corpus");
}

#[test]
fn the_book_list_is_identical_in_both_modes() {
    let Some(server) = Server::start() else { return };
    let (local, api) = (local(), server.source());

    let a = local.books().expect("local books");
    let b = api.books().expect("api books");
    assert_eq!(a.len(), b.len(), "different numbers of books");

    // The orders must agree including where undated books fall: SQLite's bare
    // ASC puts NULLs first and the API asks for NULLS LAST. Say so when the
    // fixture cannot exercise it, rather than letting it read as covered.
    if !a.iter().any(|x| x.death_ah.is_none()) {
        eprintln!("note: no in-corpus book in this sample has a NULL death_ah; the NULLS-LAST half of the ordering is not exercised here");
    }
    // Order matters: the browser shows this list as it arrives.
    for (x, y) in a.iter().zip(&b) {
        assert_eq!((x.id, &x.title), (y.id, &y.title), "book lists diverge");
        assert_eq!(x.death_ah, y.death_ah);
        assert_eq!(x.page_count, y.page_count);
        assert_eq!(x.in_corpus, y.in_corpus);
    }
}

#[test]
fn a_whole_book_is_identical_in_both_modes() {
    let Some(server) = Server::start() else { return };
    let (local, api) = (local(), server.source());

    for id in books_with_pages(&local, 3) {
        let a = local.book_pages(id, &|_, _| {}).expect("local book_pages");
        let b = api.book_pages(id, &|_, _| {}).expect("api book_pages");
        assert_eq!(a.len(), b.len(), "book {}: page counts differ", id);
        assert!(!a.is_empty(), "book {} is empty", id);

        for (x, y) in a.iter().zip(&b) {
            assert_eq!(
                (x.part_index, x.page_id, &x.part_label, &x.page_number),
                (y.part_index, y.page_id, &y.part_label, &y.page_number),
                "book {}: page coordinates or labels differ",
                id
            );
            assert_eq!(x.body, y.body, "book {} page {}: bodies differ", id, x.page_id);
            assert_eq!(
                x.tokens.len(),
                y.tokens.len(),
                "book {} page {}: token counts differ",
                id,
                x.page_id
            );
            for (s, t) in x.tokens.iter().zip(&y.tokens) {
                assert_eq!(s.idx, t.idx);
                assert_eq!(s.surface, t.surface);
                assert_eq!(s.lemma, t.lemma);
                assert_eq!(s.root, t.root);
                assert_eq!(s.pos, t.pos);
                assert_eq!(s.features, t.features);
            }
        }
        // page_refs must agree with the pages themselves, in both modes.
        let refs_local = local.page_refs(id).expect("local page_refs");
        let refs_api = api.page_refs(id).expect("api page_refs");
        assert_eq!(refs_local, refs_api, "book {}: page_refs differ", id);
        assert_eq!(refs_local.len(), a.len());
    }
}

#[test]
fn a_single_page_is_identical_in_both_modes() {
    let Some(server) = Server::start() else { return };
    let (local, api) = (local(), server.source());

    let id = books_with_pages(&local, 1)[0];
    let refs = local.page_refs(id).expect("page_refs");
    // First, last and middle: the ends are where off-by-one shows up.
    for r in [refs[0], refs[refs.len() / 2], refs[refs.len() - 1]] {
        let a = local.page(r.book_id, r.part_index, r.page_id).expect("local page").expect("page");
        let b = api.page(r.book_id, r.part_index, r.page_id).expect("api page").expect("page");
        assert_eq!(a.body, b.body);
        assert_eq!(a.part_label, b.part_label);
        assert_eq!(a.page_number, b.page_number);
        assert_eq!(a.tokens.len(), b.tokens.len());
    }
}

/// Spec §5.1: a book that is not in the corpus is 404, which reaches the
/// caller as an error naming the book, not as an empty book.
#[test]
fn an_unknown_book_is_an_error_not_an_empty_book() {
    let Some(server) = Server::start() else { return };
    let api = server.source();
    let e = api.book_pages(999_999_999, &|_, _| {}).unwrap_err().to_string();
    assert!(e.contains("999999999"), "{}", e);
}

/// Spec §5.1: a matching `If-None-Match` gets 304, and the ETag is
/// `corpus_version + book_id`.
#[test]
fn a_conditional_request_is_answered_with_304() {
    let Some(server) = Server::start() else { return };
    let local = local();
    let id = books_with_pages(&local, 1)[0];

    let client = reqwest::blocking::Client::new();
    let url = format!("{}/book/{}/tokens", server.base, id);
    let first = client.get(&url).send().expect("first request");
    assert!(first.status().is_success());
    let etag = first.headers().get("etag").expect("an ETag").to_str().unwrap().to_string();
    assert_eq!(etag, format!("\"{}-{}\"", local.corpus_version(), id));
    assert_eq!(
        first.headers().get("content-encoding").map(|v| v.to_str().unwrap()),
        Some("zstd")
    );
    assert_eq!(
        first.headers().get("cache-control").map(|v| v.to_str().unwrap()),
        Some("public, max-age=86400")
    );

    let second = client
        .get(&url)
        .header("If-None-Match", &etag)
        .send()
        .expect("conditional request");
    assert_eq!(second.status().as_u16(), 304);

    // A stale ETag is not a match.
    let third = client
        .get(&url)
        .header("If-None-Match", "\"0.0.0-1\"")
        .send()
        .expect("stale conditional request");
    assert!(third.status().is_success());
}
