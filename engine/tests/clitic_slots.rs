//! "Ignore clitics" on a Boolean term expands inside that term's slot.
//!
//! Gated on `KASHSHAF_SAMPLE_DIR` (a directory with `corpus.db` and
//! `tantivy_index_compound_root`). Two surface AND terms, both with the
//! flag, must give exactly the pages that have some form of the first word
//! and some form of the second: the intersection of the two OR searches
//! over the six forms, not their union (which is what the clients sent
//! before 0.8.4, ~30,000 pages where the pair shares 13).

use kashshaf_engine::{EngineConfig, SearchEngine, SearchFilters, SearchMode, SearchTerm, TokenCache};
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

fn term(q: &str, clitics: bool) -> SearchTerm {
    SearchTerm { query: q.to_string(), mode: SearchMode::Surface, clitics }
}

/// Every page a Boolean search yields, as (book, part, page).
fn pages(engine: &SearchEngine, and_terms: &[SearchTerm], or_terms: &[SearchTerm]) -> BTreeSet<(u64, u64, u64)> {
    let mut out = BTreeSet::new();
    let limit = 250;
    let mut offset = 0;
    loop {
        let r = engine.combined_search(and_terms, or_terms, &SearchFilters::default(), limit, offset).expect("search");
        assert_ne!(r.was_capped, Some(true), "the sample words must stay under the walk cap");
        for h in &r.results {
            out.insert((h.id, h.part_index, h.page_id));
        }
        if r.results.len() < limit {
            return out;
        }
        offset += limit;
    }
}

fn forms(word: &str) -> Vec<SearchTerm> {
    SearchEngine::proclitic_forms(word).into_iter().map(|f| term(&f, false)).collect()
}

#[test]
fn two_toggled_and_terms_are_an_intersection_of_their_forms() {
    let Some(engine) = open() else {
        eprintln!("KASHSHAF_SAMPLE_DIR not set; skipping");
        return;
    };
    let (a, b) = ("كتاب", "علم");

    let none = pages(&engine, &[term(a, false), term(b, false)], &[]);
    let a_only = pages(&engine, &[term(a, true), term(b, false)], &[]);
    let both = pages(&engine, &[term(a, true), term(b, true)], &[]);
    let any_a = pages(&engine, &[], &forms(a));
    let any_b = pages(&engine, &[], &forms(b));
    let b_exact = pages(&engine, &[term(b, false)], &[]);
    let old_bug: BTreeSet<_> = any_a.union(&any_b).cloned().collect();

    assert!(!none.is_empty(), "the sample has pages with both {a} and {b}");
    assert_eq!(both, any_a.intersection(&any_b).cloned().collect::<BTreeSet<_>>(), "both toggled = some form of each");
    assert_eq!(a_only, any_a.intersection(&b_exact).cloned().collect::<BTreeSet<_>>(), "one toggled = its forms AND the bare other");
    assert!(none.is_subset(&a_only) && a_only.is_subset(&both), "a toggle only widens");
    assert!(both.len() < old_bug.len(), "an intersection, not the union the clients used to send");
    eprintln!("{a} AND {b}: none {} | a toggled {} | both {} | union of all forms {}", none.len(), a_only.len(), both.len(), old_bug.len());
}

#[test]
fn a_toggled_phrase_expands_its_first_word_only() {
    let Some(engine) = open() else {
        return;
    };
    let phrase = pages(&engine, &[term("قال الله", true)], &[]);
    let expected = pages(&engine, &[], &forms("قال").iter().map(|t| term(&format!("{} الله", t.query), false)).collect::<Vec<_>>());
    assert_eq!(phrase, expected);
    assert!(!phrase.is_empty());
}
