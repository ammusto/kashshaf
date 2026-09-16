//! Which of these names are the same person? (Phase 10 A.)
//!
//! One person is written a dozen ways across a book: `أحمد بن علي`,
//! `أحمد بن علي بن جعفر`, `أبو بكر أحمد بن علي الخطيب`. The isnād workbench
//! links a transmitter row at a time; this ranks whole *forms* against one
//! another so the decision is made once.
//!
//! A gate, and then a ranking.
//!
//! **The gate is structural.** Edit distance over whole strings is the wrong
//! instrument for Arabic names: `جابر` and `جاحظ` are one letter apart and
//! two men, `الحسن بن محمد` and `الحسين بن محمود` are close and two men,
//! while `أحمد بن علي` and `أحمد بن علي بن جعفر` are far apart and one man.
//! So nothing here measures strings as strings. The parts `names::parse`
//! finds are compared to their counterparts — ism to ism, the first nasab
//! link to the first nasab link, nisba to nisba, kunya to kunya — and a pair
//! is a candidate only if **every part present in both matches**, either
//! identically once normalised or as a listed orthographic variant.
//!
//! A part present in one name only is ignored. That is truncation, and it is
//! the strongest positive signal there is: the shorter name is the longer
//! one with its tail cut off, which is how these texts name people.
//!
//! The one exception is a short curated list of genuinely confusable pairs
//! (`الحسن`/`الحسين`, `سعد`/`سعيد`, `عمر`/`عمرو`, `أحمد`/`محمد`). A pair
//! that needs one of those to match is not a candidate: it is reported in a
//! separate group, labelled, and never mixed into the ranked list.
//!
//! **The ranking is the company kept.** Among the forms that pass the gate,
//! how often the two sit next to the same transmitter in a chain — the one
//! they received from, and the one they gave to. It orders the survivors; it
//! cannot rescue a name that failed the gate.
//!
//! Everything here is pure: the commands read the rows, this ranks them.

use crate::analysis::names::{self};
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
    /// How much company the two keep, which is what orders the list.
    pub score: f64,
    /// The parts that corroborate the match: "ism", "nasab 1", "nisba"…
    pub matched: Vec<String>,
    /// Set when the pair only matches by way of a commonly confused pair,
    /// naming it. These are listed apart and never merged in.
    pub confusable: Option<String>,
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
    let my_parts = slots(&me.raw);

    let mut out: Vec<Candidate> = Vec::new();
    for f in &all {
        if f.form_norm == target {
            continue;
        }
        if distinctions.contains(&pair(target, &f.form_norm)) {
            continue;
        }
        // The gate first: no amount of shared company makes two names one
        // name.
        let (matched, confusable) = match gate(&my_parts, &slots(&f.raw)) {
            Gate::Fail => continue,
            Gate::Pass { matched } => (matched, None),
            Gate::Confused { matched, confusion } => (matched, Some(confusion)),
        };
        let theirs = co.get(&f.form_norm).unwrap_or(&empty);
        let shared_from = shared(&mine.from, &theirs.from);
        let shared_to = shared(&mine.to, &theirs.to);
        out.push(Candidate {
            form_norm: f.form_norm.clone(),
            raw: f.raw.clone(),
            count: f.count,
            person_id: f.person_id,
            person_name: f.person_name.clone(),
            score: saturate(shared_from + shared_to),
            matched,
            confusable,
            shared_from,
            shared_to,
            occurrences: theirs.occurrences.iter().take(MAX_OCCURRENCES).cloned().collect(),
            part_index: f.part_index,
            page_id: f.page_id,
        });
    }
    // Company orders the survivors; where it says nothing, the name that
    // corroborates in more places and occurs more often comes first.
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.matched.len().cmp(&a.matched.len()))
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.form_norm.cmp(&b.form_norm))
    });
    // The two groups are capped apart, so a flood of one cannot bury the
    // other.
    let mut kept: Vec<Candidate> = Vec::new();
    let mut confused: Vec<Candidate> = Vec::new();
    for c in out {
        let bucket = if c.confusable.is_some() { &mut confused } else { &mut kept };
        if bucket.len() < MAX_CANDIDATES {
            bucket.push(c);
        }
    }
    kept.extend(confused);
    kept
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

// ----------------------------------------------------------- the spelling ---

/// A name split into the parts that can be compared with another name's.
///
/// `names::parse` does the work; the nasab chain is split into its links so
/// that the first can be compared with the first, and every part is put in
/// the one spelling used for comparison.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Slots {
    pub kunya: Option<String>,
    pub ism: Option<String>,
    /// One entry per `بن X` link, in order, without the connector.
    pub nasab: Vec<String>,
    pub nisba: Option<String>,
}

pub fn slots(raw: &str) -> Slots {
    let p = names::parse(&raw.split_whitespace().map(String::from).collect::<Vec<_>>());
    Slots {
        kunya: p.kunya.as_deref().map(canon),
        ism: p.ism.as_deref().map(canon),
        nasab: p.nasab.as_deref().map(split_nasab).unwrap_or_default(),
        nisba: p.nisba.as_deref().map(canon),
    }
}

impl Slots {
    fn count(&self) -> usize {
        self.kunya.is_some() as usize + self.ism.is_some() as usize + self.nasab.len() + self.nisba.is_some() as usize
    }

    /// What the name is chiefly called: the ism, or what stands in for it.
    /// A one-word name is the head of a longer one, not one of its
    /// genealogy: `الجنيد` is `الجنيد بن محمد`, but it is not `ابراهيم بن
    /// الجنيد`, who is his son, nor `خادمة الجنيد`, who is his servant.
    fn head(&self) -> Option<&String> {
        self.ism.as_ref().or(self.nisba.as_ref()).or(self.kunya.as_ref()).or(self.nasab.first())
    }

    fn all(&self) -> Vec<&String> {
        let mut v: Vec<&String> = Vec::new();
        v.extend(self.kunya.iter());
        v.extend(self.ism.iter());
        v.extend(self.nasab.iter());
        v.extend(self.nisba.iter());
        v
    }
}

/// `بن احمد بن زياد` → `["احمد", "زياد"]`.
fn split_nasab(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for w in s.split_whitespace() {
        if names::NASAB.contains(&w) {
            if !cur.is_empty() {
                out.push(canon(&cur.join(" ")));
                cur.clear();
            }
        } else {
            cur.push(w);
        }
    }
    if !cur.is_empty() {
        out.push(canon(&cur.join(" ")));
    }
    out
}

/// The one spelling a part is compared in: the engine's normalisation (which
/// `names::parse` has already applied), tāʾ marbūṭa folded to hāʾ, the kunya
/// heads and the two spellings of `بن` unified, and the spaces taken out so
/// that `عبد الله` and `عبدالله` are one word.
pub fn canon(s: &str) -> String {
    s.split_whitespace()
        .map(|w| match w {
            "ابا" | "ابي" => "ابو",
            "ابن" => "بن",
            "ابنة" => "بنت",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("")
        .replace('ة', "ه")
}

/// Spellings of one name. Not similar names: the same name written the way
/// the manuscripts write it.
const VARIANTS: [(&str, &str); 7] = [
    ("اسمعيل", "اسماعيل"),
    ("اسحق", "اسحاق"),
    ("ابرهيم", "ابراهيم"),
    ("هرون", "هارون"),
    ("سليمن", "سليمان"),
    ("داود", "داوود"),
    ("يحي", "يحيي"),
];

/// Names that are genuinely mistaken for one another by scribes and by
/// readers. A pair that needs one of these is never a candidate: it is
/// shown apart, under its own heading, for a person to decide.
const CONFUSABLE: [(&str, &str); 5] = [
    ("الحسن", "الحسين"),
    ("حسن", "حسين"),
    ("سعد", "سعيد"),
    ("عمر", "عمرو"),
    ("احمد", "محمد"),
];

fn listed(table: &[(&str, &str)], a: &str, b: &str) -> bool {
    table.iter().any(|(x, y)| (a == *x && b == *y) || (a == *y && b == *x))
}

/// The same part, written either of the ways it is written.
fn same(a: &str, b: &str) -> bool {
    a == b || listed(&VARIANTS, a, b)
}

fn confusable(a: &str, b: &str) -> bool {
    listed(&CONFUSABLE, a, b)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Pass { matched: Vec<String> },
    Confused { matched: Vec<String>, confusion: String },
    Fail,
}

/// Compare part with part. Every part the two names share must match.
pub fn gate(a: &Slots, b: &Slots) -> Gate {
    // A name of one part is almost always the longer name cut short, and
    // which part the parser called it is a coin toss: `الجنيد` alone is an
    // ism in one chain and a nisba in the next. So it is matched against any
    // part of the other name — but strictly, with no confusable allowed.
    if a.count() <= 1 || b.count() <= 1 {
        let (short, long) = if a.count() <= b.count() { (a, b) } else { (b, a) };
        let (Some(one), Some(head)) = (short.all().first().cloned(), long.head()) else { return Gate::Fail };
        return if same(one, head) {
            Gate::Pass { matched: vec!["name".into()] }
        } else {
            Gate::Fail
        };
    }

    let mut matched: Vec<String> = Vec::new();
    let mut confusion: Option<String> = None;
    let mut compare = |label: String, x: &str, y: &str| -> bool {
        if same(x, y) {
            matched.push(label);
            true
        } else if confusable(x, y) && confusion.is_none() {
            confusion = Some(format!("{} / {}", x, y));
            true
        } else {
            false
        }
    };

    if let (Some(x), Some(y)) = (&a.kunya, &b.kunya) {
        if !compare("kunya".into(), x, y) {
            return Gate::Fail;
        }
    }
    if let (Some(x), Some(y)) = (&a.ism, &b.ism) {
        if !compare("ism".into(), x, y) {
            return Gate::Fail;
        }
    }
    for (i, (x, y)) in a.nasab.iter().zip(b.nasab.iter()).enumerate() {
        if !compare(format!("nasab {}", i + 1), x, y) {
            return Gate::Fail;
        }
    }
    if let (Some(x), Some(y)) = (&a.nisba, &b.nisba) {
        if !compare("nisba".into(), x, y) {
            return Gate::Fail;
        }
    }

    // Two names that share no part at all are not a pair; they are two names
    // that happen to be in the same book.
    if matched.is_empty() && confusion.is_none() {
        return Gate::Fail;
    }
    match confusion {
        Some(c) => Gate::Confused { matched, confusion: c },
        None => Gate::Pass { matched },
    }
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

    fn g(a: &str, b: &str) -> Gate {
        gate(&slots(a), &slots(b))
    }

    fn passes(a: &str, b: &str) -> bool {
        matches!(g(a, b), Gate::Pass { .. })
    }

    #[test]
    fn truncation_passes_because_it_is_the_same_man() {
        // The whole point: a shorter name is the longer one cut off.
        assert!(passes("احمد بن علي", "احمد بن علي بن جعفر"));
        assert!(passes("احمد بن علي بن جعفر", "احمد بن علي"));
        // What matched is the part the two share, not the part only one has.
        match g("احمد بن علي", "احمد بن علي بن جعفر") {
            Gate::Pass { matched } => assert_eq!(matched, vec!["ism", "nasab 1"]),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn a_letter_apart_is_still_two_men() {
        // Edit distance rated these close. They are different people.
        assert!(!passes("جابر", "جاحظ"));
        assert!(!passes("الحسن بن محمد", "الحسين بن محمود"));
        assert!(!passes("علي بن حسن", "علي بن حسين") || matches!(g("علي بن حسن", "علي بن حسين"), Gate::Confused { .. }));
    }

    #[test]
    fn a_part_that_disagrees_fails_however_alike_the_rest() {
        assert!(!passes("احمد بن علي", "احمد بن عمر"));
        assert!(!passes("محمد بن سعيد الطوسي", "محمد بن سعيد البغدادي"));
        // Nothing in common at all is not a pair either.
        assert!(!passes("الجنيد", "سهل بن عبد الله"));
    }

    #[test]
    fn one_name_is_written_several_ways() {
        assert!(passes("عبد الله بن عمر", "عبدالله بن عمر"));
        assert!(passes("اسمعيل بن احمد", "اسماعيل بن احمد"));
        assert!(passes("احمد بن ابراهيم", "احمد بن ابرهيم"));
        // The hamza carriers and بن/ابن are folded before any of this.
        assert!(passes("أحمد بن علي", "احمد ابن علي"));
        // And tāʾ marbūṭa.
        assert!(passes("عائشة بنت طلحة", "عايشه بنت طلحه"));
    }

    #[test]
    fn a_confusable_pair_is_held_apart_and_named() {
        match g("الحسن بن محمد", "الحسين بن محمد") {
            Gate::Confused { matched, confusion } => {
                assert_eq!(matched, vec!["nasab 1"]);
                assert_eq!(confusion, "الحسن / الحسين");
            }
            other => panic!("{:?}", other),
        }
        // One confusable is a question; two are a different man.
        assert!(!passes("الحسن بن سعد", "الحسين بن سعيد"));
        assert!(matches!(g("الحسن بن سعد", "الحسين بن سعيد"), Gate::Fail));
    }

    #[test]
    fn a_single_part_name_is_strict() {
        // It may match any part, because which part it is is a coin toss.
        assert!(passes("الجنيد", "الجنيد بن محمد الصوفي"));
        assert!(passes("مالك", "مالك بن انس"));
        // But it must be the head of the longer name, not a link in its
        // genealogy: the son and the servant are not the man.
        assert!(!passes("الجنيد", "ابراهيم بن الجنيد"));
        assert!(!passes("الجنيد", "خادمة الجنيد"));
        assert!(!passes("علي", "احمد بن علي بن جعفر"));
        // And nothing is allowed to be nearly right.
        assert!(!passes("الحسن", "الحسين بن محمد"));
        assert!(!passes("سعد", "سعيد بن جبير"));
        assert!(matches!(g("الحسن", "الحسين"), Gate::Fail));
    }

    #[test]
    fn company_ranks_the_survivors_and_rescues_nobody() {
        let links = vec![
            // Two spellings of one man between the same pair.
            link(1, 2, "الجنيد"),
            link(1, 1, "احمد بن علي"),
            link(1, 0, "ابو نصر"),
            link(2, 2, "الجنيد"),
            link(2, 1, "احمد بن علي بن جعفر"),
            link(2, 0, "ابو نصر"),
            // A stranger who keeps exactly the same company.
            link(3, 2, "الجنيد"),
            link(3, 1, "سهل بن عبد الله"),
            link(3, 0, "ابو نصر"),
        ];
        let c = candidates(&links, &names::form_norm("احمد بن علي"), &HashSet::new(), &HashMap::new());
        assert_eq!(c.len(), 1, "{:?}", c.iter().map(|x| &x.raw).collect::<Vec<_>>());
        assert_eq!(c[0].form_norm, names::form_norm("احمد بن علي بن جعفر"));
        assert_eq!((c[0].shared_from, c[0].shared_to), (1, 1));
        // The stranger shared both neighbours too, and is still not offered.
        assert!(c.iter().all(|x| x.raw != "سهل بن عبد الله"));
    }

    #[test]
    fn the_confused_come_after_the_candidates() {
        let links = vec![
            link(1, 0, "الحسن بن محمد"),
            link(2, 0, "الحسن بن محمد الطوسي"),
            link(3, 0, "الحسين بن محمد"),
        ];
        let c = candidates(&links, &names::form_norm("الحسن بن محمد"), &HashSet::new(), &HashMap::new());
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].raw, "الحسن بن محمد الطوسي");
        assert_eq!(c[0].confusable, None);
        assert_eq!(c[1].raw, "الحسين بن محمد");
        assert_eq!(c[1].confusable.as_deref(), Some("الحسن / الحسين"));
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

    #[test]
    fn the_nasab_chain_is_compared_link_by_link() {
        assert_eq!(slots("احمد بن علي بن جعفر").nasab, vec!["علي", "جعفر"]);
        // Same links, different order: not the same man.
        assert!(!passes("احمد بن علي بن جعفر", "احمد بن جعفر بن علي"));
    }
}
