//! Lab's application state.
//!
//! The resolved [`BookSource`], the status that explains it, `analysis.db`,
//! and the one *current* book (spec §7.1) with its per-layer token streams.
//! Held behind an `RwLock` so that downloading a corpus can swap a running
//! api-mode session into local mode without a restart (spec §2.4).

use crate::analysis::quran::QuranIndex;
use crate::analysis::sections::{self, Section};
use crate::analysis::text::BookText;
use crate::error::LabError;
use crate::mode::{self, LabStatus};
use crate::quran_data::QuranText;
use crate::source::{BookSource, Layer, Page};
use crate::store::Store;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

/// The shipped Qurʾān and its n-gram index (spec §4.4), built once per
/// process on first use — or at startup, when `main` warms it.
pub struct Quran {
    pub text: QuranText,
    pub index: QuranIndex,
}

/// Shared, lazily built; the error is kept so every caller sees the same
/// reason if the embedded data could not be unpacked.
pub type QuranCell = Arc<OnceLock<Result<Arc<Quran>, String>>>;

/// Build (or fetch) the Qurʾān for this process.
pub fn quran(cell: &QuranCell) -> Result<Arc<Quran>, LabError> {
    cell.get_or_init(|| {
        let dir = kashshaf_common::lab_data_dir().map_err(|e| e.to_string())?;
        let text = QuranText::load(&dir).map_err(|e| format!("the shipped Qurʾān could not be loaded: {}", e))?;
        let index = QuranIndex::build(&text);
        Ok(Arc::new(Quran { text, index }))
    })
    .clone()
    .map_err(LabError::Other)
}

/// The current book, loaded whole (spec §7.1: every panel operates on it).
///
/// The pages are read once; each layer's [`BookText`] is built on first use
/// and kept, so switching the layer selector in the Stats panel does not
/// re-read the book.
pub struct LoadedBook {
    pub id: u64,
    pub pages: Arc<Vec<Page>>,
    pub sections: Arc<Vec<Section>>,
    texts: Mutex<HashMap<Layer, Arc<BookText>>>,
    /// How long `book_pages` took, for the UI's estimates.
    pub load_ms: u64,
}

impl LoadedBook {
    pub fn new(id: u64, pages: Vec<Page>, load_ms: u64) -> Self {
        // Sections need any layer's page offsets; surface is the cheapest.
        let surface = BookText::build(&pages, Layer::Surface);
        let secs = sections::sections(&surface, &pages);
        let mut texts = HashMap::new();
        texts.insert(Layer::Surface, Arc::new(surface));
        Self { id, pages: Arc::new(pages), sections: Arc::new(secs), texts: Mutex::new(texts), load_ms }
    }

    pub fn text(&self, layer: Layer) -> Arc<BookText> {
        let mut texts = self.texts.lock().unwrap();
        Arc::clone(texts.entry(layer).or_insert_with(|| Arc::new(BookText::build(&self.pages, layer))))
    }

    pub fn tokens(&self) -> usize {
        self.pages.iter().map(|p| p.tokens.len()).sum()
    }
}

pub struct LabState {
    pub source: Option<Arc<dyn BookSource>>,
    pub status: LabStatus,
    /// `None` only if Lab's own directory could not be created; the app still
    /// opens read-only so the user can see why.
    pub store: Option<Arc<Store>>,
    /// The current book, once one has been loaded for analysis.
    pub loaded: Arc<Mutex<Option<Arc<LoadedBook>>>>,
    /// Set by the Cancel button; polled by every batch operation (ground
    /// rule 6). Cleared when an operation starts.
    pub cancel: Arc<AtomicBool>,
    /// The Qurʾān and its index (§4.4).
    pub quran: QuranCell,
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
        Self {
            source: resolved.source,
            status: resolved.status,
            store,
            loaded: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            quran: Arc::new(OnceLock::new()),
        }
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

/// The pieces a batch command needs, cloned out from behind the lock.
pub struct Handles {
    pub source: Arc<dyn BookSource>,
    pub loaded: Arc<Mutex<Option<Arc<LoadedBook>>>>,
    pub cancel: Arc<AtomicBool>,
    pub store: Option<Arc<Store>>,
    pub quran: QuranCell,
}

pub fn handles(state: &ManagedLabState) -> Result<Handles, LabError> {
    let guard = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    Ok(Handles {
        source: guard.require_source()?,
        loaded: Arc::clone(&guard.loaded),
        cancel: Arc::clone(&guard.cancel),
        store: guard.store.clone(),
        quran: Arc::clone(&guard.quran),
    })
}
