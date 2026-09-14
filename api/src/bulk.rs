//! `GET /book/{id}/tokens` — the bulk token fetch (Lab spec §5.1).
//!
//! Kashshaf Lab's unit of work is a whole book: every statistic in spec §4.1
//! needs all of a book's tokens, and fetching them a page at a time over HTTP
//! is not viable. This streams the book as zstd-compressed NDJSON, one line
//! per page, in reading order.
//!
//! It is deliberately *not* behind the per-request rate limiter: one legitimate
//! call transfers a whole book and would otherwise burn a client's whole
//! burst. It carries its own limits instead — concurrent and hourly caps per
//! client — because one call is expensive enough that abuse has to be bounded
//! by something.

use crate::{AppState, ErrorResponse};
use axum::{
    extract::{ConnectInfo, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use kashshaf_engine::Token;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Spec §5.1: at most 4 bulk requests in flight per client.
pub const MAX_CONCURRENT: usize = 4;
/// Spec §5.1: at most 30 per client per hour.
pub const MAX_PER_HOUR: usize = 30;
const HOUR: Duration = Duration::from_secs(3600);

/// One NDJSON line: a page and its tokens.
#[derive(Serialize)]
struct PageLine<'a> {
    part_index: u64,
    page_id: u64,
    part_label: &'a str,
    page_number: &'a str,
    body: &'a str,
    tokens: &'a [Token],
}

/// Per-client bulk-request accounting.
///
/// Keyed by client IP, as the per-request limiter is. Entries expire with
/// their window, so the map cannot grow without bound.
#[derive(Default)]
pub struct BulkLimiter {
    clients: Mutex<HashMap<IpAddr, ClientState>>,
}

#[derive(Default)]
struct ClientState {
    in_flight: usize,
    /// Start times of this client's requests within the last hour.
    recent: Vec<Instant>,
}

/// Held for the life of one bulk request; releases the concurrency slot on
/// drop, including when the handler returns early or the client disconnects.
pub struct BulkPermit {
    limiter: Arc<BulkLimiter>,
    client: IpAddr,
}

impl Drop for BulkPermit {
    fn drop(&mut self) {
        if let Ok(mut clients) = self.limiter.clients.lock() {
            if let Some(state) = clients.get_mut(&self.client) {
                state.in_flight = state.in_flight.saturating_sub(1);
                if state.in_flight == 0 && state.recent.is_empty() {
                    clients.remove(&self.client);
                }
            }
        }
    }
}

/// Why a bulk request was refused, in the words the 429 body carries.
pub enum Refusal {
    TooManyConcurrent,
    TooManyThisHour,
}

impl Refusal {
    fn message(&self) -> String {
        match self {
            Refusal::TooManyConcurrent => format!(
                "too many bulk requests in flight; at most {} at a time per client",
                MAX_CONCURRENT
            ),
            Refusal::TooManyThisHour => {
                format!("bulk request limit reached; at most {} per hour per client", MAX_PER_HOUR)
            }
        }
    }
}

impl BulkLimiter {
    /// Take a slot, or say why not. `now` is a parameter so the windowing is
    /// testable without sleeping.
    pub fn acquire_at(
        self: &Arc<Self>,
        client: IpAddr,
        now: Instant,
    ) -> Result<BulkPermit, Refusal> {
        let mut clients = self.clients.lock().expect("bulk limiter poisoned");
        let state = clients.entry(client).or_default();
        state.recent.retain(|t| now.duration_since(*t) < HOUR);
        if state.in_flight >= MAX_CONCURRENT {
            return Err(Refusal::TooManyConcurrent);
        }
        if state.recent.len() >= MAX_PER_HOUR {
            return Err(Refusal::TooManyThisHour);
        }
        state.in_flight += 1;
        state.recent.push(now);
        Ok(BulkPermit { limiter: Arc::clone(self), client })
    }

    pub fn acquire(self: &Arc<Self>, client: IpAddr) -> Result<BulkPermit, Refusal> {
        self.acquire_at(client, Instant::now())
    }
}

/// `corpus_version + book_id`, per spec §5.1. Quoted, as an ETag must be.
fn etag(corpus_version: Option<&str>, book_id: u64) -> String {
    format!("\"{}-{}\"", corpus_version.unwrap_or("unknown"), book_id)
}

/// An `If-None-Match` that names this ETag. `*` matches anything, and a header
/// may carry a comma-separated list.
fn matches_etag(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(',').any(|c| {
                let c = c.trim();
                c == "*" || c == tag || c.strip_prefix("W/").map(|w| w == tag).unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn too_many(refusal: Refusal) -> Response {
    (StatusCode::TOO_MANY_REQUESTS, Json(ErrorResponse { error: refusal.message() })).into_response()
}

fn not_found(book_id: u64) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse { error: format!("book {} is not in this corpus", book_id) }),
    )
        .into_response()
}

/// Is this book in the corpus? `in_corpus = 0` books have metadata but no
/// pages, and §5.1 says they are 404, not an empty stream.
fn book_in_corpus(state: &AppState, book_id: u64) -> Result<bool, rusqlite::Error> {
    let conn = rusqlite::Connection::open(&state.metadata_db_path)?;
    let found: Option<i64> = conn
        .query_row("SELECT in_corpus FROM books WHERE id = ?1", [book_id as i64], |r| r.get(0))
        .ok();
    Ok(found.map(|v| v != 0).unwrap_or(false))
}

/// Build the whole compressed body.
///
/// The book is serialized and compressed in one blocking task rather than
/// streamed chunk by chunk: a 500-page book is a few MB compressed, the work
/// is CPU-bound, and a single buffered body lets the response carry
/// `Content-Length`, which makes the client's progress reporting honest. The
/// nginx `proxy_read_timeout 300s` in §5.1 covers the time to first byte.
fn render(state: &AppState, book_id: u64) -> anyhow::Result<Vec<u8>> {
    let pages = state.token_cache.book_pages(book_id)?;
    let ids: Vec<Vec<u32>> = pages.iter().map(|(_, _, ids)| ids.clone()).collect();
    let resolved = state.token_cache.resolve_pages(&ids)?;

    let mut ndjson = Vec::with_capacity(pages.len() * 4096);
    for ((part_index, page_id, _), tokens) in pages.iter().zip(&resolved) {
        // A page with no document in the index has no body to align against;
        // LocalSource skips it, so the stream must skip it too, or the two
        // modes would disagree (spec §9, "mode parity").
        let Some(result) = state.search_engine.get_page(book_id, *part_index, *page_id)? else {
            continue;
        };
        let line = PageLine {
            part_index: *part_index,
            page_id: *page_id,
            part_label: &result.part_label,
            page_number: &result.page_number,
            body: &result.body,
            tokens,
        };
        serde_json::to_writer(&mut ndjson, &line)?;
        ndjson.push(b'\n');
    }
    Ok(zstd::encode_all(&ndjson[..], 3)?)
}

/// `GET /book/{id}/tokens` (spec §5.1).
pub async fn get_book_tokens(
    State(state): State<Arc<AppState>>,
    Path(book_id): Path<u64>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let tag = etag(state.corpus_version.as_deref(), book_id);
    // 304 before the limiter: a conditional request costs nothing to answer
    // and must not consume the client's hourly budget.
    if matches_etag(&headers, &tag) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag)]).into_response();
    }

    let permit = match state.bulk_limiter.acquire(client_ip(&headers, peer)) {
        Ok(p) => p,
        Err(refusal) => return too_many(refusal),
    };

    match book_in_corpus(&state, book_id) {
        Ok(true) => {}
        Ok(false) => return not_found(book_id),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e.to_string() }),
            )
                .into_response()
        }
    }

    let s = Arc::clone(&state);
    let body = tokio::task::spawn_blocking(move || render(&s, book_id)).await;
    drop(permit);

    match body {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/x-ndjson".to_string()),
                (header::CONTENT_ENCODING, "zstd".to_string()),
                (header::ETAG, tag),
                (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("bulk task failed: {}", e) }),
        )
            .into_response(),
    }
}

/// The client's address, honouring the proxy headers `SmartIpKeyExtractor`
/// uses, so the bulk caps key on the same client the per-request limiter does.
fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    for name in ["x-forwarded-for", "x-real-ip"] {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            if let Some(first) = v.split(',').next() {
                if let Ok(ip) = first.trim().parse::<IpAddr>() {
                    return ip;
                }
            }
        }
    }
    peer.ip()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    #[test]
    fn the_etag_is_corpus_version_and_book_id() {
        assert_eq!(etag(Some("4.1.0"), 7524), "\"4.1.0-7524\"");
        assert_eq!(etag(None, 1), "\"unknown-1\"");
    }

    #[test]
    fn if_none_match_recognises_the_tag_a_list_and_a_star() {
        let tag = etag(Some("4.1.0"), 7);
        let with = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::IF_NONE_MATCH, HeaderValue::from_str(v).unwrap());
            h
        };
        assert!(matches_etag(&with(&tag), &tag));
        assert!(matches_etag(&with("*"), &tag));
        assert!(matches_etag(&with(&format!("W/{}", tag)), &tag));
        assert!(matches_etag(&with(&format!("\"4.0.0-7\", {}", tag)), &tag));
        assert!(!matches_etag(&with("\"4.0.0-7\""), &tag), "a different corpus is not a match");
        assert!(!matches_etag(&with("\"4.1.0-8\""), &tag), "a different book is not a match");
        assert!(!matches_etag(&HeaderMap::new(), &tag));
    }

    #[test]
    fn concurrency_is_capped_per_client_and_released_on_drop() {
        let limiter = Arc::new(BulkLimiter::default());
        let held: Vec<BulkPermit> = (0..MAX_CONCURRENT)
            .map(|_| limiter.acquire(ip(1)).ok().expect("within the cap"))
            .collect();
        assert!(matches!(limiter.acquire(ip(1)), Err(Refusal::TooManyConcurrent)));
        // A different client is unaffected.
        assert!(limiter.acquire(ip(2)).is_ok());
        drop(held);
        assert!(limiter.acquire(ip(1)).is_ok(), "slots are returned when a request ends");
    }

    #[test]
    fn the_hourly_cap_counts_a_rolling_window() {
        let limiter = Arc::new(BulkLimiter::default());
        let t0 = Instant::now();
        for i in 0..MAX_PER_HOUR {
            // Sequential requests: each permit drops before the next.
            limiter
                .acquire_at(ip(1), t0 + Duration::from_secs(i as u64))
                .ok()
                .expect("within the hourly cap");
        }
        assert!(matches!(
            limiter.acquire_at(ip(1), t0 + Duration::from_secs(60)),
            Err(Refusal::TooManyThisHour)
        ));
        // An hour after the first request, that one has fallen out of the window.
        assert!(limiter.acquire_at(ip(1), t0 + HOUR + Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn the_refusal_says_which_limit_was_hit() {
        assert!(Refusal::TooManyConcurrent.message().contains("at a time"));
        assert!(Refusal::TooManyThisHour.message().contains("per hour"));
    }

    #[test]
    fn a_proxy_header_names_the_client_the_rate_limiter_would_key_on() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        // No proxy header: the socket's peer.
        assert_eq!(client_ip(&HeaderMap::new(), peer), peer.ip());

        // Behind nginx, the first entry of X-Forwarded-For — the same client
        // SmartIpKeyExtractor keys the per-request limiter on.
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.7, 10.0.0.1"));
        assert_eq!(client_ip(&h, peer), "203.0.113.7".parse::<IpAddr>().unwrap());

        let mut h = HeaderMap::new();
        h.insert("x-real-ip", HeaderValue::from_static("203.0.113.9"));
        assert_eq!(client_ip(&h, peer), "203.0.113.9".parse::<IpAddr>().unwrap());

        // Junk in the header falls back to the peer rather than erroring.
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("not-an-ip"));
        assert_eq!(client_ip(&h, peer), peer.ip());
    }
}
