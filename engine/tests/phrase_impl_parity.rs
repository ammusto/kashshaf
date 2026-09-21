//! The positional phrase walk (audit finding 1) answers exactly as Tantivy's
//! phrase query did: the same pages in the same order, the same highlight
//! positions, the same count — for a surface phrase, a lemma phrase, a
//! boolean with phrase clauses (AND, OR, mixed with a word) and a name form.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`; without it every test passes vacuously.

use kashshaf_engine::{expand_name_patterns, EngineConfig, PhraseImpl, SearchEngine, SearchFilters, SearchMode, SearchResults, SearchTerm, TokenCache};
use std::path::PathBuf;
use std::sync::Arc;

fn open() -> Option<SearchEngine> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    let db = dir.join("corpus.db");
    let mut engine = SearchEngine::open_with_corpus(&dir.join("tantivy_index_compound_root"), Some(&db), EngineConfig { exact_counts: true, ..EngineConfig::default() }).ok()?;
    engine.set_token_cache(Arc::new(TokenCache::new(db, 100_000).ok()?));
    Some(engine)
}

fn t(q: &str, mode: SearchMode) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode }
}

fn shape(r: &SearchResults) -> (usize, Vec<(u64, u64, u64, bool, Vec<u32>)>) {
    (r.total_hits, r.results.iter().map(|x| (x.id, x.part_index, x.page_id, x.crosses_page, x.matched_token_indices.clone())).collect())
}

/// Run `f` on both implementations and hold them to each other.
fn both(engine: &SearchEngine, label: &str, f: &dyn Fn() -> SearchResults) {
    engine.set_phrase_impl(PhraseImpl::Tantivy);
    engine.clear_walk_cache();
    let tantivy = f();
    engine.set_phrase_impl(PhraseImpl::Positional);
    engine.clear_walk_cache();
    let positional = f();
    assert!(tantivy.total_hits > 0, "{label}: the sample has hits");
    assert_eq!(positional.was_capped, None, "{label}: the walk ran to its end");
    assert_eq!(shape(&positional), shape(&tantivy), "{label}");
}

#[test]
fn a_surface_phrase_answers_as_before() {
    let Some(engine) = open() else { return };
    let filters = SearchFilters::default();
    for q in ["قال رسول", "رسول الله صلى", "عبد الله بن"] {
        both(&engine, q, &|| engine.search(q, SearchMode::Surface, &filters, 100_000, 0).unwrap());
        // A window into the middle, too.
        both(&engine, &format!("{q} @50"), &|| engine.search(q, SearchMode::Surface, &filters, 25, 50).unwrap());
    }
}

#[test]
fn a_lemma_phrase_under_the_regex_budget_answers_as_before() {
    let Some(engine) = open() else { return };
    let filters = SearchFilters::default();
    both(&engine, "lemma عبد الله", &|| engine.search("عبد الله", SearchMode::Lemma, &filters, 100_000, 0).unwrap());
}

#[test]
fn booleans_with_phrase_clauses_answer_as_before() {
    let Some(engine) = open() else { return };
    let filters = SearchFilters::default();
    let cases: Vec<(&str, Vec<SearchTerm>, Vec<SearchTerm>)> = vec![
        ("AND two phrases", vec![t("قال رسول", SearchMode::Surface), t("عبد الله", SearchMode::Surface)], vec![]),
        ("AND phrase + word", vec![t("رسول الله", SearchMode::Surface), t("قال", SearchMode::Surface)], vec![]),
        ("OR two phrases", vec![], vec![t("قال رسول", SearchMode::Surface), t("عبد الله", SearchMode::Surface)]),
        ("AND word, OR phrases", vec![t("قال", SearchMode::Surface)], vec![t("رسول الله", SearchMode::Surface), t("عبد الله", SearchMode::Surface)]),
    ];
    for (label, and, or) in cases {
        both(&engine, label, &|| engine.combined_search(&and, &or, &filters, 100_000, 0).unwrap());
    }
}

#[test]
fn a_name_form_answers_as_before() {
    let Some(engine) = open() else { return };
    let filters = SearchFilters::default();
    let display: Vec<String> = ["اب* عبد الله", "عبد الله بن", "عبد الله بن محمد", "اب* عبد", "قال رسول الله"].iter().map(|x| x.to_string()).collect();
    let expanded = expand_name_patterns(&display);
    both(&engine, "name form", &|| engine.name_search(&[expanded.clone()], &filters, 100_000, 0).unwrap());
}

/// A lemma phrase with a word the lemmatiser never produced (a name) used
/// to be empty. The word's surface triples stand in for the missing lemma
/// slot, so the phrase finds what its surface form finds on that word.
#[test]
fn a_lemma_slot_with_no_triples_falls_back_to_the_surface_form() {
    let Some(engine) = open() else { return };
    let filters = SearchFilters::default();
    // The sample has these as surfaces; بن and احمد are names, never lemmas.
    let lemma = engine.search("عبد الله بن احمد", SearchMode::Lemma, &filters, 100_000, 0).unwrap();
    let surface = engine.search("عبد الله بن احمد", SearchMode::Surface, &filters, 100_000, 0).unwrap();
    assert!(surface.total_hits > 0, "the sample has the surface phrase");
    // Every surface hit is a lemma hit (the lemma slots are supersets of the surface ones).
    let lemma_pages: std::collections::HashSet<_> = lemma.results.iter().map(|r| (r.id, r.part_index, r.page_id)).collect();
    for r in &surface.results {
        assert!(lemma_pages.contains(&(r.id, r.part_index, r.page_id)), "surface hit {}:{}:{} is a lemma hit", r.id, r.part_index, r.page_id);
    }
    assert!(lemma.total_hits >= surface.total_hits);
}
