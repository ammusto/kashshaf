//! The Tauri command surface, one module per feature area (spec §2.1).
//!
//! Phase 0 has three: what mode Lab is in, the books it can open, and the
//! debug command that checks the alignment contract.

pub mod books;
pub mod corpus;
pub mod debug;
