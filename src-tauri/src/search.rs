//! Search functionality using Tantivy

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use tantivy::collector::{Count, TopDocs};
use tantivy::postings::Postings;
use tantivy::query::{BooleanQuery, Occur, PhraseQuery, Query, QueryParser, TermQuery, RegexQuery};
use tantivy::schema::*;
use tantivy::{DocAddress, DocSet, Index, ReloadPolicy, SegmentReader, Term};

/// Normalize Arabic text for search: removes diacritics, normalizes hamza/alif variants
fn normalize_arabic(text: &str) -> String {
    text.chars()
        .filter_map(|c| {
            match c {
                '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0671}' => None,
                'أ' | 'إ' | 'آ' => Some('ا'),
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

/// Convert root query to indexed format: adds dots between chars, replaces weak letters with #
pub fn normalize_root_query(query: &str) -> String {
    let normalized = normalize_arabic(query);
    let weak_letters = ['و', 'ي', 'ا', 'ء'];

    normalized
        .split_whitespace()
        .map(|word| {
            word.chars()
                .map(|c| if weak_letters.contains(&c) { "#".to_string() } else { c.to_string() })
                .collect::<Vec<_>>()
                .join(".")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Surface,
    #[default]
    Lemma,
    Root,
}

/// Wildcard query validation error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WildcardValidationError {
    pub message: String,
}

/// Parsed wildcard query information
#[derive(Debug, Clone)]
pub struct WildcardQueryInfo {
    pub has_wildcard: bool,
    pub wildcard_term_index: usize,  // Which word has the wildcard (0-based)
    pub wildcard_type: WildcardType,
    pub prefix: String,              // Characters before *
    pub suffix: Option<String>,      // Characters after * (for internal wildcards)
    pub terms: Vec<String>,          // All terms in the query
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WildcardType {
    None,
    Prefix,    // أب* - wildcard at end
    Internal,  // أح*مد - wildcard in middle
}

/// Count Arabic letters (excluding diacritics)
fn count_arabic_letters(text: &str) -> usize {
    text.chars()
        .filter(|c| {
            let code = *c as u32;
            // Arabic letters: 0x0621-0x064A (excluding diacritics 0x064B-0x065F)
            (code >= 0x0621 && code <= 0x064A) ||
            // Extended Arabic letters
            (code >= 0x0671 && code <= 0x06D3)
        })
        .count()
}

/// Validate a wildcard query
///
/// Rules:
/// 1. Only one `*` per search input
/// 2. `*` cannot be at start of word
/// 3. Internal `*` requires 2+ chars before
/// 4. Surface mode only
pub fn validate_wildcard_query(query: &str, mode: SearchMode) -> Result<(), WildcardValidationError> {
    let trimmed = query.trim();

    if !trimmed.contains('*') {
        return Ok(());
    }

    // Rule: Surface mode only
    if mode != SearchMode::Surface {
        return Err(WildcardValidationError {
            message: "Wildcards only supported in Surface mode".to_string(),
        });
    }

    // Rule 1: Only one wildcard
    let wildcard_count = trimmed.matches('*').count();
    if wildcard_count > 1 {
        return Err(WildcardValidationError {
            message: "Only one wildcard (*) allowed per search term".to_string(),
        });
    }

    // Check each word
    for word in trimmed.split_whitespace() {
        if !word.contains('*') {
            continue;
        }

        let wildcard_idx = word.find('*').unwrap();

        // Rule 2: Cannot be at start
        if wildcard_idx == 0 {
            return Err(WildcardValidationError {
                message: "Wildcard cannot be at start of word".to_string(),
            });
        }

        // Rule 3: Internal wildcard requires 2+ chars before
        let has_chars_after = wildcard_idx < word.len() - 1;
        if has_chars_after {
            let prefix = &word[..wildcard_idx];
            if count_arabic_letters(prefix) < 2 {
                return Err(WildcardValidationError {
                    message: "Internal wildcard requires at least 2 characters before it".to_string(),
                });
            }
        }
    }

    Ok(())
}

/// Parse a wildcard query into its components
pub fn parse_wildcard_query(query: &str) -> WildcardQueryInfo {
    let words: Vec<String> = query.trim()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    let mut result = WildcardQueryInfo {
        has_wildcard: false,
        wildcard_term_index: 0,
        wildcard_type: WildcardType::None,
        prefix: String::new(),
        suffix: None,
        terms: words.clone(),
    };

    for (i, word) in words.iter().enumerate() {
        if word.contains('*') {
            result.has_wildcard = true;
            result.wildcard_term_index = i;

            let wildcard_idx = word.find('*').unwrap();
            result.prefix = word[..wildcard_idx].to_string();

            if wildcard_idx < word.len() - 1 {
                result.wildcard_type = WildcardType::Internal;
                result.suffix = Some(word[wildcard_idx + 1..].to_string());
            } else {
                result.wildcard_type = WildcardType::Prefix;
            }

            break;
        }
    }

    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchTerm {
    pub query: String,
    pub mode: SearchMode,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    pub author_id: Option<u64>,
    pub author: Option<String>,
    pub genre: Option<String>,
    pub corpus: Option<String>,
    pub death_ah_min: Option<u64>,
    pub death_ah_max: Option<u64>,
    pub century_ah: Option<u64>,
    pub book_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: u64,
    pub part_index: u64,
    pub page_id: u64,
    pub author_id: Option<u64>,
    pub corpus: String,
    pub author: String,
    pub title: String,
    pub death_ah: Option<u64>,
    pub century_ah: Option<u64>,
    pub genre: Option<String>,
    pub part_label: String,
    pub page_number: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body: String,
    pub score: f32,
    pub matched_token_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub query: String,
    pub mode: SearchMode,
    pub total_hits: usize,
    pub results: Vec<SearchResult>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageWithMatches {
    pub title: String,
    pub author: String,
    pub part_label: String,
    pub page_number: String,
    pub body: String,
    pub matched_token_indices: Vec<u32>,
}

pub struct SearchEngine {
    index: Index,
    schema: Schema,
}

impl SearchEngine {
    pub fn open(index_path: &Path) -> Result<Self> {
        let index = Index::open_in_dir(index_path)?;
        index.tokenizers().register("whitespace", tantivy::tokenizer::WhitespaceTokenizer::default());
        let schema = index.schema();
        Ok(Self { index, schema })
    }

    pub fn search(
        &self,
        query: &str,
        mode: SearchMode,
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();

        let search_field = match mode {
            SearchMode::Surface => self.schema.get_field("surface_text").unwrap(),
            SearchMode::Lemma => self.schema.get_field("lemma_text").unwrap(),
            SearchMode::Root => self.schema.get_field("root_text").unwrap(),
        };

        let normalized_query = match mode {
            SearchMode::Root => normalize_root_query(query),
            SearchMode::Surface => normalize_arabic(query),
            SearchMode::Lemma => query.to_string(),
        };

        let mut tokenizer = self.index.tokenizers().get("whitespace").unwrap();
        let mut token_stream = tokenizer.token_stream(&normalized_query);
        let mut query_terms: HashSet<String> = HashSet::new();
        while token_stream.advance() {
            query_terms.insert(token_stream.token().text.clone());
        }

        let text_query: Box<dyn Query> = if query_terms.len() > 1 {
            // Multi-word query: use PhraseQuery for all modes
            let terms: Vec<Term> = normalized_query
                .split_whitespace()
                .map(|word| Term::from_field_text(search_field, word))
                .collect();
            Box::new(PhraseQuery::new(terms))
        } else {
            let query_parser = QueryParser::for_index(&self.index, vec![search_field]);
            query_parser.parse_query(&normalized_query)?
        };

        let final_query: Box<dyn Query> = if let Some(ref book_ids) = filters.book_ids {
            if book_ids.is_empty() {
                text_query
            } else {
                let id_field = self.schema.get_field("id").unwrap();
                let book_id_queries: Vec<(Occur, Box<dyn Query>)> = book_ids
                    .iter()
                    .map(|&id| {
                        let term = Term::from_field_u64(id_field, id);
                        let term_query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, term_query)
                    })
                    .collect();
                let book_ids_query = BooleanQuery::new(book_id_queries);
                let combined = BooleanQuery::new(vec![
                    (Occur::Must, text_query),
                    (Occur::Must, Box::new(book_ids_query)),
                ]);
                Box::new(combined)
            }
        } else {
            text_query
        };

        let (total_hits, top_docs) =
            searcher.search(&*final_query, &(Count, TopDocs::with_limit(limit + offset)))?;

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let author_id_field = self.schema.get_field("author_id").unwrap();
        let corpus_field = self.schema.get_field("corpus").unwrap();
        let author_field = self.schema.get_field("author").unwrap();
        let title_field = self.schema.get_field("title").unwrap();
        let death_ah_field = self.schema.get_field("death_ah").unwrap();
        let century_ah_field = self.schema.get_field("century_ah").unwrap();
        let genre_field = self.schema.get_field("genre").unwrap();
        let part_label_field = self.schema.get_field("part_label").unwrap();
        let page_number_field = self.schema.get_field("page_number").unwrap();
        let body_field = self.schema.get_field("body").unwrap();

        // Extract all results first, then sort by death_ah
        let mut results = Vec::new();
        for (score, doc_address) in top_docs.into_iter() {
            let doc: TantivyDocument = searcher.doc(doc_address)?;

            let body = doc
                .get_first(body_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let matched_token_indices = if !query_terms.is_empty() {
                // For phrase searches (multiple words), only highlight consecutive matches
                if query_terms.len() > 1 {
                    let phrase_terms: Vec<String> = normalized_query.split_whitespace().map(|s| s.to_string()).collect();
                    self.get_phrase_positions_limited(
                        searcher.segment_reader(doc_address.segment_ord),
                        doc_address.doc_id,
                        search_field,
                        &phrase_terms,
                        5,
                    )
                } else {
                    self.get_matched_positions_limited(
                        searcher.segment_reader(doc_address.segment_ord),
                        doc_address.doc_id,
                        search_field,
                        &query_terms,
                        5,
                    )
                }
            } else {
                Vec::new()
            };

            let result = SearchResult {
                id: doc
                    .get_first(id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                part_index: doc
                    .get_first(part_index_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                page_id: doc
                    .get_first(page_id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                corpus: doc
                    .get_first(corpus_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: doc
                    .get_first(author_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: doc
                    .get_first(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                genre: doc
                    .get_first(genre_field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                part_label: doc
                    .get_first(part_label_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                page_number: doc
                    .get_first(page_number_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body,
                score,
                matched_token_indices,
            };

            results.push(result);
        }

        // Sort by death_ah (author death year), earliest first. Documents without death_ah go last.
        results.sort_by(|a, b| {
            match (a.death_ah, b.death_ah) {
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        // Apply offset and limit after sorting
        let results: Vec<SearchResult> = results.into_iter().skip(offset).take(limit).collect();

        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(SearchResults {
            query: query.to_string(),
            mode,
            total_hits,
            results,
            elapsed_ms,
        })
    }

    /// Get token positions where query terms appear (limited to first N for performance)
    /// For single terms, returns all positions. For phrase queries (ordered terms),
    /// only returns positions where terms appear consecutively.
    fn get_matched_positions_limited(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        query_terms: &HashSet<String>,
        max_positions: usize,
    ) -> Vec<u32> {
        self.get_matched_positions_internal(segment_reader, doc_id, field, query_terms, None, max_positions)
    }

    /// Get positions for phrase matches only (consecutive terms in order)
    fn get_phrase_positions_limited(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        phrase_terms: &[String],
        max_positions: usize,
    ) -> Vec<u32> {
        if phrase_terms.is_empty() {
            return Vec::new();
        }
        if phrase_terms.len() == 1 {
            let terms_set: HashSet<String> = phrase_terms.iter().cloned().collect();
            return self.get_matched_positions_internal(segment_reader, doc_id, field, &terms_set, None, max_positions);
        }

        let Ok(inverted_index) = segment_reader.inverted_index(field) else {
            return Vec::new();
        };

        // Collect positions for each term in the phrase
        let mut term_positions: Vec<Vec<u32>> = Vec::new();
        for term_str in phrase_terms {
            let term = Term::from_field_text(field, term_str);
            let Ok(Some(mut postings)) = inverted_index.read_postings(&term, IndexRecordOption::WithFreqsAndPositions) else {
                return Vec::new(); // All terms must be present
            };

            // Check current position before seeking - a fresh postings iterator
            // points to its first document, which may already be past our target.
            // Calling seek() when current_doc > target triggers a Tantivy assertion.
            let current_doc = postings.doc();
            if current_doc == tantivy::TERMINATED || current_doc > doc_id {
                return Vec::new(); // Term not in this doc
            }

            let found_doc = if current_doc == doc_id {
                doc_id
            } else {
                postings.seek(doc_id)
            };

            if found_doc != doc_id {
                return Vec::new(); // Term not in this doc
            }

            let mut pos_buffer: Vec<u32> = Vec::new();
            postings.positions(&mut pos_buffer);
            term_positions.push(pos_buffer);
        }

        // Find consecutive sequences: position of term[0], term[0]+1 for term[1], etc.
        let mut matched_positions: Vec<u32> = Vec::new();
        let first_positions = &term_positions[0];

        for &start_pos in first_positions {
            let mut is_phrase_match = true;
            for (offset, positions) in term_positions.iter().enumerate().skip(1) {
                let expected_pos = start_pos + offset as u32;
                if !positions.contains(&expected_pos) {
                    is_phrase_match = false;
                    break;
                }
            }
            if is_phrase_match {
                // Add all positions in this phrase match
                for offset in 0..phrase_terms.len() {
                    matched_positions.push(start_pos + offset as u32);
                }
            }
            if matched_positions.len() >= max_positions {
                break;
            }
        }

        matched_positions.sort_unstable();
        matched_positions.dedup();
        matched_positions.truncate(max_positions);
        matched_positions
    }

    /// Internal implementation for getting term positions
    fn get_matched_positions_internal(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        query_terms: &HashSet<String>,
        _phrase_order: Option<&[String]>,
        max_positions: usize,
    ) -> Vec<u32> {
        let mut positions: Vec<u32> = Vec::new();

        let Ok(inverted_index) = segment_reader.inverted_index(field) else {
            return positions;
        };

        for term_str in query_terms {
            let term = Term::from_field_text(field, term_str);
            let Ok(Some(mut postings)) = inverted_index.read_postings(&term, IndexRecordOption::WithFreqsAndPositions) else {
                continue;
            };

            let current_doc = postings.doc();
            if current_doc == tantivy::TERMINATED || current_doc > doc_id {
                continue;
            }

            if current_doc == doc_id {
                let mut pos_buffer: Vec<u32> = Vec::new();
                postings.positions(&mut pos_buffer);
                positions.extend(pos_buffer);
            } else if postings.seek(doc_id) == doc_id {
                let mut pos_buffer: Vec<u32> = Vec::new();
                postings.positions(&mut pos_buffer);
                positions.extend(pos_buffer);
            }

            if positions.len() >= max_positions {
                break;
            }
        }

        positions.sort_unstable();
        positions.dedup();
        positions.truncate(max_positions);
        positions
    }

    /// Batch position extraction for multiple docs in one segment pass
    fn get_matched_positions_batch(
        &self,
        segment_reader: &SegmentReader,
        doc_ids: &[u32],
        field: Field,
        query_terms: &HashSet<String>,
        max_positions_per_doc: usize,
    ) -> std::collections::HashMap<u32, Vec<u32>> {
        let mut results: std::collections::HashMap<u32, Vec<u32>> =
            doc_ids.iter().map(|&id| (id, Vec::new())).collect();

        let Ok(inverted_index) = segment_reader.inverted_index(field) else {
            return results;
        };

        for term_str in query_terms {
            let term = Term::from_field_text(field, term_str);
            let Ok(Some(mut postings)) = inverted_index.read_postings(&term, IndexRecordOption::WithFreqsAndPositions) else {
                continue;
            };

            for &doc_id in doc_ids {
                while postings.doc() != tantivy::TERMINATED && postings.doc() < doc_id {
                    postings.advance();
                }

                if postings.doc() == doc_id {
                    if let Some(pos_vec) = results.get_mut(&doc_id) {
                        if pos_vec.len() < max_positions_per_doc {
                            let mut buf = Vec::new();
                            postings.positions(&mut buf);
                            pos_vec.extend(buf);
                        }
                    }
                }

                if postings.doc() == tantivy::TERMINATED {
                    break;
                }
            }
        }

        for pos_vec in results.values_mut() {
            pos_vec.sort_unstable();
            pos_vec.dedup();
            pos_vec.truncate(max_positions_per_doc);
        }

        results
    }

    fn get_matched_positions(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        query_terms: &HashSet<String>,
    ) -> Vec<u32> {
        self.get_matched_positions_limited(segment_reader, doc_id, field, query_terms, 5)
    }

    pub fn get_page(&self, id: u64, part_index: u64, page_id: u64) -> Result<Option<SearchResult>> {
        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();
        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();

        let query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(id_field, id), IndexRecordOption::Basic)) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(part_index_field, part_index), IndexRecordOption::Basic)) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(Term::from_field_u64(page_id_field, page_id), IndexRecordOption::Basic)) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&query, &TopDocs::with_limit(1))?;

        if let Some((score, doc_address)) = top_docs.into_iter().next() {
            let doc: TantivyDocument = searcher.doc(doc_address)?;

            let author_id_field = self.schema.get_field("author_id").unwrap();
            let corpus_field = self.schema.get_field("corpus").unwrap();
            let author_field = self.schema.get_field("author").unwrap();
            let title_field = self.schema.get_field("title").unwrap();
            let death_ah_field = self.schema.get_field("death_ah").unwrap();
            let century_ah_field = self.schema.get_field("century_ah").unwrap();
            let genre_field = self.schema.get_field("genre").unwrap();
            let part_label_field = self.schema.get_field("part_label").unwrap();
            let page_number_field = self.schema.get_field("page_number").unwrap();
            let body_field = self.schema.get_field("body").unwrap();

            let result = SearchResult {
                id,
                part_index,
                page_id,
                author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                corpus: doc
                    .get_first(corpus_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: doc
                    .get_first(author_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: doc
                    .get_first(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                genre: doc
                    .get_first(genre_field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                part_label: doc
                    .get_first(part_label_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                page_number: doc
                    .get_first(page_number_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: doc
                    .get_first(body_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                score,
                matched_token_indices: Vec::new(),
            };

            Ok(Some(result))
        } else {
            Ok(None)
        }
    }

    pub fn doc_count(&self) -> Result<u64> {
        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        Ok(reader.searcher().num_docs())
    }

    pub fn get_match_positions(
        &self,
        id: u64,
        part_index: u64,
        page_id: u64,
        query: &str,
        mode: SearchMode,
    ) -> Result<Vec<u32>> {
        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();

        let search_field = match mode {
            SearchMode::Surface => self.schema.get_field("surface_text").unwrap(),
            SearchMode::Lemma => self.schema.get_field("lemma_text").unwrap(),
            SearchMode::Root => self.schema.get_field("root_text").unwrap(),
        };

        let normalized_query = match mode {
            SearchMode::Root => normalize_root_query(query),
            SearchMode::Surface => normalize_arabic(query),
            SearchMode::Lemma => query.to_string(),
        };

        let mut tokenizer = self.index.tokenizers().get("whitespace").unwrap();
        let mut token_stream = tokenizer.token_stream(&normalized_query);
        let mut query_terms: HashSet<String> = HashSet::new();
        while token_stream.advance() {
            query_terms.insert(token_stream.token().text.clone());
        }

        if query_terms.is_empty() {
            return Ok(Vec::new());
        }

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();

        let query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(id_field, id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(part_index_field, part_index),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(page_id_field, page_id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&query, &TopDocs::with_limit(1))?;

        if let Some((_score, doc_address)) = top_docs.into_iter().next() {
            // For phrase searches (multiple words), only return positions of consecutive matches
            if query_terms.len() > 1 {
                let phrase_terms: Vec<String> = normalized_query.split_whitespace().map(|s| s.to_string()).collect();
                Ok(self.get_phrase_positions_limited(
                    searcher.segment_reader(doc_address.segment_ord),
                    doc_address.doc_id,
                    search_field,
                    &phrase_terms,
                    100,
                ))
            } else {
                Ok(self.get_matched_positions(
                    searcher.segment_reader(doc_address.segment_ord),
                    doc_address.doc_id,
                    search_field,
                    &query_terms,
                ))
            }
        } else {
            Ok(Vec::new())
        }
    }

    pub fn get_page_with_matches(
        &self,
        id: u64,
        part_index: u64,
        page_id: u64,
        query: &str,
        mode: SearchMode,
    ) -> Result<Option<PageWithMatches>> {
        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();
        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();

        let page_query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(id_field, id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(part_index_field, part_index),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(page_id_field, page_id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&page_query, &TopDocs::with_limit(1))?;

        if let Some((_score, doc_address)) = top_docs.into_iter().next() {
            let doc: TantivyDocument = searcher.doc(doc_address)?;
            let title_field = self.schema.get_field("title").unwrap();
            let author_field = self.schema.get_field("author").unwrap();
            let part_label_field = self.schema.get_field("part_label").unwrap();
            let page_number_field = self.schema.get_field("page_number").unwrap();
            let body_field = self.schema.get_field("body").unwrap();

            let title = doc
                .get_first(title_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let author = doc
                .get_first(author_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let part_label = doc
                .get_first(part_label_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let page_number = doc
                .get_first(page_number_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = doc
                .get_first(body_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let matched_token_indices = if !query.is_empty() {
                let search_field = match mode {
                    SearchMode::Surface => self.schema.get_field("surface_text").unwrap(),
                    SearchMode::Lemma => self.schema.get_field("lemma_text").unwrap(),
                    SearchMode::Root => self.schema.get_field("root_text").unwrap(),
                };

                let normalized_query = match mode {
                    SearchMode::Root => normalize_root_query(query),
                    SearchMode::Surface => normalize_arabic(query),
                    SearchMode::Lemma => query.to_string(),
                };

                let mut tokenizer = self.index.tokenizers().get("whitespace").unwrap();
                let mut token_stream = tokenizer.token_stream(&normalized_query);
                let mut query_terms: HashSet<String> = HashSet::new();
                while token_stream.advance() {
                    query_terms.insert(token_stream.token().text.clone());
                }

                if !query_terms.is_empty() {
                    // For phrase searches (multiple words), only highlight consecutive matches
                    if query_terms.len() > 1 {
                        let phrase_terms: Vec<String> = normalized_query.split_whitespace().map(|s| s.to_string()).collect();
                        self.get_phrase_positions_limited(
                            searcher.segment_reader(doc_address.segment_ord),
                            doc_address.doc_id,
                            search_field,
                            &phrase_terms,
                            100,
                        )
                    } else {
                        self.get_matched_positions(
                            searcher.segment_reader(doc_address.segment_ord),
                            doc_address.doc_id,
                            search_field,
                            &query_terms,
                        )
                    }
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };

            Ok(Some(PageWithMatches {
                title,
                author,
                part_label,
                page_number,
                body,
                matched_token_indices,
            }))
        } else {
            Ok(None)
        }
    }

    fn build_term_query(&self, term: &SearchTerm) -> Result<Box<dyn Query>> {
        let search_field = match term.mode {
            SearchMode::Surface => self.schema.get_field("surface_text").unwrap(),
            SearchMode::Lemma => self.schema.get_field("lemma_text").unwrap(),
            SearchMode::Root => self.schema.get_field("root_text").unwrap(),
        };

        let normalized_query = match term.mode {
            SearchMode::Root => normalize_root_query(&term.query),
            SearchMode::Surface => normalize_arabic(&term.query),
            SearchMode::Lemma => term.query.clone(),
        };

        let words: Vec<&str> = normalized_query.split_whitespace().collect();

        if words.len() > 1 {
            // Multi-word query: use PhraseQuery for all modes
            let terms: Vec<Term> = words
                .iter()
                .map(|word| Term::from_field_text(search_field, word))
                .collect();
            Ok(Box::new(PhraseQuery::new(terms)))
        } else if words.len() == 1 {
            Ok(Box::new(TermQuery::new(
                Term::from_field_text(search_field, words[0]),
                IndexRecordOption::Basic,
            )))
        } else {
            // Empty query - use query parser as fallback
            let query_parser = QueryParser::for_index(&self.index, vec![search_field]);
            Ok(query_parser.parse_query(&normalized_query)?)
        }
    }

    fn extract_query_terms(&self, term: &SearchTerm) -> HashSet<String> {
        let mut terms = HashSet::new();

        let normalized_query = match term.mode {
            SearchMode::Root => normalize_root_query(&term.query),
            SearchMode::Surface => normalize_arabic(&term.query),
            SearchMode::Lemma => term.query.clone(),
        };

        let mut tokenizer = self.index.tokenizers().get("whitespace").unwrap();
        let mut token_stream = tokenizer.token_stream(&normalized_query);
        while token_stream.advance() {
            terms.insert(token_stream.token().text.clone());
        }

        terms
    }

    fn get_search_field(&self, mode: SearchMode) -> Field {
        match mode {
            SearchMode::Surface => self.schema.get_field("surface_text").unwrap(),
            SearchMode::Lemma => self.schema.get_field("lemma_text").unwrap(),
            SearchMode::Root => self.schema.get_field("root_text").unwrap(),
        }
    }

    /// Check if a SearchTerm represents a phrase search (multiple words in any mode)
    fn is_phrase_search(&self, term: &SearchTerm) -> bool {
        let normalized = match term.mode {
            SearchMode::Root => normalize_root_query(&term.query),
            SearchMode::Surface => normalize_arabic(&term.query),
            SearchMode::Lemma => term.query.clone(),
        };
        normalized.split_whitespace().count() > 1
    }

    /// Extract ordered phrase terms from a SearchTerm (for phrase searches)
    fn extract_phrase_terms(&self, term: &SearchTerm) -> Vec<String> {
        let normalized = match term.mode {
            SearchMode::Root => normalize_root_query(&term.query),
            SearchMode::Surface => normalize_arabic(&term.query),
            SearchMode::Lemma => term.query.clone(),
        };
        normalized.split_whitespace().map(|s| s.to_string()).collect()
    }

    pub fn get_match_positions_combined(
        &self,
        id: u64,
        part_index: u64,
        page_id: u64,
        terms: &[SearchTerm],
    ) -> Result<Vec<u32>> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();
        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();

        let page_query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(id_field, id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(part_index_field, part_index),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(page_id_field, page_id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&page_query, &TopDocs::with_limit(1))?;

        if let Some((_score, doc_address)) = top_docs.into_iter().next() {
            let segment_reader = searcher.segment_reader(doc_address.segment_ord);
            let mut positions: Vec<u32> = Vec::new();

            for term in terms {
                let field = self.get_search_field(term.mode);

                // For Surface mode phrase searches, only get consecutive match positions
                if self.is_phrase_search(term) {
                    let phrase_terms = self.extract_phrase_terms(term);
                    let phrase_positions = self.get_phrase_positions_limited(
                        segment_reader,
                        doc_address.doc_id,
                        field,
                        &phrase_terms,
                        50,
                    );
                    positions.extend(phrase_positions);
                } else {
                    let query_terms = self.extract_query_terms(term);
                    if !query_terms.is_empty() {
                        let field_positions = self.get_matched_positions_limited(
                            segment_reader,
                            doc_address.doc_id,
                            field,
                            &query_terms,
                            50,
                        );
                        positions.extend(field_positions);
                    }
                }
            }

            positions.sort_unstable();
            positions.dedup();
            Ok(positions)
        } else {
            Ok(Vec::new())
        }
    }

    pub fn get_match_positions_multi(
        &self,
        id: u64,
        part_index: u64,
        page_id: u64,
        terms: &[SearchTerm],
    ) -> Result<Vec<Vec<u32>>> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let searcher = reader.searcher();
        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();

        let page_query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(id_field, id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(part_index_field, part_index),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(page_id_field, page_id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&page_query, &TopDocs::with_limit(1))?;

        if let Some((_score, doc_address)) = top_docs.into_iter().next() {
            let segment_reader = searcher.segment_reader(doc_address.segment_ord);
            let mut all_positions = Vec::with_capacity(terms.len());

            for term in terms {
                let field = self.get_search_field(term.mode);

                // For Surface mode phrase searches, only get consecutive match positions
                let positions = if self.is_phrase_search(term) {
                    let phrase_terms = self.extract_phrase_terms(term);
                    self.get_phrase_positions_limited(segment_reader, doc_address.doc_id, field, &phrase_terms, 100)
                } else {
                    let query_terms = self.extract_query_terms(term);
                    if query_terms.is_empty() {
                        Vec::new()
                    } else {
                        self.get_matched_positions_limited(segment_reader, doc_address.doc_id, field, &query_terms, 100)
                    }
                };
                all_positions.push(positions);
            }

            Ok(all_positions)
        } else {
            Ok(vec![Vec::new(); terms.len()])
        }
    }

    pub fn combined_search(
        &self,
        and_terms: &[SearchTerm],
        or_terms: &[SearchTerm],
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let searcher = reader.searcher();

        if and_terms.is_empty() && or_terms.is_empty() {
            return Ok(SearchResults {
                query: String::new(),
                mode: SearchMode::Lemma,
                total_hits: 0,
                results: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let text_query: Box<dyn Query> = if and_terms.len() == 1 && or_terms.is_empty() {
            self.build_term_query(&and_terms[0])?
        } else if and_terms.is_empty() && or_terms.len() == 1 {
            self.build_term_query(&or_terms[0])?
        } else {
            let mut must_clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for term in and_terms {
                let term_query = self.build_term_query(term)?;
                must_clauses.push((Occur::Must, term_query));
            }
            if !or_terms.is_empty() {
                let mut or_clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
                for term in or_terms {
                    let term_query = self.build_term_query(term)?;
                    or_clauses.push((Occur::Should, term_query));
                }
                let or_query = BooleanQuery::new(or_clauses);
                must_clauses.push((Occur::Must, Box::new(or_query)));
            }
            Box::new(BooleanQuery::new(must_clauses))
        };

        let final_query: Box<dyn Query> = if let Some(ref book_ids) = filters.book_ids {
            if book_ids.is_empty() {
                text_query
            } else {
                let id_field = self.schema.get_field("id").unwrap();
                let book_id_queries: Vec<(Occur, Box<dyn Query>)> = book_ids
                    .iter()
                    .map(|&id| {
                        let term = Term::from_field_u64(id_field, id);
                        let term_query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, term_query)
                    })
                    .collect();
                let book_ids_query = BooleanQuery::new(book_id_queries);
                let combined = BooleanQuery::new(vec![
                    (Occur::Must, text_query),
                    (Occur::Must, Box::new(book_ids_query)),
                ]);
                Box::new(combined)
            }
        } else {
            text_query
        };

        let (total_hits, top_docs) =
            searcher.search(&*final_query, &(Count, TopDocs::with_limit(limit + offset)))?;

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let author_id_field = self.schema.get_field("author_id").unwrap();
        let corpus_field = self.schema.get_field("corpus").unwrap();
        let author_field = self.schema.get_field("author").unwrap();
        let title_field = self.schema.get_field("title").unwrap();
        let death_ah_field = self.schema.get_field("death_ah").unwrap();
        let century_ah_field = self.schema.get_field("century_ah").unwrap();
        let genre_field = self.schema.get_field("genre").unwrap();
        let part_label_field = self.schema.get_field("part_label").unwrap();
        let page_number_field = self.schema.get_field("page_number").unwrap();
        let body_field = self.schema.get_field("body").unwrap();

        let mut by_segment: std::collections::HashMap<u32, Vec<(f32, DocAddress)>> = std::collections::HashMap::new();
        for (score, addr) in top_docs.into_iter().skip(offset).take(limit) {
            by_segment.entry(addr.segment_ord).or_default().push((score, addr));
        }

        // Collect phrase search terms separately for special handling
        let phrase_terms: Vec<&SearchTerm> = and_terms.iter().chain(or_terms.iter())
            .filter(|t| self.is_phrase_search(t))
            .collect();
        let non_phrase_terms: Vec<&SearchTerm> = and_terms.iter().chain(or_terms.iter())
            .filter(|t| !self.is_phrase_search(t))
            .collect();

        // Build terms_by_field only for non-phrase terms
        let mut terms_by_field: std::collections::HashMap<Field, HashSet<String>> = std::collections::HashMap::new();
        for term in &non_phrase_terms {
            let field = self.get_search_field(term.mode);
            let query_terms = self.extract_query_terms(term);
            terms_by_field.entry(field).or_default().extend(query_terms);
        }

        let mut results = Vec::new();
        for (segment_ord, mut docs) in by_segment {
            docs.sort_by_key(|(_, addr)| addr.doc_id);
            let segment_reader = searcher.segment_reader(segment_ord);
            let doc_ids: Vec<u32> = docs.iter().map(|(_, addr)| addr.doc_id).collect();

            // Batch process non-phrase terms
            let mut positions_by_doc: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
            for (field, query_terms) in &terms_by_field {
                let field_positions = self.get_matched_positions_batch(segment_reader, &doc_ids, *field, query_terms, 5);
                for (doc_id, positions) in field_positions {
                    positions_by_doc.entry(doc_id).or_insert_with(Vec::new).extend(positions);
                }
            }

            // Process phrase terms individually for each doc
            for &doc_id in &doc_ids {
                for term in &phrase_terms {
                    let field = self.get_search_field(term.mode);
                    let phrase_words = self.extract_phrase_terms(term);
                    let phrase_positions = self.get_phrase_positions_limited(
                        segment_reader,
                        doc_id,
                        field,
                        &phrase_words,
                        5,
                    );
                    positions_by_doc.entry(doc_id).or_insert_with(Vec::new).extend(phrase_positions);
                }
            }

            for (score, doc_address) in docs {
                let doc: TantivyDocument = searcher.doc(doc_address)?;

                let mut matched = positions_by_doc
                    .remove(&doc_address.doc_id)
                    .unwrap_or_default();
                matched.sort_unstable();
                matched.dedup();

                let result = SearchResult {
                    id: doc
                        .get_first(id_field)
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    part_index: doc
                        .get_first(part_index_field)
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    page_id: doc
                        .get_first(page_id_field)
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                    corpus: doc
                        .get_first(corpus_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    author: doc
                        .get_first(author_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    title: doc
                        .get_first(title_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                    century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                    genre: doc
                        .get_first(genre_field)
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    part_label: doc
                        .get_first(part_label_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    page_number: doc
                        .get_first(page_number_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    body: doc
                        .get_first(body_field)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    score,
                    matched_token_indices: matched,
                };
                results.push(result);
            }
        }

        // Sort by death_ah (author death year), earliest first. Documents without death_ah go last.
        results.sort_by(|a, b| {
            match (a.death_ah, b.death_ah) {
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        let elapsed_ms = start.elapsed().as_millis() as u64;

        let query_display = if !and_terms.is_empty() && !or_terms.is_empty() {
            format!(
                "({}) AND ({})",
                and_terms
                    .iter()
                    .map(|t| t.query.as_str())
                    .collect::<Vec<_>>()
                    .join(" AND "),
                or_terms
                    .iter()
                    .map(|t| t.query.as_str())
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        } else if !and_terms.is_empty() {
            and_terms
                .iter()
                .map(|t| t.query.as_str())
                .collect::<Vec<_>>()
                .join(" AND ")
        } else {
            or_terms
                .iter()
                .map(|t| t.query.as_str())
                .collect::<Vec<_>>()
                .join(" OR ")
        };

        let mode = and_terms
            .first()
            .or(or_terms.first())
            .map(|t| t.mode)
            .unwrap_or_default();

        Ok(SearchResults {
            query: query_display,
            mode,
            total_hits,
            results,
            elapsed_ms,
        })
    }

    pub fn proximity_search(
        &self,
        term1: &SearchTerm,
        term2: &SearchTerm,
        max_distance: usize,
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let searcher = reader.searcher();

        // Overfetch significantly to account for proximity filtering.
        // Many candidates won't pass the distance check, so we need a high cap.
        let overfetch_limit = ((limit + offset) * 20).max(5000);
        let term1_query = self.build_term_query(term1)?;
        let term2_query = self.build_term_query(term2)?;
        let text_query = BooleanQuery::new(vec![(Occur::Must, term1_query), (Occur::Must, term2_query)]);

        let final_query: Box<dyn Query> = if let Some(ref book_ids) = filters.book_ids {
            if book_ids.is_empty() {
                Box::new(text_query)
            } else {
                let id_field = self.schema.get_field("id").unwrap();
                let book_id_queries: Vec<(Occur, Box<dyn Query>)> = book_ids
                    .iter()
                    .map(|&id| {
                        let term = Term::from_field_u64(id_field, id);
                        let term_query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, term_query)
                    })
                    .collect();
                let book_ids_query = BooleanQuery::new(book_id_queries);

                let combined = BooleanQuery::new(vec![
                    (Occur::Must, Box::new(text_query)),
                    (Occur::Must, Box::new(book_ids_query)),
                ]);
                Box::new(combined)
            }
        } else {
            Box::new(text_query)
        };

        let top_docs = searcher.search(&*final_query, &TopDocs::with_limit(overfetch_limit))?;
        let field1 = self.get_search_field(term1.mode);
        let field2 = self.get_search_field(term2.mode);
        let query_terms1 = self.extract_query_terms(term1);
        let query_terms2 = self.extract_query_terms(term2);

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let author_id_field = self.schema.get_field("author_id").unwrap();
        let corpus_field = self.schema.get_field("corpus").unwrap();
        let author_field = self.schema.get_field("author").unwrap();
        let title_field = self.schema.get_field("title").unwrap();
        let death_ah_field = self.schema.get_field("death_ah").unwrap();
        let century_ah_field = self.schema.get_field("century_ah").unwrap();
        let genre_field = self.schema.get_field("genre").unwrap();
        let part_label_field = self.schema.get_field("part_label").unwrap();
        let page_number_field = self.schema.get_field("page_number").unwrap();
        let body_field = self.schema.get_field("body").unwrap();

        let mut results = Vec::new();
        let mut skipped = 0;
        let mut total_matches = 0;

        for (score, doc_address) in top_docs {
            let segment_reader = searcher.segment_reader(doc_address.segment_ord);
            let pos1 = self.get_matched_positions_limited(
                segment_reader,
                doc_address.doc_id,
                field1,
                &query_terms1,
                100,
            );
            let pos2 = self.get_matched_positions_limited(
                segment_reader,
                doc_address.doc_id,
                field2,
                &query_terms2,
                100,
            );

            let mut matched_positions: Vec<u32> = Vec::new();
            for &p1 in &pos1 {
                for &p2 in &pos2 {
                    let dist = if p1 > p2 { p1 - p2 } else { p2 - p1 } as usize;
                    if dist <= max_distance {
                        matched_positions.push(p1);
                        matched_positions.push(p2);
                    }
                }
            }

            if matched_positions.is_empty() {
                continue;
            }

            total_matches += 1;

            if skipped < offset {
                skipped += 1;
                continue;
            }

            if results.len() >= limit {
                continue;
            }

            let doc: TantivyDocument = searcher.doc(doc_address)?;
            matched_positions.sort_unstable();
            matched_positions.dedup();
            matched_positions.truncate(50);

            let result = SearchResult {
                id: doc
                    .get_first(id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                part_index: doc
                    .get_first(part_index_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                page_id: doc
                    .get_first(page_id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                corpus: doc
                    .get_first(corpus_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: doc
                    .get_first(author_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: doc
                    .get_first(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                genre: doc
                    .get_first(genre_field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                part_label: doc
                    .get_first(part_label_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                page_number: doc
                    .get_first(page_number_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: doc
                    .get_first(body_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                score,
                matched_token_indices: matched_positions,
            };

            results.push(result);
        }

        // Sort by death_ah (author death year), earliest first. Documents without death_ah go last.
        results.sort_by(|a, b| {
            match (a.death_ah, b.death_ah) {
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(SearchResults {
            query: format!("{} ~{} {}", term1.query, max_distance, term2.query),
            mode: term1.mode,
            total_hits: total_matches,
            results,
            elapsed_ms,
        })
    }

    /// Name search - search for Arabic personal names using pattern matching
    /// Each form is a list of patterns (with proclitic expansion already applied)
    /// Multiple forms use AND logic (all must match on the same page)
    pub fn name_search(
        &self,
        patterns_by_form: &[Vec<String>],
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();

        if patterns_by_form.is_empty() || patterns_by_form.iter().all(|p| p.is_empty()) {
            return Ok(SearchResults {
                query: String::new(),
                mode: SearchMode::Surface,
                total_hits: 0,
                results: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let searcher = reader.searcher();

        let surface_field = self.schema.get_field("surface_text").unwrap();

        // Build the query: each form's patterns become a Should clause,
        // multiple forms are combined with Must (AND)
        let mut form_queries: Vec<(Occur, Box<dyn Query>)> = Vec::new();

        for patterns in patterns_by_form {
            if patterns.is_empty() {
                continue;
            }

            // Build OR query for all patterns in this form
            let mut pattern_queries: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for pattern in patterns {
                let normalized = normalize_arabic(pattern);
                let words: Vec<&str> = normalized.split_whitespace().collect();

                let pattern_query: Box<dyn Query> = if words.len() > 1 {
                    // Phrase query for multi-word patterns
                    let terms: Vec<Term> = words
                        .iter()
                        .map(|word| Term::from_field_text(surface_field, word))
                        .collect();
                    Box::new(PhraseQuery::new(terms))
                } else if !words.is_empty() {
                    // Single term query
                    let term = Term::from_field_text(surface_field, words[0]);
                    Box::new(TermQuery::new(term, IndexRecordOption::WithFreqsAndPositions))
                } else {
                    continue;
                };

                pattern_queries.push((Occur::Should, pattern_query));
            }

            if !pattern_queries.is_empty() {
                let form_query = BooleanQuery::new(pattern_queries);
                form_queries.push((Occur::Must, Box::new(form_query)));
            }
        }

        if form_queries.is_empty() {
            return Ok(SearchResults {
                query: String::new(),
                mode: SearchMode::Surface,
                total_hits: 0,
                results: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let text_query: Box<dyn Query> = if form_queries.len() == 1 {
            form_queries.pop().unwrap().1
        } else {
            Box::new(BooleanQuery::new(form_queries))
        };

        // Apply book_ids filter if provided
        let final_query: Box<dyn Query> = if let Some(ref book_ids) = filters.book_ids {
            if book_ids.is_empty() {
                text_query
            } else {
                let id_field = self.schema.get_field("id").unwrap();
                let book_id_queries: Vec<(Occur, Box<dyn Query>)> = book_ids
                    .iter()
                    .map(|&id| {
                        let term = Term::from_field_u64(id_field, id);
                        let term_query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, term_query)
                    })
                    .collect();
                let book_ids_query = BooleanQuery::new(book_id_queries);
                let combined = BooleanQuery::new(vec![
                    (Occur::Must, text_query),
                    (Occur::Must, Box::new(book_ids_query)),
                ]);
                Box::new(combined)
            }
        } else {
            text_query
        };

        let (total_hits, top_docs) =
            searcher.search(&*final_query, &(Count, TopDocs::with_limit(limit + offset)))?;

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let author_id_field = self.schema.get_field("author_id").unwrap();
        let corpus_field = self.schema.get_field("corpus").unwrap();
        let author_field = self.schema.get_field("author").unwrap();
        let title_field = self.schema.get_field("title").unwrap();
        let death_ah_field = self.schema.get_field("death_ah").unwrap();
        let century_ah_field = self.schema.get_field("century_ah").unwrap();
        let genre_field = self.schema.get_field("genre").unwrap();
        let part_label_field = self.schema.get_field("part_label").unwrap();
        let page_number_field = self.schema.get_field("page_number").unwrap();
        let body_field = self.schema.get_field("body").unwrap();

        let mut results = Vec::new();
        for (score, doc_address) in top_docs.into_iter() {
            let doc: TantivyDocument = searcher.doc(doc_address)?;

            // Get token positions for highlighting (using first form's patterns)
            let matched_token_indices = if let Some(patterns) = patterns_by_form.first() {
                self.get_name_pattern_positions(
                    searcher.segment_reader(doc_address.segment_ord),
                    doc_address.doc_id,
                    surface_field,
                    patterns,
                    5,
                )
            } else {
                Vec::new()
            };

            let result = SearchResult {
                id: doc
                    .get_first(id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                part_index: doc
                    .get_first(part_index_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                page_id: doc
                    .get_first(page_id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                corpus: doc
                    .get_first(corpus_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: doc
                    .get_first(author_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: doc
                    .get_first(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                genre: doc
                    .get_first(genre_field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                part_label: doc
                    .get_first(part_label_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                page_number: doc
                    .get_first(page_number_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: doc
                    .get_first(body_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                score,
                matched_token_indices,
            };

            results.push(result);
        }

        // Sort by death_ah (author death year), earliest first
        results.sort_by(|a, b| {
            match (a.death_ah, b.death_ah) {
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        // Apply offset and limit after sorting
        let results: Vec<SearchResult> = results.into_iter().skip(offset).take(limit).collect();

        let elapsed_ms = start.elapsed().as_millis() as u64;

        // Build query display string
        let query_display = patterns_by_form
            .iter()
            .filter(|p| !p.is_empty())
            .map(|p| p.first().map(|s| s.as_str()).unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" AND ");

        Ok(SearchResults {
            query: query_display,
            mode: SearchMode::Surface,
            total_hits,
            results,
            elapsed_ms,
        })
    }

    /// Get token positions matching any of the given name patterns
    fn get_name_pattern_positions(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        patterns: &[String],
        max_positions: usize,
    ) -> Vec<u32> {
        let mut all_positions: HashSet<u32> = HashSet::new();

        for pattern in patterns {
            let normalized = normalize_arabic(pattern);
            let words: Vec<&str> = normalized.split_whitespace().collect();

            if words.len() > 1 {
                // Phrase query - get consecutive positions
                let phrase_words: Vec<String> = words.iter().map(|s| s.to_string()).collect();
                let positions = self.get_phrase_positions_limited(
                    segment_reader,
                    doc_id,
                    field,
                    &phrase_words,
                    max_positions,
                );
                all_positions.extend(positions);
            } else if !words.is_empty() {
                // Single term
                let mut query_terms = HashSet::new();
                query_terms.insert(words[0].to_string());
                let positions = self.get_matched_positions_internal(
                    segment_reader,
                    doc_id,
                    field,
                    &query_terms,
                    None,
                    max_positions,
                );
                all_positions.extend(positions);
            }

            if all_positions.len() >= max_positions {
                break;
            }
        }

        let mut result: Vec<u32> = all_positions.into_iter().collect();
        result.sort();
        result.truncate(max_positions);
        result
    }

    /// Get match positions for name patterns on a specific page
    /// Used for highlighting when viewing a result
    pub fn get_name_match_positions(
        &self,
        id: u64,
        part_index: u64,
        page_id: u64,
        patterns: &[String],
    ) -> Result<Vec<u32>> {
        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let searcher = reader.searcher();

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let surface_field = self.schema.get_field("surface_text").unwrap();

        // Build query to find the specific document
        let doc_query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(id_field, id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(part_index_field, part_index),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_u64(page_id_field, page_id),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ]);

        let top_docs = searcher.search(&doc_query, &TopDocs::with_limit(1))?;

        if let Some((_, doc_address)) = top_docs.first() {
            let segment_reader = searcher.segment_reader(doc_address.segment_ord);
            Ok(self.get_name_pattern_positions(
                segment_reader,
                doc_address.doc_id,
                surface_field,
                patterns,
                50,
            ))
        } else {
            Ok(Vec::new())
        }
    }

    /// Wildcard search - handles queries with * for prefix/internal wildcards
    ///
    /// Phase 1: Use RegexQuery for wildcard terms, TermQuery/PhraseQuery for exact terms
    /// Phase 2: Verify adjacency in results using token positions
    pub fn wildcard_search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResults> {
        let start = std::time::Instant::now();

        // Validate the query
        if let Err(e) = validate_wildcard_query(query, SearchMode::Surface) {
            return Err(anyhow::anyhow!("{}", e.message));
        }

        let normalized_query = normalize_arabic(query);
        let query_info = parse_wildcard_query(&normalized_query);

        // If no wildcard, fall back to regular search
        if !query_info.has_wildcard {
            return self.search(query, SearchMode::Surface, filters, limit, offset);
        }

        let reader = self
            .index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let searcher = reader.searcher();

        let surface_field = self.schema.get_field("surface_text").unwrap();

        // Build the query based on wildcard type and position
        let wildcard_query = self.build_wildcard_query(
            &query_info,
            surface_field,
        )?;

        // Apply book_ids filter if provided
        let final_query: Box<dyn Query> = if let Some(ref book_ids) = filters.book_ids {
            if book_ids.is_empty() {
                wildcard_query
            } else {
                let id_field = self.schema.get_field("id").unwrap();
                let book_id_queries: Vec<(Occur, Box<dyn Query>)> = book_ids
                    .iter()
                    .map(|&id| {
                        let term = Term::from_field_u64(id_field, id);
                        let term_query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, term_query)
                    })
                    .collect();
                let book_ids_query = BooleanQuery::new(book_id_queries);
                let combined = BooleanQuery::new(vec![
                    (Occur::Must, wildcard_query),
                    (Occur::Must, Box::new(book_ids_query)),
                ]);
                Box::new(combined)
            }
        } else {
            wildcard_query
        };

        // Phase 1: Execute query to get candidate documents
        // We overfetch to account for Phase 2 filtering
        let overfetch = if query_info.terms.len() > 1 { 10 } else { 1 };
        let (total_hits, top_docs) =
            searcher.search(&*final_query, &(Count, TopDocs::with_limit((limit + offset) * overfetch)))?;

        let id_field = self.schema.get_field("id").unwrap();
        let part_index_field = self.schema.get_field("part_index").unwrap();
        let page_id_field = self.schema.get_field("page_id").unwrap();
        let author_id_field = self.schema.get_field("author_id").unwrap();
        let corpus_field = self.schema.get_field("corpus").unwrap();
        let author_field = self.schema.get_field("author").unwrap();
        let title_field = self.schema.get_field("title").unwrap();
        let death_ah_field = self.schema.get_field("death_ah").unwrap();
        let century_ah_field = self.schema.get_field("century_ah").unwrap();
        let genre_field = self.schema.get_field("genre").unwrap();
        let part_label_field = self.schema.get_field("part_label").unwrap();
        let page_number_field = self.schema.get_field("page_number").unwrap();
        let body_field = self.schema.get_field("body").unwrap();

        let mut results = Vec::new();
        let mut verified_count = 0;

        for (score, doc_address) in top_docs.into_iter() {
            // Phase 2: For multi-word queries, verify adjacency
            if query_info.terms.len() > 1 {
                let segment_reader = searcher.segment_reader(doc_address.segment_ord);

                // Get positions for all terms
                let positions = self.get_wildcard_positions(
                    segment_reader,
                    doc_address.doc_id,
                    surface_field,
                    &query_info,
                    5,
                );

                // Verify adjacency - all terms must appear consecutively
                if !self.verify_adjacency(&positions, query_info.terms.len()) {
                    continue;
                }
            }

            verified_count += 1;
            if verified_count <= offset {
                continue;
            }
            if results.len() >= limit {
                continue;
            }

            let doc: TantivyDocument = searcher.doc(doc_address)?;

            // Get matched positions for highlighting
            let segment_reader = searcher.segment_reader(doc_address.segment_ord);
            let matched_token_indices = self.get_wildcard_positions(
                segment_reader,
                doc_address.doc_id,
                surface_field,
                &query_info,
                5,
            );

            let result = SearchResult {
                id: doc
                    .get_first(id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                part_index: doc
                    .get_first(part_index_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                page_id: doc
                    .get_first(page_id_field)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                author_id: doc.get_first(author_id_field).and_then(|v| v.as_u64()),
                corpus: doc
                    .get_first(corpus_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: doc
                    .get_first(author_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: doc
                    .get_first(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                death_ah: doc.get_first(death_ah_field).and_then(|v| v.as_u64()),
                century_ah: doc.get_first(century_ah_field).and_then(|v| v.as_u64()),
                genre: doc
                    .get_first(genre_field)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                part_label: doc
                    .get_first(part_label_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                page_number: doc
                    .get_first(page_number_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: doc
                    .get_first(body_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                score,
                matched_token_indices,
            };

            results.push(result);
        }

        // Sort by death_ah
        results.sort_by(|a, b| {
            match (a.death_ah, b.death_ah) {
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(SearchResults {
            query: query.to_string(),
            mode: SearchMode::Surface,
            total_hits: if query_info.terms.len() > 1 { verified_count } else { total_hits },
            results,
            elapsed_ms,
        })
    }

    /// Build a Tantivy query for wildcard search
    fn build_wildcard_query(
        &self,
        query_info: &WildcardQueryInfo,
        field: Field,
    ) -> Result<Box<dyn Query>> {
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();

        for (i, term) in query_info.terms.iter().enumerate() {
            if i == query_info.wildcard_term_index {
                // Build regex query for wildcard term
                // Escape special regex chars in the Arabic text
                let escape_for_regex = |s: &str| -> String {
                    s.chars()
                        .map(|c| match c {
                            '.' | '+' | '*' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => {
                                format!("\\{}", c)
                            }
                            _ => c.to_string(),
                        })
                        .collect()
                };

                let regex_pattern = match query_info.wildcard_type {
                    WildcardType::Prefix => {
                        // أب* -> matches anything starting with أب
                        format!("{}.*", escape_for_regex(&query_info.prefix))
                    }
                    WildcardType::Internal => {
                        // أح*مد -> matches أح followed by anything followed by مد
                        let suffix = query_info.suffix.as_deref().unwrap_or("");
                        format!("{}.*{}", escape_for_regex(&query_info.prefix), escape_for_regex(suffix))
                    }
                    WildcardType::None => {
                        // Should not happen
                        escape_for_regex(term)
                    }
                };

                let regex_query = RegexQuery::from_pattern(&regex_pattern, field)?;
                clauses.push((Occur::Must, Box::new(regex_query)));
            } else {
                // Exact term query
                let tantivy_term = Term::from_field_text(field, term);
                let term_query = TermQuery::new(tantivy_term, IndexRecordOption::WithFreqsAndPositions);
                clauses.push((Occur::Must, Box::new(term_query)));
            }
        }

        if clauses.len() == 1 {
            Ok(clauses.pop().unwrap().1)
        } else {
            Ok(Box::new(BooleanQuery::new(clauses)))
        }
    }

    /// Get positions for wildcard query terms in a document
    fn get_wildcard_positions(
        &self,
        segment_reader: &SegmentReader,
        doc_id: u32,
        field: Field,
        query_info: &WildcardQueryInfo,
        max_positions: usize,
    ) -> Vec<u32> {
        let mut all_positions: Vec<u32> = Vec::new();

        let Ok(inverted_index) = segment_reader.inverted_index(field) else {
            return all_positions;
        };

        // For non-wildcard terms, get exact positions
        for (i, term_str) in query_info.terms.iter().enumerate() {
            if i == query_info.wildcard_term_index {
                continue; // Handle wildcard term separately below
            }

            let term = Term::from_field_text(field, term_str);
            let Ok(Some(mut postings)) = inverted_index.read_postings(&term, IndexRecordOption::WithFreqsAndPositions) else {
                continue;
            };

            let current_doc = postings.doc();
            if current_doc == tantivy::TERMINATED || current_doc > doc_id {
                continue;
            }

            if current_doc == doc_id {
                let mut pos_buffer: Vec<u32> = Vec::new();
                postings.positions(&mut pos_buffer);
                all_positions.extend(pos_buffer);
            } else if postings.seek(doc_id) == doc_id {
                let mut pos_buffer: Vec<u32> = Vec::new();
                postings.positions(&mut pos_buffer);
                all_positions.extend(pos_buffer);
            }
        }

        // For wildcard term, scan the term dictionary to find matching terms
        if query_info.has_wildcard {
            let prefix = &query_info.prefix;
            let suffix = query_info.suffix.as_deref();

            // Get the term dictionary and iterate through terms starting with prefix
            let term_dict = inverted_index.terms();
            let prefix_bytes = prefix.as_bytes();

            // Create a range starting from the prefix
            let mut term_stream = term_dict.range().ge(prefix_bytes).into_stream().unwrap();

            while term_stream.advance() {
                let term_bytes = term_stream.key();

                // Check if term still starts with our prefix
                if !term_bytes.starts_with(prefix_bytes) {
                    break; // Past our prefix range
                }

                // Convert to string for suffix check
                let Ok(term_str) = std::str::from_utf8(term_bytes) else {
                    continue;
                };

                // For internal wildcards (أح*مد), check suffix
                let matches = match suffix {
                    Some(suf) => term_str.ends_with(suf),
                    None => true, // Prefix-only wildcard matches anything starting with prefix
                };

                if !matches {
                    continue;
                }

                // This term matches our wildcard pattern - get its positions
                let term = Term::from_field_text(field, term_str);
                let Ok(Some(mut postings)) = inverted_index.read_postings(&term, IndexRecordOption::WithFreqsAndPositions) else {
                    continue;
                };

                let current_doc = postings.doc();
                if current_doc == tantivy::TERMINATED || current_doc > doc_id {
                    continue;
                }

                if current_doc == doc_id {
                    let mut pos_buffer: Vec<u32> = Vec::new();
                    postings.positions(&mut pos_buffer);
                    all_positions.extend(pos_buffer);
                } else if postings.seek(doc_id) == doc_id {
                    let mut pos_buffer: Vec<u32> = Vec::new();
                    postings.positions(&mut pos_buffer);
                    all_positions.extend(pos_buffer);
                }

                // Limit scanning to avoid performance issues
                if all_positions.len() >= max_positions * 10 {
                    break;
                }
            }
        }

        all_positions.sort_unstable();
        all_positions.dedup();
        all_positions.truncate(max_positions);
        all_positions
    }

    /// Verify that positions form a consecutive sequence (for phrase-like queries)
    fn verify_adjacency(&self, positions: &[u32], num_terms: usize) -> bool {
        if positions.is_empty() || num_terms <= 1 {
            return true;
        }

        // For multi-word wildcard queries, check if we have consecutive positions
        // This is a simplified check - positions should include indices like N, N+1, N+2...
        for window in positions.windows(num_terms) {
            let mut is_consecutive = true;
            for i in 1..window.len() {
                if window[i] != window[i - 1] + 1 {
                    is_consecutive = false;
                    break;
                }
            }
            if is_consecutive {
                return true;
            }
        }

        false
    }
}
