//! Token types and field matching

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenClitic {
    #[serde(rename = "type")]
    pub clitic_type: String,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub idx: usize,
    pub surface: String,
    pub noclitic_surface: Option<String>,
    pub lemma: String,
    pub root: Option<String>,
    pub pos: String,
    pub features: Vec<String>,
    pub clitics: Vec<TokenClitic>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct PageKey {
    pub id: u64,
    pub page_id: u64,
}

impl PageKey {
    pub fn new(id: u64, page_id: u64) -> Self {
        Self { id, page_id }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenField {
    Surface,
    Lemma,
    Root,
}

impl TokenField {
    pub fn matches(&self, token: &Token, value: &str) -> bool {
        match self {
            TokenField::Surface => token.surface == value,
            TokenField::Lemma => token.lemma == value,
            TokenField::Root => token.root.as_deref() == Some(value),
        }
    }

    pub fn get_value<'a>(&self, token: &'a Token) -> Option<&'a str> {
        match self {
            TokenField::Surface => Some(&token.surface),
            TokenField::Lemma => Some(&token.lemma),
            TokenField::Root => token.root.as_deref(),
        }
    }
}
