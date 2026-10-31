//! A wildcard word in a Boolean or proximity term expands inside its slot.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR`. Before this, `combined_search` looked a
//! word with `*` up as a literal surface, so `كتاب* AND علم` was empty and
//! `كتاب* OR علم` was `علم` alone; only the wildcard route expanded globs.

use kashshaf_engine::{EngineConfig, ProximityQuery, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

fn open() -> Option<SearchEngine> {
    let dir = PathBuf::from(std::env::var_os("KASHSHAF_SAMPLE_DIR")?);
    let db = dir.join("corpus.db");
    let index = dir.join("tantivy_index_compound_root");
    let mut engine = SearchEngine::open_with_corpus(&index, Some(&db), EngineConfig::default()).expect("open sample engine");
    engine.set_token_cache(Arc::new(TokenCache::new(db, 100_000).expect("token cache")));
    Some(engine)
}

fn term(q: &str) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode: SearchMode::Surface, clitics: false }
}

type Pages = BTreeSet<(u64, u64, u64)>;

fn pages(engine: &SearchEngine, and_terms: &[SearchTerm], or_terms: &[SearchTerm]) -> Pages {
    let mut out = BTreeSet::new();
    let (limit, mut offset) = (250, 0);
    loop {
        let r = engine.combined_search(and_terms, or_terms, &SearchFilters::default(), limit, offset).expect("search");
        for h in &r.results {
            out.insert((h.id, h.part_index, h.page_id));
        }
        if r.results.len() < limit {
            return out;
        }
        offset += limit;
    }
}

fn wildcard_pages(engine: &SearchEngine, q: &str) -> Pages {
    let mut out = BTreeSet::new();
    let (limit, mut offset) = (250, 0);
    loop {
        let r = engine.wildcard_search(q, &SearchFilters::default(), limit, offset).expect("wildcard search");
        for h in &r.results {
            out.insert((h.id, h.part_index, h.page_id));
        }
        if r.results.len() < limit {
            return out;
        }
        offset += limit;
    }
}

#[test]
fn a_glob_in_a_boolean_term_is_the_wildcard_route_s_expansion() {
    let Some(engine) = open() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set; skipping");
        return;
    };
    let (glob, word) = ("كتاب*", "علم");

    let wild = wildcard_pages(&engine, glob);
    assert!(!wild.is_empty(), "the sample has pages matching {glob}");
    assert_eq!(pages(&engine, &[term(glob)], &[]), wild, "one AND glob = the wildcard route");

    let b = pages(&engine, &[term(word)], &[]);
    let and = pages(&engine, &[term(glob), term(word)], &[]);
    let or = pages(&engine, &[], &[term(glob), term(word)]);
    assert_eq!(and, wild.intersection(&b).cloned().collect::<Pages>(), "AND = intersection");
    assert_eq!(or, wild.union(&b).cloned().collect::<Pages>(), "OR = union");
    assert!(!and.is_empty() && and.len() < wild.len(), "the AND narrows the glob");
    eprintln!("{glob}: {} | {word}: {} | AND {} | OR {}", wild.len(), b.len(), and.len(), or.len());

    // Highlights mark the glob's words too.
    let r = engine.combined_search(&[term(glob), term(word)], &[], &SearchFilters::default(), 5, 0).unwrap();
    assert!(r.results.iter().all(|h| h.matched_token_indices.len() >= 2), "both terms highlighted on every page");
}

#[test]
fn a_glob_in_a_proximity_term_finds_pages_a_literal_cannot() {
    let Some(engine) = open() else {
        return;
    };
    let q = ProximityQuery { terms: vec![term("كتاب*"), term("علم")], distances: vec![10], ordered: false, and_terms: Vec::new() };
    let r = engine.proximity_chain_search(&q, &SearchFilters::default(), 50, 0).expect("proximity");
    assert!(r.total_hits > 0, "a glob proximity term matches");
    let literal = ProximityQuery { terms: vec![term("كتاب"), term("علم")], distances: vec![10], ordered: false, and_terms: Vec::new() };
    let l = engine.proximity_chain_search(&literal, &SearchFilters::default(), 50, 0).expect("proximity");
    assert!(r.total_hits >= l.total_hits, "the glob is at least as wide as its literal");
}

#[test]
fn a_wildcard_the_grammar_refuses_is_an_error_not_a_corpus_wide_slot() {
    let Some(engine) = open() else {
        return;
    };
    assert!(engine.combined_search(&[term("ك*"), term("علم")], &[], &SearchFilters::default(), 10, 0).is_err());
    assert!(engine.combined_search(&[term("*")], &[], &SearchFilters::default(), 10, 0).is_err());
    let q = ProximityQuery { terms: vec![term("*"), term("علم")], distances: vec![10], ordered: false, and_terms: Vec::new() };
    assert!(engine.proximity_chain_search(&q, &SearchFilters::default(), 10, 0).is_err());
}
