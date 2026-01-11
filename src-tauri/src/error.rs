//! Error types for Kashshaf

use thiserror::Error;

#[derive(Error, Debug)]
pub enum KashshafError {
    #[error("Search error: {0}")]
    Search(String),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid query: {0}")]
    InvalidQuery(String),

    #[error("Download error: {0}")]
    Download(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Corpus not ready: {0}")]
    CorpusNotReady(String),

    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for KashshafError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
