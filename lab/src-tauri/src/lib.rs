//! Kashshaf Lab — in-depth analysis of a single premodern Arabic text against
//! the Kashshaf corpus.
//!
//! The contract this implements is `dev-docs/KASHSHAF_LAB_SPEC.md`. Lab shares
//! `kashshaf-engine` and `kashshaf-common` with Kashshaf but ships on its own
//! version and its own tags (§2.1), and it never writes to the corpus (ground
//! rule 2): every artefact it produces lives in `analysis.db` under its own
//! directory.
//!
//! The library half exists so the algorithms and the store can be tested
//! without a Tauri runtime.

pub mod analysis;
pub mod commands;
pub mod error;
pub mod mode;
pub mod source;
pub mod state;
pub mod store;

pub use error::LabError;
pub use mode::{LabMode, LabStatus};
pub use source::{BookMetadata, BookSource, Layer, Page, PageRef};
pub use state::{LabState, ManagedLabState};
pub use store::Store;

/// Lab's version, independent of the workspace's (spec §2.1).
pub const LAB_VERSION: &str = env!("CARGO_PKG_VERSION");
