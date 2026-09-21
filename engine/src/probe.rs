//! Stage timing for the search probe (`engine/examples/search_probe.rs`).
//!
//! Inert unless [`enable`] was called: every hook is one relaxed atomic
//! load and returns. When on, the engine's search paths record how long
//! each stage took — plan, weight, scorer, iteration, the walk's fetch and
//! verify, the positional intersection, the boundary stream, results,
//! highlights — and amounts that say how much work each did (docs iterated,
//! candidates verified, posting lists opened, cursor doc frequencies),
//! from whichever thread does it. [`take`] hands the log over and clears
//! it. Nothing in the app enables this.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

static ON: AtomicBool = AtomicBool::new(false);
static LOG: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

/// One recorded stage or amount.
#[derive(Debug, Clone)]
pub struct Entry {
    pub stage: &'static str,
    /// Time spent, or 0 for an amount.
    pub us: u64,
    /// A count (docs, candidates, ids), or 0 for a timing.
    pub amount: u64,
    /// The thread that recorded it: the request, a walk, a boundary scan.
    pub thread: String,
}

pub fn enable(on: bool) {
    ON.store(on, Ordering::SeqCst);
    if on {
        LOG.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

#[inline]
pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

fn push(stage: &'static str, us: u64, amount: u64) {
    let thread = std::thread::current().name().unwrap_or("?").to_string();
    LOG.lock().unwrap_or_else(|p| p.into_inner()).push(Entry { stage, us, amount, thread });
}

/// Record the time since `since` under `stage`.
#[inline]
pub fn stage(stage: &'static str, since: Instant) {
    if on() {
        push(stage, since.elapsed().as_micros() as u64, 0);
    }
}

/// Record an amount of work under `stage`.
#[inline]
pub fn amount(stage: &'static str, n: u64) {
    if on() {
        push(stage, 0, n);
    }
}

/// Everything recorded since the last `take` (or `enable`), oldest first.
pub fn take() -> Vec<Entry> {
    std::mem::take(&mut *LOG.lock().unwrap_or_else(|p| p.into_inner()))
}

/// A stage that records itself when dropped; nothing when the probe is off.
pub struct Timer {
    stage: &'static str,
    start: Option<Instant>,
}

#[inline]
pub fn timer(stage: &'static str) -> Timer {
    Timer { stage, start: if on() { Some(Instant::now()) } else { None } }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            push(self.stage, start.elapsed().as_micros() as u64, 0);
        }
    }
}
