//! Errors that cross the bridge.
//!
//! Lab shows the reason a thing cannot be done rather than hiding the control
//! that would do it (ground rule 5), so these carry a message meant for the
//! user, not a code.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum LabError {
    /// No corpus and no server: nothing can be read yet.
    #[error("No corpus is available: {0}")]
    NoSource(String),

    #[error("{0}")]
    Source(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for LabError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for LabError {
    fn from(e: anyhow::Error) -> Self {
        LabError::Source(e.to_string())
    }
}
