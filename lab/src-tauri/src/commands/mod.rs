//! The Tauri command surface, one module per feature area (spec §2.1).
//!
//! `corpus` (mode and download), `books` (browser and reader), `stats`
//! (§4.1 / §7.3), `isnad` (§4.2 / §7.4), `debug` (the alignment check).

pub mod books;
pub mod corpus;
pub mod debug;
pub mod isnad;
pub mod quran;
pub mod reuse;
pub mod stats;
