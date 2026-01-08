//! Token caching with LRU eviction, loads from SQLite corpus.db

use crate::tokens::{PageKey, Token, TokenClitic, TokenField};
use anyhow::{Context, Result};
use lru::LruCache;
use rusqlite::Connection;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct LookupTables {
    roots: HashMap<i64, String>,
    lemmas: HashMap<i64, String>,
    pos_types: HashMap<i64, String>,
    feature_sets: HashMap<i64, Vec<String>>,
    clitic_sets: HashMap<i64, Vec<TokenClitic>>,
}

pub struct TokenCache {
    cache: Mutex<LruCache<PageKey, Arc<Vec<Token>>>>,
    tokens_db_path: PathBuf,
    lookups: LookupTables,
}

impl TokenCache {
    pub fn new(tokens_db_path: PathBuf, capacity: usize) -> Self {
        let cache = LruCache::new(NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::new(1000).unwrap()));
        let lookups = Self::load_lookup_tables(&tokens_db_path).expect("Failed to load lookup tables");
        Self { cache: Mutex::new(cache), tokens_db_path, lookups }
    }

    fn load_lookup_tables(tokens_db_path: &PathBuf) -> Result<LookupTables> {
        let conn = Connection::open(tokens_db_path)
            .with_context(|| format!("Failed to open corpus.db at {:?}", tokens_db_path))?;

        let roots: HashMap<i64, String> = conn
            .prepare("SELECT id, root FROM roots")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let lemmas: HashMap<i64, String> = conn
            .prepare("SELECT id, lemma FROM lemmas")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let pos_types: HashMap<i64, String> = conn
            .prepare("SELECT id, pos FROM pos_types")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let feature_sets: HashMap<i64, Vec<String>> = conn
            .prepare("SELECT id, features FROM feature_sets")?
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let features_json: String = row.get(1)?;
                Ok((id, features_json))
            })?
            .filter_map(|r| r.ok())
            .map(|(id, json)| {
                let features: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
                (id, features)
            })
            .collect();

        let clitic_sets: HashMap<i64, Vec<TokenClitic>> = conn
            .prepare("SELECT id, clitics FROM clitic_sets")?
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let clitics_json: String = row.get(1)?;
                Ok((id, clitics_json))
            })?
            .filter_map(|r| r.ok())
            .map(|(id, json)| {
                let clitics: Vec<TokenClitic> = serde_json::from_str(&json).unwrap_or_default();
                (id, clitics)
            })
            .collect();

        Ok(LookupTables {
            roots,
            lemmas,
            pos_types,
            feature_sets,
            clitic_sets,
        })
    }

    pub fn get(&self, key: &PageKey) -> Result<Arc<Vec<Token>>> {
        {
            let mut cache = self.cache.lock().unwrap();
            if let Some(tokens) = cache.get(key) {
                return Ok(Arc::clone(tokens));
            }
        }

        let tokens = Arc::new(self.load_tokens_from_sqlite(key)?);
        {
            let mut cache = self.cache.lock().unwrap();
            cache.put(key.clone(), Arc::clone(&tokens));
        }
        Ok(tokens)
    }

    fn load_tokens_from_sqlite(&self, key: &PageKey) -> Result<Vec<Token>> {
        let conn = Connection::open(&self.tokens_db_path)
            .with_context(|| format!("Failed to open corpus.db at {:?}", self.tokens_db_path))?;

        let token_ids_blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT token_ids FROM page_tokens WHERE book_id = ?1 AND part_index = ?2 AND page_id = ?3",
                rusqlite::params![key.id as i64, key.part_index as i64, key.page_id as i64],
                |row| row.get(0),
            )
            .ok();

        let token_ids_blob = match token_ids_blob {
            Some(blob) => blob,
            None => return Ok(Vec::new()),
        };

        let token_ids: Vec<u32> = token_ids_blob
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();

        if token_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Build token definitions map in batches (SQLite limit is 999 variables)
        let mut token_defs: HashMap<u32, (String, i64, Option<i64>, i64, i64, i64)> = HashMap::new();

        for chunk in token_ids.chunks(500) {
            let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT id, surface, lemma_id, root_id, pos_id, feature_set_id, clitic_set_id
                 FROM token_definitions WHERE id IN ({})",
                placeholders
            );

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(chunk.iter().map(|id| *id as i64)),
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)? as u32,
                            (
                                row.get::<_, String>(1)?,  // surface
                                row.get::<_, i64>(2)?,     // lemma_id
                                row.get::<_, Option<i64>>(3)?, // root_id
                                row.get::<_, i64>(4)?,     // pos_id
                                row.get::<_, i64>(5)?,     // feature_set_id
                                row.get::<_, i64>(6)?,     // clitic_set_id
                            ),
                        ))
                    },
                )?
                .filter_map(|r| r.ok());

            for (id, data) in rows {
                token_defs.insert(id, data);
            }
        }

        let tokens: Vec<Token> = token_ids
            .iter()
            .enumerate()
            .filter_map(|(idx, &token_id)| {
                let (surface, lemma_id, root_id, pos_id, feature_set_id, clitic_set_id) =
                    token_defs.get(&token_id)?;

                let lemma = self.lookups.lemmas.get(lemma_id)?.clone();
                let root = root_id.and_then(|rid| self.lookups.roots.get(&rid).cloned());
                let pos = self.lookups.pos_types.get(pos_id)?.clone();
                let features = self.lookups.feature_sets.get(feature_set_id).cloned().unwrap_or_default();
                let clitics = self.lookups.clitic_sets.get(clitic_set_id).cloned().unwrap_or_default();

                Some(Token {
                    idx,
                    surface: surface.clone(),
                    noclitic_surface: None,
                    lemma,
                    root,
                    pos,
                    features,
                    clitics,
                })
            })
            .collect();

        Ok(tokens)
    }

    pub fn get_token_at(&self, key: &PageKey, idx: usize) -> Result<Option<Token>> {
        let tokens = self.get(key)?;
        Ok(tokens.get(idx).cloned())
    }

    pub fn find_positions(&self, key: &PageKey, field: TokenField, value: &str) -> Result<Vec<usize>> {
        let tokens = self.get(key)?;
        Ok(tokens.iter().filter(|t| field.matches(t, value)).map(|t| t.idx).collect())
    }

    pub fn clear(&self) {
        self.cache.lock().unwrap().clear();
    }

    pub fn stats(&self) -> (usize, usize) {
        let cache = self.cache.lock().unwrap();
        (cache.len(), cache.cap().get())
    }

    /// Find positions where a wildcard phrase matches.
    /// For a query like "معر*فة الله", finds positions where:
    /// 1. A token matches the wildcard pattern (prefix + optional suffix)
    /// 2. Following tokens match the remaining terms in order
    ///
    /// Returns all token indices that are part of complete phrase matches.
    pub fn find_wildcard_phrase_positions(
        &self,
        key: &PageKey,
        prefix: &str,
        suffix: Option<&str>,
        wildcard_term_index: usize,
        all_terms: &[String],
    ) -> Result<Vec<u32>> {
        let tokens = self.get(key)?;
        let mut positions: Vec<u32> = Vec::new();
        let num_terms = all_terms.len();

        if num_terms == 0 || tokens.is_empty() {
            return Ok(positions);
        }

        // Normalize for comparison
        let prefix_normalized = normalize_for_match(prefix);
        let suffix_normalized = suffix.map(normalize_for_match);
        let terms_normalized: Vec<String> = all_terms.iter().map(|t| normalize_for_match(t)).collect();

        // Iterate through tokens looking for phrase matches
        for i in 0..tokens.len() {
            // Check if we have enough tokens remaining for a full phrase match
            if i + num_terms > tokens.len() {
                break;
            }

            let mut phrase_matches = true;

            for (j, term_normalized) in terms_normalized.iter().enumerate() {
                let token = &tokens[i + j];
                let token_surface_normalized = normalize_for_match(&token.surface);

                if j == wildcard_term_index {
                    // This position should match the wildcard pattern
                    let matches_wildcard = match &suffix_normalized {
                        Some(suf) => {
                            token_surface_normalized.starts_with(&prefix_normalized)
                                && token_surface_normalized.ends_with(suf)
                        }
                        None => token_surface_normalized.starts_with(&prefix_normalized),
                    };
                    if !matches_wildcard {
                        phrase_matches = false;
                        break;
                    }
                } else {
                    // Exact match for non-wildcard terms
                    if token_surface_normalized != *term_normalized {
                        phrase_matches = false;
                        break;
                    }
                }
            }

            if phrase_matches {
                // Add all token positions in this matched phrase
                for j in 0..num_terms {
                    positions.push((i + j) as u32);
                }
            }
        }

        Ok(positions)
    }
}

/// Normalize Arabic text for matching: removes diacritics, normalizes hamza/alif variants
fn normalize_for_match(text: &str) -> String {
    text.chars()
        .filter_map(|c| {
            match c {
                // Skip diacritics
                '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0671}' => None,
                // Normalize alif variants
                'أ' | 'إ' | 'آ' => Some('ا'),
                // Normalize other variants
                'ؤ' => Some('و'),
                'ئ' | 'ى' => Some('ي'),
                'ک' | 'گ' | 'ڭ' => Some('ك'),
                'ی' | 'ے' => Some('ي'),
                'ۀ' | 'ە' => Some('ه'),
                'ۃ' => Some('ة'),
                'ٹ' => Some('ت'),
                'پ' => Some('ب'),
                'چ' => Some('ج'),
                'ژ' => Some('ز'),
                'ڤ' => Some('ف'),
                'ڨ' => Some('ق'),
                _ => Some(c),
            }
        })
        .collect()
}
