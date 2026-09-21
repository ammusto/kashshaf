//! Capped, cached **walks** — the verified search paths.
//!
//! Proximity, wide-slot phrases and every forward-verified boolean/name/
//! wildcard path produce hits one by one in reading order. A walk stops at
//! [`MAX_VERIFIED_HITS`] verified hits (cap on *hits*, so the same query
//! yields the same prefix on every machine) or, as a safety net for candidate
//! sets that yield almost nothing, after [`WALK_BUDGET_MS`]. Either stop marks
//! the count as a lower bound (`was_capped`).
//!
//! The verified prefix — ordered hits with their positions — lives in an LRU
//! keyed on the query, bounded by entries ([`PREFIX_CACHE_ENTRIES`]) and by
//! approximate bytes ([`PREFIX_CACHE_BYTES`]), so every later page is a slice
//! of the cached prefix and "load more" never re-runs the walk. The walk
//! itself runs on its own thread: the first window is answered once
//! `offset + limit` hits are verified — after an inline allowance of
//! [`WALK_INLINE_MS`] during which the count usually settles — while the
//! thread keeps filling the prefix up to the cap.
//!
//! **Detached walks are bounded.** While a request is waiting on a walk the
//! walk runs freely; once every requester has been answered the walk must
//! hold one of `max_concurrent` permits to continue. A walk that cannot get
//! a permit within [`WALK_QUEUE_MS`] stops and marks its entry *incomplete*:
//! pages inside the verified prefix are still served from it, a page beyond
//! it starts a fresh walk for that query.
//!
//! With `EngineConfig::exact_counts` a walk has no cap and no budget, waits
//! for completion (so the count is exact), and uses the same cache.

use anyhow::{anyhow, Result};
use lru::LruCache;
use serde::{Deserialize, Serialize};
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tantivy::DocAddress;

/// Verified hits after which a capped walk stops.
pub const MAX_VERIFIED_HITS: usize = 20_000;
/// Wall-clock safety budget of a capped walk.
pub const WALK_BUDGET_MS: u64 = 3_000;
/// After the window is verified, a capped request waits up to this long for
/// the walk to reach the cap or the end, so the first response usually
/// carries the settled count.
pub const WALK_INLINE_MS: u64 = 150;
/// How long a detached walk waits for a permit before giving up.
pub const WALK_QUEUE_MS: u64 = 2_000;
/// Cached walks kept per engine (entries).
pub const PREFIX_CACHE_ENTRIES: usize = 200;
/// Approximate bytes of cached hits kept per engine.
pub const PREFIX_CACHE_BYTES: usize = 256 * 1024 * 1024;
/// Kept for callers of the earlier constant name.
pub const WALK_CACHE_ENTRIES: usize = PREFIX_CACHE_ENTRIES;

/// Default number of detached walks allowed to run at once:
/// `available_parallelism() - 2`, at least 1.
pub fn default_max_concurrent_walks() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(2).max(1)
}

/// One verified page with its highlight positions. A hit from the boundary
/// index — a match across a page break — carries `cross`: `addr` and
/// `positions` are then the primary page's, and `cross` names the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkHit {
    pub addr: DocAddress,
    pub positions: Vec<u32>,
    pub cross: Option<CrossRef>,
}

/// The other page of a match across a page break.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossRef {
    pub primary: crate::tokens::PageKey,
    /// The primary page's share of the match (also the hit's `positions`).
    pub primary_positions: Vec<u32>,
    pub secondary: crate::tokens::PageKey,
    pub secondary_positions: Vec<u32>,
    pub primary_is_left: bool,
}

impl WalkHit {
    pub fn page(addr: DocAddress, positions: Vec<u32>) -> Self {
        Self { addr, positions, cross: None }
    }

    /// Approximate heap + inline size, for the cache's byte bound.
    fn approx_bytes(&self) -> usize {
        std::mem::size_of::<WalkHit>()
            + self.positions.len() * std::mem::size_of::<u32>()
            + self.cross.as_ref().map_or(0, |c| std::mem::size_of::<CrossRef>() + c.secondary_positions.len() * 4)
    }
}

/// Stop conditions of a walk. `None` on both means exact.
#[derive(Debug, Clone, Copy)]
pub struct WalkLimits {
    pub max_hits: Option<usize>,
    pub budget: Option<Duration>,
}

impl WalkLimits {
    pub fn exact() -> Self {
        Self { max_hits: None, budget: None }
    }

    pub fn capped(max_hits: usize, budget_ms: u64) -> Self {
        Self { max_hits: Some(max_hits), budget: Some(Duration::from_millis(budget_ms)) }
    }

    /// No hit cap: the walk runs to its end and the window waits for it,
    /// so the count is exact; only the time budget can stop it, and then
    /// the count is a lower bound (`was_capped`).
    pub fn budgeted(budget_ms: u64) -> Self {
        Self { max_hits: None, budget: Some(Duration::from_millis(budget_ms)) }
    }

    pub fn is_exact(&self) -> bool {
        self.max_hits.is_none() && self.budget.is_none()
    }
}

/// Growing result of one walk, shared between the walking thread and readers.
#[derive(Debug, Default)]
pub struct WalkState {
    pub hits: Vec<WalkHit>,
    /// Approximate bytes held by `hits`.
    pub bytes: usize,
    pub done: bool,
    /// The hit cap or the budget stopped the walk, or the walker stopped
    /// itself early: `hits.len()` is a lower bound.
    pub was_capped: bool,
    /// The walk gave up waiting for a permit: the prefix is usable but a
    /// page beyond it needs a fresh walk.
    pub incomplete: bool,
    pub error: Option<String>,
    /// Wall-clock duration of the whole walk once `done`.
    pub elapsed_ms: u64,
    /// Candidates the walker examined (for diagnostics).
    pub candidates: usize,
}

pub struct WalkEntry {
    state: Mutex<WalkState>,
    cv: Condvar,
    /// Requests currently waiting on this walk.
    attached: AtomicUsize,
}

impl WalkEntry {
    fn new() -> Self {
        Self { state: Mutex::new(WalkState::default()), cv: Condvar::new(), attached: AtomicUsize::new(0) }
    }

    fn lock(&self) -> MutexGuard<'_, WalkState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Wait until the walk is done (or errored).
    fn wait_done(&self) {
        let mut st = self.lock();
        while !st.done {
            st = self.cv.wait(st).unwrap_or_else(|p| p.into_inner());
        }
    }

    fn is_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst) > 0
    }
}

/// Snapshot of one cached walk (`get_walk_status`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WalkStatus {
    pub verified_hits: usize,
    pub was_capped: bool,
    /// The walk has finished (at the cap, the budget, or the end).
    pub complete: bool,
    /// The walk stopped early for lack of a permit (see module docs).
    pub incomplete: bool,
}

/// Engine-level walk counters (`get_stats`, `/health`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct WalkStats {
    /// Walk threads currently running (attached to a request or holding a permit).
    pub walks_active: usize,
    /// Detached walks waiting for a permit.
    pub walks_queued: usize,
    pub prefix_cache_entries: usize,
    pub prefix_cache_bytes: usize,
    pub max_concurrent_walks: usize,
}

/// Permits for detached walks.
struct PermitPool {
    max: usize,
    counts: Mutex<(usize, usize, usize)>, // (permits held, queued, running)
    cv: Condvar,
}

enum Acquire {
    Permit,
    /// A request re-attached while waiting: run on without a permit.
    Attached,
    TimedOut,
}

impl PermitPool {
    fn new(max: usize) -> Self {
        Self { max: max.max(1), counts: Mutex::new((0, 0, 0)), cv: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, (usize, usize, usize)> {
        self.counts.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn acquire(&self, timeout: Duration, entry: &WalkEntry) -> Acquire {
        let deadline = Instant::now() + timeout;
        let mut c = self.lock();
        if c.0 < self.max {
            c.0 += 1;
            return Acquire::Permit;
        }
        c.1 += 1;
        loop {
            if c.0 < self.max {
                c.0 += 1;
                c.1 -= 1;
                return Acquire::Permit;
            }
            if entry.is_attached() {
                c.1 -= 1;
                return Acquire::Attached;
            }
            let now = Instant::now();
            if now >= deadline {
                c.1 -= 1;
                return Acquire::TimedOut;
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            c = self.cv.wait_timeout(c, slice).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    fn release(&self) {
        let mut c = self.lock();
        c.0 = c.0.saturating_sub(1);
        drop(c);
        self.cv.notify_all();
    }

    fn running_inc(&self) {
        self.lock().2 += 1;
    }

    fn running_dec(&self) {
        let mut c = self.lock();
        c.2 = c.2.saturating_sub(1);
    }
}

/// Where a walker delivers hits. `push` and `tick` return `false` when the
/// walk must stop; the walker should return promptly then.
pub struct Sink {
    entry: Arc<WalkEntry>,
    pool: Arc<PermitPool>,
    limits: WalkLimits,
    queue_timeout: Duration,
    start: Instant,
    pending: Vec<WalkHit>,
    pushed: usize,
    /// `offset + limit` of the request that started the walk: once that
    /// many hits are pushed its window is served, and waiting on a lagging
    /// boundary stream is bounded (`Sink::window_served`).
    want: usize,
    candidates: usize,
    has_permit: bool,
    stopped_by_cap: bool,
    stopped_by_budget: bool,
    stopped_by_queue: bool,
    walker_capped: bool,
}

/// Hits buffered before they are published to readers.
const FLUSH_EVERY: usize = 64;

impl Sink {
    fn new(entry: Arc<WalkEntry>, pool: Arc<PermitPool>, limits: WalkLimits, queue_timeout: Duration, want: usize) -> Self {
        Self {
            entry,
            pool,
            limits,
            queue_timeout,
            start: Instant::now(),
            pending: Vec::with_capacity(FLUSH_EVERY),
            pushed: 0,
            want,
            candidates: 0,
            has_permit: false,
            stopped_by_cap: false,
            stopped_by_budget: false,
            stopped_by_queue: false,
            walker_capped: false,
        }
    }

    /// The window of the request that started this walk has been pushed.
    /// An uncapped walk (exact count) has no window to speak of: false.
    pub fn window_served(&self) -> bool {
        self.limits.max_hits.is_some() && self.pushed >= self.want
    }

    /// The stream it consumes was cut short: the count is a lower bound.
    pub fn note_capped(&mut self) {
        self.walker_capped = true;
    }

    /// Deliver one verified hit. Returns `false` once the hit cap is reached
    /// or the detached walk could not get a permit.
    pub fn push(&mut self, hit: WalkHit) -> bool {
        self.pending.push(hit);
        self.pushed += 1;
        if self.pending.len() >= FLUSH_EVERY {
            self.flush();
        }
        if let Some(max) = self.limits.max_hits {
            if self.pushed >= max {
                self.stopped_by_cap = true;
                self.flush();
                return false;
            }
        }
        self.permit_ok()
    }

    /// Call between chunks of candidates: publishes pending hits and checks
    /// the time budget and the permit. Returns `false` when the walk must stop.
    pub fn tick(&mut self) -> bool {
        if !self.pending.is_empty() {
            self.flush();
        }
        if let Some(budget) = self.limits.budget {
            if self.start.elapsed() > budget {
                self.stopped_by_budget = true;
                return false;
            }
        }
        self.permit_ok()
    }

    /// A detached walk needs a permit; wait for one (bounded) when the last
    /// requester has left.
    fn permit_ok(&mut self) -> bool {
        if self.has_permit || self.entry.is_attached() {
            return true;
        }
        match self.pool.acquire(self.queue_timeout, &self.entry) {
            Acquire::Permit => {
                self.has_permit = true;
                true
            }
            Acquire::Attached => true,
            Acquire::TimedOut => {
                self.stopped_by_queue = true;
                false
            }
        }
    }

    /// Record examined candidates (diagnostics only).
    pub fn add_candidates(&mut self, n: usize) {
        self.candidates += n;
    }

    /// The walker stopped early for a reason of its own (e.g. an internal
    /// budget); the count is a lower bound.
    pub fn mark_capped(&mut self) {
        self.walker_capped = true;
    }

    pub fn hits_so_far(&self) -> usize {
        self.pushed
    }

    pub fn is_exact(&self) -> bool {
        self.limits.is_exact()
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let added: usize = self.pending.iter().map(WalkHit::approx_bytes).sum();
        let mut st = self.entry.lock();
        st.hits.append(&mut self.pending);
        st.bytes += added;
        st.candidates = self.candidates;
        drop(st);
        self.entry.cv.notify_all();
    }
}

/// A walk body: produce hits into the sink until exhausted or told to stop.
pub type Walker = Box<dyn FnOnce(&mut Sink) -> Result<()> + Send + 'static>;

/// One page of a walk's result.
#[derive(Debug, Clone)]
pub struct WalkWindow {
    /// Verified hits so far (exact when `done && !was_capped`).
    pub total: usize,
    pub hits: Vec<WalkHit>,
    /// `total` is a lower bound (cap/budget tripped, or the walk is still running).
    pub was_capped: bool,
    pub done: bool,
    /// Served from a walk started by an earlier request.
    pub from_cache: bool,
    pub candidates: usize,
    pub walk_elapsed_ms: u64,
}

pub struct WalkCache {
    entries: Mutex<LruCache<String, Arc<WalkEntry>>>,
    max_bytes: usize,
    pool: Arc<PermitPool>,
    /// How long a detached walk waits for a permit (`WALK_QUEUE_MS`).
    queue_timeout: Duration,
}

impl WalkCache {
    pub fn new(capacity: usize) -> Self {
        Self::with_limits(capacity, PREFIX_CACHE_BYTES, default_max_concurrent_walks())
    }

    pub fn with_limits(capacity: usize, max_bytes: usize, max_concurrent: usize) -> Self {
        Self {
            entries: Mutex::new(LruCache::new(NonZeroUsize::new(capacity.max(1)).unwrap())),
            max_bytes,
            pool: Arc::new(PermitPool::new(max_concurrent)),
            queue_timeout: Duration::from_millis(WALK_QUEUE_MS),
        }
    }

    /// Override the permit wait (tests).
    pub fn with_queue_timeout(mut self, timeout: Duration) -> Self {
        self.queue_timeout = timeout;
        self
    }

    /// Serve `[offset, offset + limit)` of the walk identified by `key`,
    /// starting the walk (on its own thread) if it is not cached. `make`
    /// builds the walker and runs synchronously on the caller's thread, so
    /// it may borrow the engine; the walker itself must be `'static + Send`.
    ///
    /// Capped walks return once the window is verified and the inline
    /// allowance has passed (or the walk finished); exact walks wait for
    /// completion.
    pub fn window(
        &self,
        key: String,
        offset: usize,
        limit: usize,
        limits: WalkLimits,
        make: impl FnOnce() -> Result<Walker>,
    ) -> Result<WalkWindow> {
        let start = Instant::now();
        let want = offset.saturating_add(limit);
        let (entry, fresh) = {
            let mut lru = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            let reuse = match lru.get(&key) {
                Some(e) => {
                    let st = e.lock();
                    // An incomplete prefix serves pages inside it; beyond it
                    // the query gets a fresh walk.
                    if st.incomplete && want > st.hits.len() {
                        None
                    } else {
                        Some(e.clone())
                    }
                }
                None => None,
            };
            match reuse {
                Some(e) => (e, false),
                None => {
                    lru.pop(&key);
                    self.evict_to_fit(&mut lru);
                    let e = Arc::new(WalkEntry::new());
                    lru.put(key.clone(), e.clone());
                    (e, true)
                }
            }
        };
        entry.attached.fetch_add(1, Ordering::SeqCst);
        crate::probe::amount(if fresh { "walk.fresh" } else { "walk.reused" }, 1);
        let t = Instant::now();
        let result = self.serve(&key, &entry, fresh, offset, limit, limits, start, make);
        crate::probe::stage("walk.wait", t);
        entry.attached.fetch_sub(1, Ordering::SeqCst);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn serve(
        &self,
        key: &str,
        entry: &Arc<WalkEntry>,
        fresh: bool,
        offset: usize,
        limit: usize,
        limits: WalkLimits,
        start: Instant,
        make: impl FnOnce() -> Result<Walker>,
    ) -> Result<WalkWindow> {
        let want = offset.saturating_add(limit);
        if fresh {
            let walker = match make() {
                Ok(w) => w,
                Err(e) => {
                    self.remove(key);
                    return Err(e);
                }
            };
            let e2 = entry.clone();
            let pool = self.pool.clone();
            let queue_timeout = self.queue_timeout;
            let spawned = std::thread::Builder::new()
                .name("kashshaf-walk".into())
                .spawn(move || run_walk(e2, pool, walker, limits, queue_timeout, want));
            if let Err(e) = spawned {
                self.remove(key);
                return Err(anyhow!("could not start walk thread: {}", e));
            }
        }
        // Without a hit cap the answer is the whole walk (exact, or budgeted).
        let wait_for_all = limits.max_hits.is_none();
        let inline_deadline = start + Duration::from_millis(WALK_INLINE_MS);
        let mut st = entry.lock();
        loop {
            if st.done || st.error.is_some() {
                break;
            }
            if !wait_for_all && st.hits.len() >= want {
                // Window verified: give the walk the inline allowance to settle
                // the count, then answer.
                let now = Instant::now();
                if now >= inline_deadline {
                    break;
                }
                st = entry.cv.wait_timeout(st, inline_deadline - now).unwrap_or_else(|p| p.into_inner()).0;
                continue;
            }
            st = entry.cv.wait(st).unwrap_or_else(|p| p.into_inner());
        }
        if let Some(err) = st.error.clone() {
            drop(st);
            self.remove(key);
            return Err(anyhow!(err));
        }
        let hits: Vec<WalkHit> = st.hits.iter().skip(offset).take(limit).cloned().collect();
        Ok(WalkWindow {
            total: st.hits.len(),
            hits,
            was_capped: st.was_capped || !st.done,
            done: st.done,
            from_cache: !fresh,
            candidates: st.candidates,
            walk_elapsed_ms: st.elapsed_ms,
        })
    }

    /// Evict least recently used entries until the byte bound holds (the
    /// entry bound is enforced by the LRU itself).
    fn evict_to_fit(&self, lru: &mut LruCache<String, Arc<WalkEntry>>) {
        loop {
            let total: usize = lru.iter().map(|(_, e)| e.lock().bytes).sum();
            if total <= self.max_bytes || lru.is_empty() {
                break;
            }
            lru.pop_lru();
        }
    }

    /// Snapshot of one cached walk, `None` when the key is not cached.
    pub fn status(&self, key: &str) -> Option<WalkStatus> {
        let entry = self.entries.lock().unwrap_or_else(|p| p.into_inner()).peek(key).cloned()?;
        let st = entry.lock();
        Some(WalkStatus {
            verified_hits: st.hits.len(),
            was_capped: st.was_capped || !st.done,
            complete: st.done,
            incomplete: st.incomplete,
        })
    }

    pub fn stats(&self) -> WalkStats {
        let (entries, bytes) = {
            let lru = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            (lru.len(), lru.iter().map(|(_, e)| e.lock().bytes).sum())
        };
        let c = self.pool.lock();
        WalkStats {
            // Running threads minus those parked on the permit queue.
            walks_active: c.2.saturating_sub(c.1),
            walks_queued: c.1,
            prefix_cache_entries: entries,
            prefix_cache_bytes: bytes,
            max_concurrent_walks: self.pool.max,
        }
    }

    /// Block until every cached walk has finished (benchmarks, tests).
    pub fn wait_all(&self) {
        let entries: Vec<Arc<WalkEntry>> = {
            let lru = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            lru.iter().map(|(_, e)| e.clone()).collect()
        };
        for e in entries {
            e.wait_done();
        }
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn remove(&self, key: &str) {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).pop(key);
    }
}

fn run_walk(entry: Arc<WalkEntry>, pool: Arc<PermitPool>, walker: Walker, limits: WalkLimits, queue_timeout: Duration, want: usize) {
    let start = Instant::now();
    let _t = crate::probe::timer("walk.total");
    pool.running_inc();
    let mut sink = Sink::new(entry.clone(), pool.clone(), limits, queue_timeout, want);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| walker(&mut sink)));
    sink.flush();
    let capped = sink.stopped_by_cap || sink.stopped_by_budget || sink.walker_capped || sink.stopped_by_queue;
    let incomplete = sink.stopped_by_queue;
    let candidates = sink.candidates;
    if sink.has_permit {
        pool.release();
    }
    pool.running_dec();
    let mut st = entry.lock();
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(e)) => st.error = Some(e.to_string()),
        Err(panic) => {
            let msg = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "walk panicked".to_string());
            st.error = Some(msg);
        }
    }
    st.was_capped = capped;
    st.incomplete = incomplete;
    st.candidates = candidates;
    st.elapsed_ms = start.elapsed().as_millis() as u64;
    st.done = true;
    drop(st);
    entry.cv.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(d: u32) -> WalkHit {
        WalkHit::page(DocAddress::new(0, d), vec![d, d + 1])
    }

    fn counting_walker(n: u32) -> Walker {
        Box::new(move |sink: &mut Sink| {
            for d in 0..n {
                if !sink.push(hit(d)) {
                    return Ok(());
                }
            }
            Ok(())
        })
    }

    #[test]
    fn capped_walk_serves_windows_from_one_run() {
        let cache = WalkCache::new(4);
        let runs = Arc::new(Mutex::new(0usize));
        let make = |runs: Arc<Mutex<usize>>| {
            move || -> Result<Walker> {
                *runs.lock().unwrap() += 1;
                Ok(counting_walker(10_000))
            }
        };
        let limits = WalkLimits::capped(500, 10_000);
        let w1 = cache.window("k".into(), 0, 10, limits, make(runs.clone())).unwrap();
        assert_eq!(w1.hits.len(), 10);
        // Inline allowance: this tiny walk reaches its cap well within 150 ms,
        // so the first response already carries the settled count.
        assert!(w1.done);
        assert_eq!(w1.total, 500);
        assert!(w1.was_capped);
        cache.wait_all();
        let w2 = cache.window("k".into(), 490, 10, limits, make(runs.clone())).unwrap();
        assert!(w2.from_cache);
        assert!(w2.done);
        assert_eq!(w2.total, 500);
        assert_eq!(w2.hits.len(), 10);
        assert_eq!(w2.hits[0].addr.doc_id, 490);
        assert_eq!(*runs.lock().unwrap(), 1, "the walk ran once");
        let w3 = cache.window("k".into(), 600, 10, limits, make(runs.clone())).unwrap();
        assert!(w3.hits.is_empty());
        assert_eq!(w3.total, 500);
        let s = cache.status("k").unwrap();
        assert_eq!(s, WalkStatus { verified_hits: 500, was_capped: true, complete: true, incomplete: false });
        assert!(cache.status("nope").is_none());
    }

    #[test]
    fn exact_walk_waits_and_is_not_capped() {
        let cache = WalkCache::new(4);
        let w = cache.window("e".into(), 0, 10, WalkLimits::exact(), || Ok(counting_walker(1000))).unwrap();
        assert!(w.done);
        assert!(!w.was_capped);
        assert_eq!(w.total, 1000);
        let s = cache.status("e").unwrap();
        assert!(s.complete && !s.was_capped && s.verified_hits == 1000);
    }

    #[test]
    fn budget_stops_a_barren_walk() {
        let cache = WalkCache::new(4);
        let make = || -> Result<Walker> {
            Ok(Box::new(|sink: &mut Sink| loop {
                std::thread::sleep(Duration::from_millis(5));
                sink.add_candidates(1);
                if !sink.tick() {
                    return Ok(());
                }
            }))
        };
        let w = cache.window("b".into(), 0, 10, WalkLimits::capped(100, 50), make).unwrap();
        assert!(w.done);
        assert!(w.was_capped);
        assert_eq!(w.total, 0);
    }

    #[test]
    fn walker_error_is_reported_and_not_cached() {
        let cache = WalkCache::new(4);
        let make = || -> Result<Walker> { Ok(Box::new(|_sink: &mut Sink| Err(anyhow!("boom")))) };
        let err = cache.window("x".into(), 0, 10, WalkLimits::exact(), make).unwrap_err();
        assert!(err.to_string().contains("boom"));
        assert!(cache.is_empty());
    }

    /// A slow walker: one hit per `step`, `n` hits, so it outlives its
    /// requester (limit 1) and runs detached.
    fn slow_walker(n: u32, step: Duration) -> Walker {
        Box::new(move |sink: &mut Sink| {
            for d in 0..n {
                std::thread::sleep(step);
                if !sink.push(hit(d)) {
                    return Ok(());
                }
                if !sink.tick() {
                    return Ok(());
                }
            }
            Ok(())
        })
    }

    #[test]
    fn semaphore_saturation_queues_detached_walks() {
        let n = 2usize;
        // Generous permit wait so every queued walk eventually runs.
        let cache = Arc::new(WalkCache::with_limits(16, PREFIX_CACHE_BYTES, n).with_queue_timeout(Duration::from_secs(60)));
        // N + 3 walks of ~1.5 s each; every request asks for one hit and
        // leaves after the inline allowance. Each walk then needs a permit to
        // continue: N run, 3 queue.
        for i in 0..n + 3 {
            let w = cache
                .window(format!("w{}", i), 0, 1, WalkLimits::capped(100, 60_000), || Ok(slow_walker(100, Duration::from_millis(15))))
                .unwrap();
            assert_eq!(w.hits.len(), 1);
        }
        // Let the walkers reach their permit checks.
        let mut seen_saturated = false;
        for _ in 0..100 {
            let s = cache.stats();
            if s.walks_active == n && s.walks_queued == 3 {
                seen_saturated = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let s = cache.stats();
        assert!(seen_saturated, "expected {} active / 3 queued, saw {:?}", n, s);
        assert_eq!(s.max_concurrent_walks, n);
        cache.wait_all();
        for i in 0..n + 3 {
            let st = cache.status(&format!("w{}", i)).unwrap();
            assert!(st.complete, "w{} not complete", i);
            assert!(!st.incomplete, "w{} gave up on a permit", i);
            assert_eq!(st.verified_hits, 100, "w{}", i);
        }
        let s = cache.stats();
        assert_eq!((s.walks_active, s.walks_queued), (0, 0));
    }

    #[test]
    fn queue_timeout_marks_entry_incomplete_and_pagination_restarts() {
        // One permit, held by a long detached walk; a second detached walk
        // gives up after WALK_QUEUE_MS and its entry is incomplete.
        let cache = Arc::new(WalkCache::with_limits(16, PREFIX_CACHE_BYTES, 1));
        let w = cache
            .window("long".into(), 0, 1, WalkLimits::capped(400, 60_000), || Ok(slow_walker(400, Duration::from_millis(10))))
            .unwrap();
        assert_eq!(w.hits.len(), 1);
        std::thread::sleep(Duration::from_millis(50)); // the long walk takes the permit
        let w2 = cache
            .window("short".into(), 0, 1, WalkLimits::capped(400, 60_000), || Ok(slow_walker(400, Duration::from_millis(10))))
            .unwrap();
        assert_eq!(w2.hits.len(), 1);
        // The short walk detaches, finds no permit, and gives up after 2 s.
        let mut st = None;
        for _ in 0..80 {
            std::thread::sleep(Duration::from_millis(50));
            let s = cache.status("short").unwrap();
            if s.complete {
                st = Some(s);
                break;
            }
        }
        let st = st.expect("short walk should have stopped");
        assert!(st.incomplete && st.was_capped, "{:?}", st);
        assert!(st.verified_hits < 400);
        // Inside the prefix: served from the incomplete entry.
        let inside = cache
            .window("short".into(), 0, 1, WalkLimits::capped(400, 60_000), || panic!("must not restart"))
            .unwrap();
        assert!(inside.from_cache);
        // Beyond the prefix: a fresh walk for the same query (attached, so it
        // runs without a permit while we wait).
        let beyond = cache
            .window("short".into(), st.verified_hits + 5, 1, WalkLimits::capped(400, 60_000), || Ok(slow_walker(400, Duration::from_millis(1))))
            .unwrap();
        assert!(!beyond.from_cache);
        assert_eq!(beyond.hits.len(), 1);
        cache.wait_all();
    }

    #[test]
    fn prefix_cache_evicts_by_bytes() {
        // Each hit is ~40 bytes; 1,000 hits ≈ 40 KB per entry. Bound at 100 KB:
        // only two entries fit.
        let cache = WalkCache::with_limits(200, 100 * 1024, 4);
        for i in 0..5 {
            cache.window(format!("k{}", i), 0, 1, WalkLimits::exact(), || Ok(counting_walker(1000))).unwrap();
        }
        let s = cache.stats();
        assert!(s.prefix_cache_entries <= 3, "{:?}", s);
        assert!(s.prefix_cache_bytes <= 100 * 1024 + 41 * 1024, "{:?}", s);
        // The most recent entries survive, the oldest are gone.
        assert!(cache.status("k4").is_some());
        assert!(cache.status("k0").is_none());
        assert!(cache.status("k1").is_none());
        // Entry bound too.
        let small = WalkCache::with_limits(2, PREFIX_CACHE_BYTES, 4);
        for i in 0..4 {
            small.window(format!("e{}", i), 0, 1, WalkLimits::exact(), || Ok(counting_walker(10))).unwrap();
        }
        assert_eq!(small.stats().prefix_cache_entries, 2);
        assert!(small.status("e3").is_some() && small.status("e0").is_none());
    }
}
