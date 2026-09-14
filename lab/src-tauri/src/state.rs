//! Lab's application state.
//!
//! The resolved [`BookSource`], the status that explains it, and
//! `analysis.db`. Held behind an `RwLock` so that downloading a corpus can
//! swap a running api-mode session into local mode without a restart
//! (spec §2.4).

use crate::error::LabError;
use crate::mode::{self, LabStatus};
use crate::source::BookSource;
use crate::store::Store;
use std::sync::{Arc, RwLock};

pub struct LabState {
    pub source: Option<Arc<dyn BookSource>>,
    pub status: LabStatus,
    /// `None` only if Lab's own directory could not be created; the app still
    /// opens read-only so the user can see why.
    pub store: Option<Arc<Store>>,
}

pub type ManagedLabState = Arc<RwLock<LabState>>;

/// Which server api mode talks to. `KASHSHAF_API_BASE` overrides it, which is
/// how the §9 mode-parity test points Lab at a local instance.
pub fn api_base() -> String {
    std::env::var("KASHSHAF_API_BASE")
        .unwrap_or_else(|_| crate::source::api::DEFAULT_API_BASE.to_string())
}

impl LabState {
    /// Resolve the mode and open `analysis.db`. Never fails: a Lab that cannot
    /// read anything still opens and says why.
    pub fn resolve() -> Self {
        let resolved = mode::resolve(&api_base());
        let store = kashshaf_common::lab_data_dir()
            .and_then(|dir| Store::open(&dir))
            .map(Arc::new)
            .map_err(|e| eprintln!("[lab] analysis.db unavailable: {}", e))
            .ok();
        Self { source: resolved.source, status: resolved.status, store }
    }

    pub fn require_source(&self) -> Result<Arc<dyn BookSource>, LabError> {
        self.source.clone().ok_or_else(|| {
            LabError::NoSource(
                self.status
                    .local_error
                    .clone()
                    .or_else(|| self.status.api_error.clone())
                    .unwrap_or_else(|| "no local corpus and no reachable server".to_string()),
            )
        })
    }
}

/// Clone the source out from behind the lock, so a long read does not hold it.
pub fn source_of(state: &ManagedLabState) -> Result<Arc<dyn BookSource>, LabError> {
    let guard = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    guard.require_source()
}
