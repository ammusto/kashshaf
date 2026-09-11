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
//! keyed on the query, so every later page is a slice of the cached prefix
//! and "load more" never re-runs the walk. The walk itself runs on its own
//! thread: the first window is answered as soon as `offset + limit` hits are
//! verified while the thread keeps filling the prefix up to the cap.
//!
//! With `EngineConfig::exact_counts` a walk has no cap and no budget, waits
//! for completion (so the count is exact), and uses the same cache.

use anyhow::{anyhow, Result};
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tantivy::DocAddress;

/// Verified hits after which a capped walk stops.
pub const MAX_VERIFIED_HITS: usize = 20_000;
/// Wall-clock safety budget of a capped walk.
pub const WALK_BUDGET_MS: u64 = 3_000;
/// Cached walks kept per engine.
pub const WALK_CACHE_ENTRIES: usize = 16;
/// Upper bound on cached hits across all entries; exact walks can be large
/// (2.4M hits ≈ 280 MB), so the least recently used entries are dropped
/// when a new walk would exceed it.
pub const WALK_CACHE_MAX_HITS: usize = 4_000_000;

/// One verified page with its highlight positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkHit {
    pub addr: DocAddress,
    pub positions: Vec<u32>,
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

    pub fn is_exact(&self) -> bool {
        self.max_hits.is_none() && self.budget.is_none()
    }
}

/// Growing result of one walk, shared between the walking thread and readers.
#[derive(Debug, Default)]
pub struct WalkState {
    pub hits: Vec<WalkHit>,
    pub done: bool,
    /// The hit cap or the budget stopped the walk, or the walker stopped
    /// itself early: `hits.len()` is a lower bound.
    pub was_capped: bool,
    pub error: Option<String>,
    /// Wall-clock duration of the whole walk once `done`.
    pub elapsed_ms: u64,
    /// Candidates the walker examined (for diagnostics).
    pub candidates: usize,
}

pub struct WalkEntry {
    state: Mutex<WalkState>,
    cv: Condvar,
}

impl WalkEntry {
    fn new() -> Self {
        Self { state: Mutex::new(WalkState::default()), cv: Condvar::new() }
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
}

/// Where a walker delivers hits. `push` and `tick` return `false` when the
/// walk must stop; the walker should return promptly then.
pub struct Sink<'a> {
    entry: &'a WalkEntry,
    limits: WalkLimits,
    start: Instant,
    pending: Vec<WalkHit>,
    pushed: usize,
    candidates: usize,
    stopped_by_cap: bool,
    stopped_by_budget: bool,
    walker_capped: bool,
}

/// Hits buffered before they are published to readers.
const FLUSH_EVERY: usize = 64;

impl<'a> Sink<'a> {
    fn new(entry: &'a WalkEntry, limits: WalkLimits) -> Self {
        Self {
            entry,
            limits,
            start: Instant::now(),
            pending: Vec::with_capacity(FLUSH_EVERY),
            pushed: 0,
            candidates: 0,
            stopped_by_cap: false,
            stopped_by_budget: false,
            walker_capped: false,
        }
    }

    /// Deliver one verified hit. Returns `false` once the hit cap is reached.
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
        true
    }

    /// Call between chunks of candidates: publishes pending hits and checks
    /// the time budget. Returns `false` when the walk must stop.
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
        true
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
        let mut st = self.entry.lock();
        st.hits.append(&mut self.pending);
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
}

impl WalkCache {
    pub fn new(capacity: usize) -> Self {
        Self { entries: Mutex::new(LruCache::new(NonZeroUsize::new(capacity.max(1)).unwrap())) }
    }

    /// Serve `[offset, offset + limit)` of the walk identified by `key`,
    /// starting the walk (on its own thread) if it is not cached. `make`
    /// builds the walker and runs synchronously on the caller's thread, so
    /// it may borrow the engine; the walker itself must be `'static + Send`.
    ///
    /// Capped walks return as soon as the window is verified; exact walks
    /// wait for completion.
    pub fn window(
        &self,
        key: String,
        offset: usize,
        limit: usize,
        limits: WalkLimits,
        make: impl FnOnce() -> Result<Walker>,
    ) -> Result<WalkWindow> {
        let (entry, fresh) = {
            let mut lru = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            match lru.get(&key) {
                Some(e) => (e.clone(), false),
                None => {
                    // Keep the cached hit total bounded before adding a walk.
                    loop {
                        let total: usize = lru.iter().map(|(_, e)| e.lock().hits.len()).sum();
                        if total <= WALK_CACHE_MAX_HITS || lru.len() <= 1 {
                            break;
                        }
                        lru.pop_lru();
                    }
                    let e = Arc::new(WalkEntry::new());
                    lru.put(key.clone(), e.clone());
                    (e, true)
                }
            }
        };
        if fresh {
            let walker = match make() {
                Ok(w) => w,
                Err(e) => {
                    self.remove(&key);
                    return Err(e);
                }
            };
            let e2 = entry.clone();
            let spawned = std::thread::Builder::new()
                .name("kashshaf-walk".into())
                .spawn(move || run_walk(&e2, walker, limits));
            if let Err(e) = spawned {
                self.remove(&key);
                return Err(anyhow!("could not start walk thread: {}", e));
            }
        }
        let wait_for_all = limits.is_exact();
        let want = offset.saturating_add(limit);
        let mut st = entry.lock();
        loop {
            if st.done || st.error.is_some() {
                break;
            }
            if !wait_for_all && st.hits.len() >= want {
                break;
            }
            st = entry.cv.wait(st).unwrap_or_else(|p| p.into_inner());
        }
        if let Some(err) = st.error.clone() {
            drop(st);
            self.remove(&key);
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

fn run_walk(entry: &WalkEntry, walker: Walker, limits: WalkLimits) {
    let start = Instant::now();
    let mut sink = Sink::new(entry, limits);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| walker(&mut sink)));
    sink.flush();
    let capped = sink.stopped_by_cap || sink.stopped_by_budget || sink.walker_capped;
    let candidates = sink.candidates;
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
        WalkHit { addr: DocAddress::new(0, d), positions: vec![d, d + 1] }
    }

    #[test]
    fn capped_walk_serves_windows_from_one_run() {
        let cache = WalkCache::new(4);
        let runs = Arc::new(Mutex::new(0usize));
        let make = |runs: Arc<Mutex<usize>>| {
            move || -> Result<Walker> {
                *runs.lock().unwrap() += 1;
                Ok(Box::new(|sink: &mut Sink| {
                    for d in 0..10_000u32 {
                        if !sink.push(hit(d)) {
                            return Ok(());
                        }
                    }
                    Ok(())
                }))
            }
        };
        let limits = WalkLimits::capped(500, 10_000);
        let w1 = cache.window("k".into(), 0, 10, limits, make(runs.clone())).unwrap();
        assert_eq!(w1.hits.len(), 10);
        assert!(w1.was_capped, "still running or capped");
        cache.wait_all();
        let w2 = cache.window("k".into(), 490, 10, limits, make(runs.clone())).unwrap();
        assert!(w2.from_cache);
        assert!(w2.done);
        assert_eq!(w2.total, 500);
        assert!(w2.was_capped);
        assert_eq!(w2.hits.len(), 10);
        assert_eq!(w2.hits[0].addr.doc_id, 490);
        assert_eq!(*runs.lock().unwrap(), 1, "the walk ran once");
        // Beyond the prefix: empty window, same total.
        let w3 = cache.window("k".into(), 600, 10, limits, make(runs.clone())).unwrap();
        assert!(w3.hits.is_empty());
        assert_eq!(w3.total, 500);
    }

    #[test]
    fn exact_walk_waits_and_is_not_capped() {
        let cache = WalkCache::new(4);
        let make = || -> Result<Walker> {
            Ok(Box::new(|sink: &mut Sink| {
                for d in 0..1000u32 {
                    if !sink.push(hit(d)) {
                        return Ok(());
                    }
                }
                Ok(())
            }))
        };
        let w = cache.window("e".into(), 0, 10, WalkLimits::exact(), make).unwrap();
        assert!(w.done);
        assert!(!w.was_capped);
        assert_eq!(w.total, 1000);
    }

    #[test]
    fn budget_stops_a_barren_walk() {
        let cache = WalkCache::new(4);
        let make = || -> Result<Walker> {
            Ok(Box::new(|sink: &mut Sink| {
                loop {
                    std::thread::sleep(Duration::from_millis(5));
                    sink.add_candidates(1);
                    if !sink.tick() {
                        return Ok(());
                    }
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
}
