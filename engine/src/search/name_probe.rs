//! Instrumentation for the name search: where its time goes, and what the
//! same query costs retrieved other ways. Diagnostic only; nothing in the
//! app calls this. Every variant returns the pages and highlight positions
//! it would serve, so an example can hold them to the search's own.
//!
//! Variants:
//!   - `probe_tantivy`: the search as it is — one `RegexPhraseQuery` per
//!     pattern, OR-ed, run once through the reading-order collector — for
//!     any list of per-pattern slot sets (so also (a) one query per
//!     displayed pattern with its first slot merged, (b) the glob `اب*` as
//!     the first slot, (c) the minimal patterns);
//!   - `probe_positional`: (d) the engine's own positional phrase
//!     intersection, which drives from the rarest slot, for the same lists;
//!   - `probe_per_pattern`: each pattern alone, timed.

use super::*;
use std::collections::BTreeSet;
use std::time::Instant;

#[derive(Debug, Default, Clone)]
pub struct ProbeTiming {
    pub plan_us: u64,
    /// `Query::weight` on the whole OR: the regex automata against the term
    /// dictionaries, and the per-slot posting unions (bitsets) they build.
    pub weight_us: u64,
    /// `Weight::scorer` per segment.
    pub scorer_us: u64,
    /// Advancing the scorer to the end.
    pub iterate_us: u64,
    /// The search as served: reading-order collector, from a fresh weight.
    pub collect_us: u64,
    /// Verifying candidates on the forward index (glob variant only).
    pub verify_us: u64,
    pub results_us: u64,
    pub highlight_us: u64,
    pub total_us: u64,
}

#[derive(Debug, Clone)]
pub struct ProbeOut {
    pub label: String,
    /// Phrase queries (or positional intersections) run.
    pub queries: usize,
    /// How many of them needed forward-index verification (bag-of-words plans).
    pub verify_plans: usize,
    pub candidates: usize,
    pub total_hits: usize,
    pub pages: Vec<(u64, u64, u64)>,
    pub highlights: Vec<Vec<u32>>,
    pub timing: ProbeTiming,
    pub note: String,
}

/// Normalised words of a pattern.
fn words(p: &str) -> Vec<String> {
    normalize_arabic(p.trim()).split_whitespace().map(|s| s.to_string()).collect()
}

impl SearchEngine {
    /// The expanded list, as the search sees it.
    pub fn probe_expand(&self, display: &[String]) -> Vec<String> {
        crate::names::expand_patterns(display)
    }

    /// (c) Drop every pattern that contains another of the list as a
    /// contiguous run of words: a page that has it has the shorter one, so
    /// the shorter alone retrieves the same pages.
    pub fn probe_minimal(patterns: &[String]) -> Vec<String> {
        crate::names::minimal_patterns(patterns)
    }

    /// What `name_search` now retrieves on: (a+c) in one.
    pub fn probe_retrieval_sets(&self, patterns: &[String]) -> Vec<Sets> {
        self.name_retrieval_sets(patterns)
    }

    /// The slot sets of any term, in its mode.
    pub fn probe_term_sets(&self, term: &SearchTerm) -> Sets {
        self.term_sets(term)
    }

    /// Per slot, the summed document frequency of its triple ids: the
    /// postings a phrase scorer over these slots reads in full.
    pub fn probe_slot_doc_freqs(&self, sets: &[Vec<u32>]) -> Vec<u64> {
        let searcher = self.reader.searcher();
        let tokens = self.fields.tokens.expect("compound index");
        let mut out = vec![0u64; sets.len()];
        for seg in searcher.segment_readers() {
            let Ok(inv) = seg.inverted_index(tokens) else { continue };
            for (k, ids) in sets.iter().enumerate() {
                for &t in ids {
                    out[k] += inv.doc_freq(&Term::from_field_text(tokens, &triple_term(t))).unwrap_or(0) as u64;
                }
            }
        }
        out
    }

    /// The slot sets of each pattern, one list per pattern.
    pub fn probe_sets(&self, patterns: &[String]) -> Vec<Sets> {
        patterns.iter().map(|p| self.term_sets(&SearchTerm { query: p.clone(), mode: SearchMode::Surface })).collect()
    }

    /// (a) One list per displayed pattern: the expansions of a displayed
    /// pattern differ only in their first word, so their first slots are
    /// merged into one alternation and the rest kept.
    pub fn probe_merged_first_slot(&self, expanded: &[String]) -> Vec<Sets> {
        let mut groups: Vec<(Vec<String>, Sets)> = Vec::new();
        for p in expanded {
            let w = words(p);
            if w.is_empty() {
                continue;
            }
            let sets = self.term_sets(&SearchTerm { query: p.clone(), mode: SearchMode::Surface });
            let tail: Vec<String> = w[1..].to_vec();
            if let Some((_, g)) = groups.iter_mut().find(|(t, g)| *t == tail && g.len() == sets.len()) {
                g[0].extend(sets[0].iter().copied());
                g[0].sort_unstable();
                g[0].dedup();
            } else {
                groups.push((tail, sets));
            }
        }
        groups.into_iter().map(|(_, s)| s).collect()
    }

    /// (b) As (a), but a kunya pattern's first slot is the glob `اب*` with
    /// each proclitic in front — every triple whose surface begins so — in
    /// place of the eighteen exact forms.
    pub fn probe_glob_first_slot(&self, expanded: &[String]) -> (Vec<Sets>, usize) {
        let t = self.triples();
        let mut glob_slot: Vec<u32> = Vec::new();
        for prefix in std::iter::once("").chain(crate::names::PROCLITICS.iter().copied()) {
            glob_slot.extend(t.triples_for_glob(&GlobPattern::parse(&format!("{prefix}اب*"))));
        }
        glob_slot.sort_unstable();
        glob_slot.dedup();
        let width = glob_slot.len();
        let kunya_forms: Vec<String> = crate::names::KUNYA_FORMS.iter().map(|k| normalize_arabic(k)).collect();
        let mut out = self.probe_merged_first_slot(expanded);
        // Which groups are kunya groups: their first slot is made of the kunya forms.
        let kunya_first: Vec<u32> = {
            let mut v: Vec<u32> = Vec::new();
            for prefix in std::iter::once("").chain(crate::names::PROCLITICS.iter().copied()) {
                for k in &kunya_forms {
                    v.extend(t.triples_for_surface(&format!("{prefix}{k}")));
                }
            }
            v.sort_unstable();
            v.dedup();
            v
        };
        for sets in out.iter_mut() {
            if sets.len() > 1 && sets[0] == kunya_first {
                sets[0] = glob_slot.clone();
            }
        }
        (out, width)
    }

    /// Each pattern alone: its plan, whether it needs verification, and the
    /// time to count its pages.
    pub fn probe_per_pattern(&self, patterns: &[String]) -> Result<Vec<(String, bool, usize, u64)>> {
        let searcher = self.reader.searcher();
        let mut out = Vec::with_capacity(patterns.len());
        for p in patterns {
            let term = SearchTerm { query: p.clone(), mode: SearchMode::Surface };
            let plan = self.build_term_plan(&term)?;
            let t = Instant::now();
            let n = searcher.search(&*plan.query, &Count)?;
            out.push((p.clone(), plan.verify.is_some(), n, t.elapsed().as_micros() as u64));
        }
        Ok(out)
    }

    /// The search as it is, for a list of per-pattern slot sets: one phrase
    /// query each, OR-ed, run once. When `verify_with` is given (the glob
    /// variant, whose slot is a superset), every page the OR returns is
    /// verified on the forward index against those exact patterns.
    pub fn probe_tantivy(&self, label: &str, per_pattern: &[Sets], highlight: &[String], verify_with: Option<&[String]>, limit: usize) -> Result<ProbeOut> {
        let searcher = self.reader.searcher();
        let mut timing = ProbeTiming::default();
        let t_all = Instant::now();

        let t = Instant::now();
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        let mut verify_plans = 0;
        for sets in per_pattern {
            let plan = self.compound_plan(sets)?;
            verify_plans += usize::from(plan.verify.is_some());
            clauses.push((Occur::Should, plan.query));
        }
        let query: Box<dyn Query> = Box::new(BooleanQuery::new(clauses));
        timing.plan_us = t.elapsed().as_micros() as u64;

        // The breakdown: weight, scorers, iteration — the same work the
        // collector does, split.
        let t = Instant::now();
        let weight = query.weight(EnableScoring::disabled_from_searcher(&searcher))?;
        timing.weight_us = t.elapsed().as_micros() as u64;
        let mut iterated = 0usize;
        for seg in searcher.segment_readers() {
            let t = Instant::now();
            let mut scorer = weight.scorer(seg, 1.0)?;
            timing.scorer_us += t.elapsed().as_micros() as u64;
            let t = Instant::now();
            while scorer.doc() != TERMINATED {
                iterated += 1;
                scorer.advance();
            }
            timing.iterate_us += t.elapsed().as_micros() as u64;
        }

        // As served.
        let t = Instant::now();
        let (total, addrs) = if verify_with.is_some() {
            searcher.search(&*query, &ReadingOrderCollector { offset: 0, limit: usize::MAX / 2 })?
        } else {
            searcher.search(&*query, &ReadingOrderCollector { offset: 0, limit })?
        };
        timing.collect_us = t.elapsed().as_micros() as u64;
        let candidates = total;

        let (total, addrs) = match verify_with {
            None => (total, addrs),
            Some(exact) => {
                let t = Instant::now();
                let keys = self.keys_of(&searcher, &addrs);
                let pages = self.page_triples(&keys)?;
                let sets: Vec<Vec<HashSet<u32>>> = self.probe_sets(exact).iter().map(|s| Self::hash_sets(s)).collect();
                let kept: Vec<DocAddress> = addrs
                    .iter()
                    .zip(keys.iter())
                    .filter(|(_, k)| pages.get(k).map_or(false, |ids| sets.iter().any(|s| !forward::phrase_starts(ids, s).is_empty())))
                    .map(|(a, _)| *a)
                    .collect();
                timing.verify_us = t.elapsed().as_micros() as u64;
                let n = kept.len();
                (n, kept.into_iter().take(limit).collect())
            }
        };

        let t = Instant::now();
        let results = self.results_from(&searcher, &addrs)?;
        timing.results_us = t.elapsed().as_micros() as u64;
        let t = Instant::now();
        let keys = self.keys_of(&searcher, &addrs);
        let hl_sets: Vec<Sets> = self.probe_sets(highlight);
        let map = self.forward_highlights(&keys, &hl_sets, self.config.result_highlight_cap.max(50))?;
        timing.highlight_us = t.elapsed().as_micros() as u64;
        timing.total_us = t_all.elapsed().as_micros() as u64;

        Ok(ProbeOut {
            label: label.to_string(),
            queries: per_pattern.len(),
            verify_plans,
            candidates,
            total_hits: total,
            pages: results.iter().map(|r| (r.id, r.part_index, r.page_id)).collect(),
            highlights: keys.iter().map(|k| map.get(k).cloned().unwrap_or_default()).collect(),
            timing,
            note: format!("iterated {iterated} docs; reading_order={}", self.reading_order),
        })
    }

    /// (d) The engine's positional phrase intersection — the rarest slot
    /// drives, the others are probed by skip — once per list of slot sets,
    /// the hits unioned and put in reading order.
    pub fn probe_positional(&self, label: &str, per_pattern: &[Sets], highlight: &[String], limit: usize) -> Result<ProbeOut> {
        struct Collect<'a> {
            hits: &'a mut BTreeSet<(u32, u32)>,
        }
        impl StreamSink for Collect<'_> {
            fn want_positions(&mut self, _hits_so_far: usize) -> bool {
                false
            }
            fn on_hit(&mut self, hit: PositionalHit) -> bool {
                self.hits.insert((hit.addr.segment_ord, hit.addr.doc_id));
                true
            }
            fn tick(&mut self) -> bool {
                true
            }
        }
        let searcher = self.reader.searcher();
        let tokens = self.fields.tokens.expect("compound index");
        let mut timing = ProbeTiming::default();
        let t_all = Instant::now();
        let mut hits: BTreeSet<(u32, u32)> = BTreeSet::new();
        let mut co = 0usize;
        let mut notes: Vec<String> = Vec::new();
        for sets in per_pattern {
            let matcher = crate::positional::phrase_matcher();
            let mut sink = Collect { hits: &mut hits };
            let ps = crate::positional::intersect_n_stream(&searcher, tokens, sets, &triple_term, &matcher, None, &mut sink)?;
            timing.weight_us += ps.open_us;
            timing.iterate_us += ps.intersect_us + ps.positions_us;
            co += ps.co_occurring;
            if notes.len() < 3 {
                notes.push(format!("slots={:?} doc_freqs={:?} co={} hits={}", ps.cursors, ps.doc_freqs, ps.co_occurring, ps.hits));
            }
        }
        timing.collect_us = t_all.elapsed().as_micros() as u64;
        let t = Instant::now();
        let all: Vec<DocAddress> = hits.iter().map(|&(s, d)| DocAddress::new(s, d)).collect();
        let mut keyed: Vec<(OrderKey, DocAddress)> = self.order_keys(&searcher, &all).into_iter().zip(all.iter().copied()).collect();
        keyed.sort_by_key(|(k, _)| *k);
        let total = keyed.len();
        let addrs: Vec<DocAddress> = keyed.into_iter().take(limit).map(|(_, a)| a).collect();
        timing.scorer_us = t.elapsed().as_micros() as u64; // ordering, here
        let t = Instant::now();
        let results = self.results_from(&searcher, &addrs)?;
        timing.results_us = t.elapsed().as_micros() as u64;
        let t = Instant::now();
        let keys = self.keys_of(&searcher, &addrs);
        let hl_sets: Vec<Sets> = self.probe_sets(highlight);
        let map = self.forward_highlights(&keys, &hl_sets, self.config.result_highlight_cap.max(50))?;
        timing.highlight_us = t.elapsed().as_micros() as u64;
        timing.total_us = t_all.elapsed().as_micros() as u64;
        Ok(ProbeOut {
            label: label.to_string(),
            queries: per_pattern.len(),
            verify_plans: 0,
            candidates: co,
            total_hits: total,
            pages: results.iter().map(|r| (r.id, r.part_index, r.page_id)).collect(),
            highlights: keys.iter().map(|k| map.get(k).cloned().unwrap_or_default()).collect(),
            timing,
            note: notes.join(" | "),
        })
    }
}
