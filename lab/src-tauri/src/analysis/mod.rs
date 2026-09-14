//! Lab's algorithms (Lab spec §4).
//!
//! Everything here is a pure function over `&dyn BookSource` or over plain
//! data: no Tauri types, no HTTP. That is what makes them testable on
//! fixtures from the sample corpus and identical in both modes (§9, "mode
//! parity").
//!
//! Phase 0 provides the alignment contract the rest is addressed in;
//! §4.1–§4.6 arrive with their phases.

pub mod align;
pub mod verify;
