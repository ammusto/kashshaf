//! Lab's algorithms (Lab spec §4).
//!
//! Everything here is a pure function over plain data: a [`text::BookText`]
//! built from the pages a `BookSource` returned, a stop list, a frequency
//! table. No Tauri types, no HTTP. That is what makes them testable on
//! fixtures with hand-computed expectations, and identical in both modes
//! (§9, "mode parity").
//!
//! - `align` / `verify` — the alignment contract (§3.3)
//! - `text` — the book as a token stream on a layer, and the stop list
//! - `freq`, `keyness`, `dispersion`, `ngrams`, `concordance`, `sections` —
//!   the text statistics of §4.1
//!
//! - `isnad`, `names` — isnād extraction and transmitter segmentation (§4.2)
//!
//! §4.3–§4.6 arrive with their phases.

pub mod align;
pub mod concordance;
pub mod dispersion;
pub mod freq;
pub mod isnad;
pub mod keyness;
pub mod names;
pub mod ngrams;
pub mod sections;
pub mod text;
pub mod verify;
