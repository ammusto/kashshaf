//! Which of these names are the same person? (Phase 10 A.)
//!
//! One person is written a dozen ways across a book: `أحمد بن علي`,
//! `أحمد بن علي بن جعفر`, `أبو بكر أحمد بن علي الخطيب`. The isnād workbench
//! links a transmitter row at a time; this ranks whole *forms* against one
//! another so the decision is made once.
//!
//! Two signals, and they are not equal:
//!
//! 1. **The names look alike.** Not character overlap, which rates
//!    `أحمد بن علي` against `أحمد بن عمر` almost as highly as against
//!    `أحمد بن علي بن جعفر`, but the parts `names::parse` finds — ism,
//!    nasab chain, nisba, kunya — with a token measure under it and edit
//!    distance under that.
//! 2. **The names keep the same company.** How often the two forms sit next
//!    to the same transmitter in a chain: the one they received from, and
//!    the one they gave to. Two names that transmit from the same teacher to
//!    the same student are one man far more reliably than two names that
//!    merely spell alike, so this carries the greater weight.
//!
//! Everything here is pure: the commands read the rows, this ranks them.

use crate::analysis::names::{self, NameParts};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// One transmitter row of the open book.
#[derive(Debug, Clone)]
pub struct Link {
    pub transmitter_id: i64,
    pub isnad_id: i64,
    /// 0 = nearest the author.
    pub position: usize,
    pub person_id: Option<i64>,
    pub form_norm: String,
    pub raw: String,
    pub part_index: u32,
    pub page_id: u64,
}

/// A distinct name form in the book, with what is known about it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormRow {
    pub form_norm: String,
    /// The commonest spelling, which is what a reader recognises.
    pub raw: String,
    pub count: usize,
    pub person_id: Option<i64>,
    pub person_name: Option<String>,
    /// One occurrence, so the list can open the text at it.
    pub part_index: u32,
    pub page_id: u64,
}

/// One place a form occurs, with the company it keeps there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Occurrence {
    /// Enough to open the isnād it sits in.
    pub isnad_id: i64,
    pub transmitter_id: i64,
    pub part_index: u32,
    pub page_id: u64,
    /// Whom this transmitter received from (the next position up the chain).
    pub from: Option<String>,
    /// Whom they gave it to (the next position down, towards the author).
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub form_norm: String,
    pub raw: String,
    pub count: usize,
    pub person_id: Option<i64>,
    pub person_name: Option<String>,
    /// The two components, and what they come to together.
    pub score: f64,
    pub string_score: f64,
    pub neighbour_score: f64,
    /// Chains where both forms received from the same transmitter.
    pub shared_from: usize,
    /// Chains where both gave to the same transmitter.
    pub shared_to: usize,
    pub occurrences: Vec<Occurrence>,
    pub part_index: u32,
    pub page_id: u64,
}

/// How much a shared neighbour is worth, and how fast the worth saturates.
const NEIGHBOUR_RATE: f64 = 0.7;
/// The company kept outweighs the spelling.
const NEIGHBOUR_WEIGHT: f64 = 0.6;
const STRING_WEIGHT: f64 = 0.4;
/// Below this a candidate is noise.
pub const FLOOR: f64 = 0.12;
pub const MAX_CANDIDATES: usize = 40;
/// Occurrences listed in full before they are summarised.
pub const MAX_OCCURRENCES: usize = 8;

/// Every distinct form in the book, commonest first.
pub fn forms(links: &[Link], person_names: &HashMap<i64, String>) -> Vec<FormRow> {
    let mut by_form: HashMap<&str, Vec<&Link>> = HashMap::new();
    for l in links {
        by_form.entry(l.form_norm.as_str()).or_default().push(l);
    }
    let mut out: Vec<FormRow> = by_form
        .into_iter()
        .map(|(form, rows)| {
            let person_id = rows.iter().find_map(|r| r.person_id);
            FormRow {
                form_norm: form.to_string(),
                raw: commonest_raw(&rows),
                count: rows.len(),
                person_id,
                person_name: person_id.and_then(|p| person_names.get(&p).cloned()),
                part_index: rows[0].part_index,
                page_id: rows[0].page_id,
            }
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.form_norm.cmp(&b.form_norm)));
    out
}

fn commonest_raw(rows: &[&Link]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for r in rows {
        *counts.entry(r.raw.as_str()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(raw, _)| raw.to_string())
        .unwrap_or_default()
}

/// The node a neighbour counts as: a person if linked, else its own form.
fn key(l: &Link) -> String {
    match l.person_id {
        Some(p) => format!("p{}", p),
        None => format!("f:{}", l.form_norm),
    }
}

/// Every form's neighbours, as multisets of node keys.
struct Company {
    from: HashMap<String, usize>,
    to: HashMap<String, usize>,
    occurrences: Vec<Occurrence>,
}

fn company(links: &[Link]) -> HashMap<String, Company> {
    let mut chains: HashMap<i64, Vec<&Link>> = HashMap::new();
    for l in links {
        chains.entry(l.isnad_id).or_default().push(l);
    }
    let mut out: HashMap<String, Company> = HashMap::new();
    let mut ids: Vec<&i64> = chains.keys().collect();
    ids.sort();
    for id in ids {
        let mut chain = chains[id].clone();
        chain.sort_by_key(|l| l.position);
        for (i, l) in chain.iter().enumerate() {
            // Higher position is earlier in transmission, so the one this
            // transmitter received from is the next one up.
            let from = chain.get(i + 1).filter(|n| n.position == l.position + 1);
            let to = if i > 0 && chain[i - 1].position + 1 == l.position { Some(chain[i - 1]) } else { None };
            let e = out.entry(l.form_norm.clone()).or_insert_with(|| Company { from: HashMap::new(), to: HashMap::new(), occurrences: Vec::new() });
            if let Some(n) = from {
                *e.from.entry(key(n)).or_insert(0) += 1;
            }
            if let Some(n) = to {
                *e.to.entry(key(n)).or_insert(0) += 1;
            }
            e.occurrences.push(Occurrence {
                isnad_id: l.isnad_id,
                transmitter_id: l.transmitter_id,
                part_index: l.part_index,
                page_id: l.page_id,
                from: from.map(|n| n.raw.clone()),
                to: to.map(|n| n.raw.clone()),
            });
        }
    }
    out
}

/// How many neighbours two multisets share, counting repeats.
fn shared(a: &HashMap<String, usize>, b: &HashMap<String, usize>) -> usize {
    a.iter().filter_map(|(k, n)| b.get(k).map(|m| *n.min(m))).sum()
}

/// The forms that might be the same person as `target`, best first.
///
/// `distinctions` holds pairs a reader has already said are *not* the same;
/// they are left out entirely rather than ranked low, because the answer is
/// known.
pub fn candidates(
    links: &[Link],
    target: &str,
    distinctions: &HashSet<(String, String)>,
    person_names: &HashMap<i64, String>,
) -> Vec<Candidate> {
    let all = forms(links, person_names);
    let me = match all.iter().find(|f| f.form_norm == target) {
        Some(f) => f.clone(),
        None => return Vec::new(),
    };
    let co = company(links);
    let empty = Company { from: HashMap::new(), to: HashMap::new(), occurrences: Vec::new() };
    let mine = co.get(target).unwrap_or(&empty);
    let my_parts = parse_raw(&me.raw);

    let mut out: Vec<Candidate> = Vec::new();
    for f in &all {
        if f.form_norm == target {
            continue;
        }
        if distinctions.contains(&pair(target, &f.form_norm)) {
            continue;
        }
        let theirs = co.get(&f.form_norm).unwrap_or(&empty);
        let shared_from = shared(&mine.from, &theirs.from);
        let shared_to = shared(&mine.to, &theirs.to);
        let neighbour_score = saturate(shared_from + shared_to);
        let string_score = string_similarity(&me.form_norm, &f.form_norm, &my_parts, &parse_raw(&f.raw));
        let score = STRING_WEIGHT * string_score + NEIGHBOUR_WEIGHT * neighbour_score;
        if score < FLOOR {
            continue;
        }
        out.push(Candidate {
            form_norm: f.form_norm.clone(),
            raw: f.raw.clone(),
            count: f.count,
            person_id: f.person_id,
            person_name: f.person_name.clone(),
            score,
            string_score,
            neighbour_score,
            shared_from,
            shared_to,
            occurrences: theirs.occurrences.iter().take(MAX_OCCURRENCES).cloned().collect(),
            part_index: f.part_index,
            page_id: f.page_id,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.count.cmp(&a.count)).then_with(|| a.form_norm.cmp(&b.form_norm)));
    out.truncate(MAX_CANDIDATES);
    out
}

/// One shared neighbour is already strong; ten are not ten times stronger.
fn saturate(n: usize) -> f64 {
    1.0 - (-NEIGHBOUR_RATE * n as f64).exp()
}

/// The pair as stored: ordered, so (a, b) and (b, a) are one assertion.
pub fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

fn parse_raw(raw: &str) -> NameParts {
    names::parse(&raw.split_whitespace().map(String::from).collect::<Vec<_>>())
}

// ------------------------------------------------------------- spelling ---

pub fn string_similarity(a_norm: &str, b_norm: &str, a: &NameParts, b: &NameParts) -> f64 {
    let lev = lev_ratio(a_norm, b_norm);
    let tokens = containment(&words(a_norm), &words(b_norm));
    match part_agreement(a, b) {
        Some(parts) => 0.5 * parts + 0.3 * tokens + 0.2 * lev,
        // Nothing the parser placed on both sides: fall back to the words.
        None => 0.6 * tokens + 0.4 * lev,
    }
}

fn words(s: &str) -> HashSet<String> {
    s.split_whitespace().map(|w| w.to_string()).collect()
}

/// How much of the shorter name the longer one contains. `أحمد بن علي`
/// inside `أحمد بن علي بن جعفر` is 1.0, which is the point: a fuller name is
/// not a different name.
fn containment(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.intersection(b).count() as f64 / a.len().min(b.len()) as f64
}

/// Agreement over the parts both names have. `None` when they share none.
fn part_agreement(a: &NameParts, b: &NameParts) -> Option<f64> {
    let mut total = 0.0;
    let mut weight = 0.0;
    let mut add = |w: f64, x: &Option<String>, y: &Option<String>| {
        if let (Some(x), Some(y)) = (x, y) {
            weight += w;
            total += w * containment(&words(x), &words(y));
        }
    };
    add(0.40, &a.ism, &b.ism);
    add(0.30, &a.nasab, &b.nasab);
    add(0.20, &a.nisba, &b.nisba);
    add(0.10, &a.kunya, &b.kunya);
    if weight == 0.0 {
        None
    } else {
        Some(total / weight)
    }
}

fn lev_ratio(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().collect();
    let y: Vec<char> = b.chars().collect();
    let longest = x.len().max(y.len());
    if longest == 0 {
        return 1.0;
    }
    1.0 - levenshtein(&x, &y) as f64 / longest as f64
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(isnad: i64, pos: usize, raw: &str) -> Link {
        Link {
            transmitter_id: isnad * 100 + pos as i64,
            isnad_id: isnad,
            position: pos,
            person_id: None,
            form_norm: names::form_norm(raw),
            raw: raw.to_string(),
            part_index: 0,
            page_id: 1,
        }
    }

    #[test]
    fn a_fuller_name_is_not_a_different_name() {
        let short = "احمد بن علي";
        let long = "احمد بن علي بن جعفر";
        let other = "احمد بن عمر";
        let s = string_similarity(short, long, &parse_raw(short), &parse_raw(long));
        let d = string_similarity(short, other, &parse_raw(short), &parse_raw(other));
        assert!(s > d, "{} should beat {}", s, d);
        assert!(s > 0.75, "{}", s);
    }

    #[test]
    fn character_overlap_alone_does_not_decide() {
        // Same length, one letter apart, but a different man.
        let a = "علي بن حسن";
        let b = "علي بن حسين";
        let s = string_similarity(a, b, &parse_raw(a), &parse_raw(b));
        assert!(s < 0.9, "{}", s);
    }

    #[test]
    fn shared_company_outweighs_spelling() {
        // Two spellings of one man, each between the same teacher and the
        // same student, in two chains.
        let links = vec![
            link(1, 2, "الجنيد"),
            link(1, 1, "احمد بن علي"),
            link(1, 0, "ابو نصر"),
            link(2, 2, "الجنيد"),
            link(2, 1, "احمد بن علي بن جعفر"),
            link(2, 0, "ابو نصر"),
            // A stranger who merely spells alike.
            link(3, 0, "احمد بن عمر"),
        ];
        let c = candidates(&links, &names::form_norm("احمد بن علي"), &HashSet::new(), &HashMap::new());
        assert_eq!(c[0].form_norm, names::form_norm("احمد بن علي بن جعفر"));
        assert_eq!(c[0].shared_from, 1);
        assert_eq!(c[0].shared_to, 1);
        assert!(c[0].score > 0.7, "{}", c[0].score);
        // And the stranger is behind it, on spelling alone.
        assert!(c.len() < 2 || c[1].score < c[0].score);
    }

    #[test]
    fn an_occurrence_says_who_stood_on_either_side() {
        let links = vec![link(1, 2, "الجنيد"), link(1, 1, "احمد بن علي"), link(1, 0, "ابو نصر"), link(2, 1, "احمد بن علي بن جعفر"), link(2, 0, "ابو نصر")];
        let c = candidates(&links, &names::form_norm("احمد بن علي"), &HashSet::new(), &HashMap::new());
        let o = &c[0].occurrences[0];
        assert_eq!(o.to.as_deref(), Some("ابو نصر"));
        assert_eq!(o.from, None);
        assert_eq!(o.page_id, 1);
    }

    #[test]
    fn a_pair_ruled_out_is_never_offered_again() {
        let links = vec![link(1, 1, "احمد بن علي"), link(1, 0, "احمد بن علي بن جعفر")];
        let target = names::form_norm("احمد بن علي");
        let other = names::form_norm("احمد بن علي بن جعفر");
        assert!(!candidates(&links, &target, &HashSet::new(), &HashMap::new()).is_empty());
        let mut no = HashSet::new();
        no.insert(pair(&target, &other));
        assert!(candidates(&links, &target, &no, &HashMap::new()).is_empty());
        // The ordering is canonical, so it holds from either side.
        assert_eq!(pair(&target, &other), pair(&other, &target));
    }

    #[test]
    fn forms_are_counted_and_the_commonest_spelling_wins() {
        let links = vec![
            link(1, 0, "أحمد بن علي"),
            link(2, 0, "احمد بن علي"),
            link(3, 0, "احمد بن علي"),
            link(4, 0, "الجنيد"),
        ];
        let f = forms(&links, &HashMap::new());
        assert_eq!(f[0].count, 3);
        assert_eq!(f[0].raw, "احمد بن علي");
        assert_eq!(f[1].count, 1);
    }
}
