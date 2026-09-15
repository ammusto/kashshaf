//! Mode detection and the state it produces (Lab spec §2.4).
//!
//! `local` when `kashshaf-common` finds a complete corpus in the Kashshaf data
//! directory, `api` otherwise. The decision is made once at startup and again
//! whenever the user downloads a corpus or asks to retry; what it produces is a
//! [`BookSource`] plus a [`LabStatus`] the UI shows in its mode badge.
//!
//! Nothing here hides a failure. If the corpus is present but unreadable, or
//! the API is unreachable, the reason travels to the badge and to every panel
//! that needs the missing capability (ground rule 5).

use crate::source::{api::ApiSource, local::LocalSource, BookSource};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabMode {
    Local,
    Api,
    /// Neither worked: no readable corpus and no reachable server. The app
    /// still opens, shows why, and offers the download.
    Unavailable,
}

/// What the mode badge and the settings panel render (spec §7.1, §7.8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabStatus {
    pub mode: LabMode,
    /// `4.1.0` in either mode, once something answered.
    pub corpus_version: Option<String>,
    /// Where the corpus is, in local mode.
    pub corpus_dir: Option<String>,
    /// Which server answered, in api mode.
    pub api_base: Option<String>,
    /// `bulk_tokens` from `/health` (spec §5.1); always true in local mode.
    pub bulk_tokens: bool,
    /// Whether this corpus has a table of contents (spec 1.5 §B1).
    pub toc: bool,
    /// Why it has none, when it has none.
    pub toc_error: Option<String>,
    /// The corpus version that first ships `toc.db`, for the message.
    pub min_toc_corpus_version: String,
    /// Lab's own directory (spec §2.5).
    pub lab_dir: Option<String>,
    pub lab_version: String,
    /// Why local mode was not used, when it was not. Shown, never swallowed.
    pub local_error: Option<String>,
    /// Why api mode was not used, when it was not.
    pub api_error: Option<String>,
}

/// The resolved source plus the status that explains it.
pub struct Resolved {
    pub source: Option<Arc<dyn BookSource>>,
    pub status: LabStatus,
}

/// Try local first, then the API. `api_base` overrides the default server
/// (used by the mode-parity test in §9 to point Lab at a local instance).
pub fn resolve(api_base: &str) -> Resolved {
    let lab_dir = kashshaf_common::lab_data_dir().ok().map(|p| p.display().to_string());
    let lab_version = env!("CARGO_PKG_VERSION").to_string();

    let corpus_dir = kashshaf_common::get_data_dir();
    let (local, local_error) = match &corpus_dir {
        Ok(dir) => match LocalSource::open(dir) {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(e.to_string())),
        },
        Err(e) => (None, Some(e.to_string())),
    };

    if let Some(local) = local {
        let toc_error = local.toc_status().err().map(|e| e.to_string());
        let status = LabStatus {
            mode: LabMode::Local,
            corpus_version: Some(local.corpus_version().to_string()),
            corpus_dir: Some(local.data_dir().display().to_string()),
            api_base: None,
            bulk_tokens: true,
            toc: toc_error.is_none(),
            toc_error,
            min_toc_corpus_version: crate::MIN_TOC_CORPUS_VERSION.to_string(),
            lab_dir,
            lab_version,
            local_error: None,
            api_error: None,
        };
        return Resolved { source: Some(Arc::new(local)), status };
    }

    match ApiSource::connect(api_base) {
        Ok(api) => {
            let toc_error = api.toc_status().err().map(|e| e.to_string());
            let status = LabStatus {
                mode: LabMode::Api,
                corpus_version: Some(api.corpus_version().to_string()),
                corpus_dir: corpus_dir.ok().map(|p| p.display().to_string()),
                api_base: Some(api.base().to_string()),
                bulk_tokens: api.supports_bulk_tokens(),
                toc: toc_error.is_none(),
                toc_error,
                min_toc_corpus_version: crate::MIN_TOC_CORPUS_VERSION.to_string(),
                lab_dir,
                lab_version,
                local_error,
                api_error: None,
            };
            Resolved { source: Some(Arc::new(api)), status }
        }
        Err(e) => Resolved {
            source: None,
            status: LabStatus {
                mode: LabMode::Unavailable,
                corpus_version: None,
                corpus_dir: corpus_dir.ok().map(|p| p.display().to_string()),
                api_base: Some(api_base.to_string()),
                bulk_tokens: false,
                toc: false,
                toc_error: None,
                min_toc_corpus_version: crate::MIN_TOC_CORPUS_VERSION.to_string(),
                lab_dir,
                lab_version,
                local_error,
                api_error: Some(e.to_string()),
            },
        },
    }
}
