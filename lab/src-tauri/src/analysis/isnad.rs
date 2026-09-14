//! Isnād extraction (Lab spec §4.2).
//!
//! A deterministic state machine over token classes, then a confidence score
//! whose components are exposed. No external annotation: the lexicons are
//! shipped defaults the user edits, and everything else is position.
//!
//! **Token classes**, first match wins, exactly the order of §4.2:
//! `FORMULA` (shipped multi-token list; transparent), `VERB` (transmission
//! lexicon), `CONNECT` (`بن ابن بنت أبو أبي أبا أم عن مولى أخو ابنة والد`, and
//! an `ال`-word right after a `NAME`), `NAME` (`noun_prop`; or any nominal
//! right after a `VERB` or `CONNECT` — position beats POS), `OTHER`.
//!
//! What the corpus actually tags (measured on the gold transmitter spans,
//! identically through the pipeline's JSONL, `LocalSource` and Kashshaf's
//! `get_page_tokens` — `tests/pos_audit.rs`): 74% of transmitter tokens are
//! `noun_prop`, 22% `noun` (the rest `adj`, a few verbs and particles); but
//! 15% of matn tokens and 22% of the other tokens on those pages are
//! `noun_prop` too (`بني إسرائيل`, `الله`, place names). Corpus-wide,
//! `noun_prop` is 11.5% of all tokens. So the tag is strong evidence inside
//! a chain and no licence to open one.
//!
//! Three departures from the letter of §4.2, each forced by that:
//!
//! - A nisba is as often tagged `noun` as `adj` (`السجستاني/noun`,
//!   `الدستوائي/noun` on the first page of Abū Dāwūd's *Zuhd*), so the
//!   "`ال`-adjective after a NAME continues the name" rule accepts an
//!   `ال`-noun too.
//! - A name span may only *open* when introduced — by a verb, by `عن`, or by
//!   a nasab/kin connector that is itself introduced. §4.2's bare
//!   "`noun_prop` is a NAME" let every proper noun in the matn pull the chain
//!   back open. (A bridge variant — `noun_prop` after `أنّ`/`لي`/`له` opens a
//!   span — was measured against the gold set and was neutral: span F1
//!   unchanged, one span gained, three spurious added. Not adopted.)
//! - §4.2 leaves unspecified where an `OTHER` token judged to be noise inside
//!   a chain goes. A *nominal* noise token adjacent to the open name span is
//!   attached to it (`أحمد نظام الدين`, `محمد أمين`); anything else closes the
//!   span. Without this, compound names fragment into two transmitters.
//!
//! The lexicon is matched on normalized surface (its entries are surfaces),
//! with a leading `و`/`ف` proclitic tolerated. `أنا` = `أخبرنا` is in the core
//! group and is tagged `pron` in the corpus; the lookahead is what keeps a
//! pronoun `أنا` in running prose from opening a chain.

use super::names::{self, NameParts};
use super::sections;
use crate::lexicon::{Group, Lexicon};
use kashshaf_engine::{normalize_arabic, Token};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const EXTRACTOR_VERSION: &str = "0.2.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Formula,
    Verb,
    Connect,
    Name,
    Other,
    /// Inside a `<title>` heading: a chain cannot cross it.
    Boundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Isnad,
    Citation,
}

/// User-set parameters (spec §4.2, §7.8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Params {
    /// Links an isnād needs (default 2; a citation-group chain needs 1).
    pub min_links: usize,
    /// Tokens the boundary lookahead inspects (default 3; 2–5).
    pub lookahead: usize,
    /// Candidates below this are not emitted (default 0.2).
    pub min_confidence: f64,
    /// Lexicon groups in play.
    pub groups: Vec<Group>,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            min_links: 2,
            lookahead: 3,
            min_confidence: 0.2,
            groups: vec![Group::Core, Group::History, Group::Written, Group::Citation],
        }
    }
}

/// One transmitter of a candidate, in the chain's order (0 = nearest the
/// author, i.e. first in the text).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransmitterSpan {
    pub position: usize,
    pub tok_start: usize,
    pub tok_end: usize,
    pub raw: String,
    pub parts: NameParts,
    /// The transmission verb that introduced this link.
    pub verb_before: Option<String>,
}

/// The components of the score, each in [0, 1], all monotone (§4.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Confidence {
    /// min(links, 5) / 5
    pub links: f64,
    /// NAME tokens tagged `noun_prop` / all NAME tokens. Informative: on the
    /// gold set a real chain's transmitters are ~74% `noun_prop`.
    pub noun_prop: f64,
    /// A recognised chain-terminal pattern was found.
    pub terminal: f64,
    /// 1 − noise tokens / chain tokens.
    pub clean: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub tok_start: usize,
    pub tok_end: usize,
    pub kind: Kind,
    /// The group of the opening verb.
    pub group: Group,
    pub links: usize,
    /// `[start, end)` of the matn, when one follows.
    pub matn: Option<(usize, usize)>,
    pub transmitters: Vec<TransmitterSpan>,
    pub confidence: Confidence,
    /// Every token class inside the span, for the workbench's colours.
    pub classes: Vec<(usize, Class)>,
}

/// A token as the extractor sees it.
#[derive(Debug, Clone)]
pub struct View {
    pub surface: String,
    pub norm: String,
    pub pos: String,
}

impl View {
    pub fn of(t: &Token) -> Self {
        Self { surface: t.surface.clone(), norm: normalize_arabic(&t.surface), pos: t.pos.clone() }
    }
}

/// §4.2's list, plus the inflected kin words the corpus actually uses for a
/// pronominal link (`عن أبيه`, `عن والده`, `عن عمه`): the spec's bare `والد`
/// never occurs as a link, its possessive forms do.
const CONNECT_WORDS: [&str; 19] = [
    "بن", "ابن", "بنت", "ابو", "ابي", "ابا", "ام", "عن", "مولي", "اخو", "ابنة", "والد",
    "ابيه", "ابوه", "والده", "والدي", "عمه", "جده", "شيخه",
];
/// Connectors that never end a name span (spec: "بن always continues"), and
/// that can start one.
const ALWAYS_CONTINUE: [&str; 15] = ["بن", "ابن", "بنت", "ابنة", "ابو", "ابي", "ابا", "ام", "ابيه", "ابوه", "والده", "والدي", "عمه", "جده", "شيخه"];
/// Kin words that are a transmitter by themselves (`عن أبيه قال`).
const KIN: [&str; 7] = ["ابيه", "ابوه", "والده", "والدي", "عمه", "جده", "شيخه"];

fn is_nominal(pos: &str) -> bool {
    matches!(pos, "noun" | "noun_prop" | "adj") || !KNOWN_NON_NOMINAL.contains(&pos)
}

/// Every non-nominal tag the pipeline emits; anything else counts as unknown,
/// and unknown is nominal for the position rule (spec: "noun/adj/unknown").
const KNOWN_NON_NOMINAL: [&str; 24] = [
    "verb", "prep", "conj_sub", "pron", "part_neg", "part", "adv_rel", "pron_rel", "pron_dem", "adv", "conj",
    "part_voc", "part_verb", "abbrev", "part_focus", "verb_pseudo", "interj", "adv_interrog", "part_interrog",
    "part_det", "noun_quant", "pron_interrog", "punc", "part_fut",
];

fn has_al(w: &str) -> bool {
    w.starts_with("ال") && w.chars().count() > 3
}

/// `entry` matches at `i`? A leading و/ف on the first token is tolerated.
fn matches_at(views: &[View], i: usize, entry: &[String]) -> bool {
    if i + entry.len() > views.len() {
        return false;
    }
    for (k, want) in entry.iter().enumerate() {
        let have = &views[i + k].norm;
        if have == want {
            continue;
        }
        if k == 0 {
            if let Some(stripped) = have.strip_prefix('و').or_else(|| have.strip_prefix('ف')) {
                if stripped == want && stripped.chars().count() >= 2 {
                    continue;
                }
            }
        }
        return false;
    }
    true
}

/// The classification pass: one class per token, plus the verb group and the
/// length of the lexicon match that produced it.
pub fn classify(
    views: &[View],
    lex: &Lexicon,
    params: &Params,
    overrides: &HashMap<usize, Class>,
    boundaries: &[(usize, usize)],
) -> (Vec<Class>, Vec<Option<Group>>, Vec<usize>) {
    let n = views.len();
    let mut classes = vec![Class::Other; n];
    let mut groups = vec![None; n];
    let mut lens = vec![1usize; n];
    let in_boundary = |i: usize| boundaries.iter().any(|(a, b)| i >= *a && i < *b);
    let mut i = 0;
    while i < n {
        if let Some(c) = overrides.get(&i) {
            classes[i] = *c;
            i += 1;
            continue;
        }
        if in_boundary(i) {
            classes[i] = Class::Boundary;
            i += 1;
            continue;
        }
        // FORMULA, longest first (the lexicon is sorted so).
        if let Some(f) = lex.formulas.iter().find(|f| matches_at(views, i, f)) {
            for k in 0..f.len() {
                classes[i + k] = Class::Formula;
            }
            lens[i] = f.len();
            i += f.len();
            continue;
        }
        // VERB, longest first, enabled groups only.
        if let Some((t, g)) = lex.transmission.iter().find(|(t, g)| params.groups.contains(g) && matches_at(views, i, t)) {
            for k in 0..t.len() {
                classes[i + k] = Class::Verb;
                groups[i + k] = Some(*g);
            }
            lens[i] = t.len();
            i += t.len();
            continue;
        }
        let w = views[i].norm.as_str();
        let prev = if i == 0 { Class::Other } else { classes[i - 1] };
        classes[i] = if CONNECT_WORDS.contains(&w) {
            Class::Connect
        } else if views[i].pos == "noun_prop" {
            Class::Name
        } else if is_nominal(&views[i].pos) && matches!(prev, Class::Verb | Class::Connect) {
            Class::Name
        } else if has_al(w) && is_nominal(&views[i].pos) && prev == Class::Name {
            Class::Connect
        } else {
            Class::Other
        };
        i += 1;
    }
    (classes, groups, lens)
}

/// Ḥadīth-number markers — `^\s*[\d٠-٩]+\s*[-–]` at a line start —
/// as the display-token index of the first token after each (digits and
/// dashes are stripped, so the marker itself owns no token).
pub fn hadith_markers(body: &str) -> Vec<usize> {
    let text = super::align::strip_html(body);
    let map = super::align::char_to_token_map(&text);
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let n = chars.len();
    while i < n {
        // At a line start (or the text start).
        if i == 0 || chars[i - 1] == '\n' {
            let mut j = i;
            while j < n && (chars[j] == ' ' || chars[j] == '\t') {
                j += 1;
            }
            let d0 = j;
            while j < n && (chars[j].is_ascii_digit() || ('\u{0660}'..='\u{0669}').contains(&chars[j])) {
                j += 1;
            }
            if j > d0 {
                let mut k = j;
                while k < n && chars[k] == ' ' {
                    k += 1;
                }
                if k < n && (chars[k] == '-' || chars[k] == '–' || chars[k] == '—') {
                    // The next token index after the marker.
                    let next = map[k..].iter().flatten().next().copied();
                    if let Some(t) = next {
                        out.push(t);
                    }
                }
            }
        }
        i += 1;
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Chain-terminal patterns (§4.2): `قال رسول الله`, `قال النبي`, or the last
/// transmitter followed by `قال`.
fn is_terminal(views: &[View], matn_start: usize, last_verb: Option<&str>) -> bool {
    let at = |k: usize| views.get(matn_start + k).map(|v| v.norm.as_str());
    if at(0) == Some("قال") && matches!(at(1), Some("رسول") | Some("النبي")) {
        return true;
    }
    last_verb == Some("قال")
}

/// Extract every candidate on one page, in reading order.
pub fn extract_page(tokens: &[Token], body: &str, lex: &Lexicon, params: &Params, overrides: &HashMap<usize, Class>) -> Vec<Candidate> {
    let views: Vec<View> = tokens.iter().map(View::of).collect();
    let headings: Vec<(usize, usize)> = sections::headings(body).into_iter().map(|h| (h.tok_start, h.tok_end)).collect();
    let markers = hadith_markers(body);
    extract_views(&views, &headings, &markers, lex, params, overrides)
}

pub fn extract_views(
    views: &[View],
    headings: &[(usize, usize)],
    markers: &[usize],
    lex: &Lexicon,
    params: &Params,
    overrides: &HashMap<usize, Class>,
) -> Vec<Candidate> {
    let n = views.len();
    let (classes, groups, lens) = classify(views, lex, params, overrides, headings);
    let k = params.lookahead.clamp(2, 5);

    // `opened[x]`: a name span may *open* at x. A transmitter is introduced
    // by a verb, by `عن`, or by a nasab/kin connector that is itself
    // introduced; a `noun_prop` in the matn (`بني إسرائيل`) is not. Formulas
    // are transparent, and a name keeps the door open for its own
    // continuation. Without this, any place name after the chain pulls it
    // back open.
    let mut opened = vec![false; n];
    let mut door = false;
    for x in 0..n {
        opened[x] = door;
        door = match classes[x] {
            Class::Verb => true,
            Class::Connect => door || views[x].norm == "عن",
            Class::Name => door,
            Class::Formula => door,
            Class::Other | Class::Boundary => false,
        };
    }
    // Names that can actually start or continue a span, for the lookahead.
    let counts_as_name = |x: usize| classes[x] == Class::Name && opened[x];
    // `رسول الله` / `النبي`, or `الله` right after a verb: the end of every
    // chain (§4.2's terminal pattern); the matn starts at the verb before it.
    let terminal_at = |x: usize| -> bool {
        let w = views[x].norm.as_str();
        (w == "رسول" && views.get(x + 1).map(|v| v.norm == "الله").unwrap_or(false))
            || w == "النبي"
            || (w == "الله" && x > 0 && classes[x - 1] == Class::Verb)
    };
    let alive_after = |j: usize| -> bool {
        (j + 1..(j + 1 + k).min(n))
            .any(|x| classes[x] == Class::Verb || counts_as_name(x) || (classes[x] == Class::Connect && views[x].norm == "عن"))
    };

    let mut out: Vec<Candidate> = Vec::new();
    let mut i = 0;

    while i < n {
        if classes[i] != Class::Verb || (i > 0 && classes[i - 1] == Class::Verb && lens[i] == 1 && lens_covers(&lens, i)) {
            i += 1;
            continue;
        }
        let opening_group = groups[i].unwrap_or(Group::Core);
        let verb_text = |at: usize| -> String { views[at..at + lens[at].max(1)].iter().map(|v| v.norm.clone()).collect::<Vec<_>>().join(" ") };

        let mut spans: Vec<(usize, usize, Option<String>)> = Vec::new();
        let mut cur: Option<(usize, usize)> = None;
        let mut last_verb: Option<String> = Some(verb_text(i));
        let mut noise = 0usize;
        let mut ended_at: Option<usize> = None;
        let mut j = i + lens[i];

        let close = |cur: &mut Option<(usize, usize)>, spans: &mut Vec<(usize, usize, Option<String>)>, last_verb: &Option<String>| {
            if let Some((a, b)) = cur.take() {
                if b > a {
                    spans.push((a, b, last_verb.clone()));
                }
            }
        };

        while j < n {
            match classes[j] {
                Class::Boundary => {
                    ended_at = Some(j);
                    break;
                }
                Class::Name if terminal_at(j) => {
                    // The Prophet ends the chain; whatever introduced him
                    // belongs to the matn.
                    ended_at = Some(j);
                    break;
                }
                Class::Name => {
                    match cur {
                        Some((a, _)) => cur = Some((a, j + 1)),
                        None if opened[j] => cur = Some((j, j + 1)),
                        // A name nothing introduced (a place, `الله` in prose):
                        // noise at best, the boundary otherwise.
                        None => {
                            if alive_after(j) {
                                noise += 1;
                            } else {
                                ended_at = Some(j);
                                break;
                            }
                        }
                    }
                    j += 1;
                }
                Class::Connect => {
                    let w = views[j].norm.as_str();
                    let next_is_name = classes.get(j + 1) == Some(&Class::Name);
                    if w == "عن" {
                        // `عن` is a link, not part of a name: X عن Y are two
                        // transmitters, and Y's verb_before is عن.
                        close(&mut cur, &mut spans, &last_verb);
                        last_verb = Some("عن".to_string());
                    } else if !CONNECT_WORDS.contains(&w) {
                        // An ال-word continuing a name (a nisba): part of the span.
                        if let Some((a, _)) = cur {
                            cur = Some((a, j + 1));
                        }
                    } else if cur.is_some() && (next_is_name || ALWAYS_CONTINUE.contains(&w)) {
                        cur = cur.map(|(a, _)| (a, j + 1));
                    } else if cur.is_some() {
                        close(&mut cur, &mut spans, &last_verb);
                    } else if opened[j] && (next_is_name || KIN.contains(&w)) {
                        // A name that starts with its connector (أبو X, ابن X,
                        // مولى X) — or is one: عن أبيه قال.
                        cur = Some((j, j + 1));
                    }
                    j += 1;
                }
                Class::Formula => {
                    j += lens[j].max(1);
                }
                Class::Verb => {
                    close(&mut cur, &mut spans, &last_verb);
                    last_verb = Some(verb_text(j));
                    j += lens[j].max(1);
                }
                Class::Other => {
                    if alive_after(j) {
                        noise += 1;
                        if cur.is_some() && is_nominal(&views[j].pos) && cur.map(|(_, b)| b == j).unwrap_or(false) {
                            cur = cur.map(|(a, _)| (a, j + 1));
                        } else {
                            close(&mut cur, &mut spans, &last_verb);
                        }
                        j += 1;
                    } else {
                        ended_at = Some(j);
                        break;
                    }
                }
            }
        }
        close(&mut cur, &mut spans, &last_verb);
        let chain_end = ended_at.unwrap_or(n);
        let links = spans.len();

        // The isnād/matn boundary (§4.2): the first OTHER after the last
        // transmitter, past the verb or formula that closed it — so
        // `… عن وهب بن منبه قال | إني أجد …` puts قال in the chain and إني in
        // the matn. Noise the lookahead tolerated after the last name
        // (`رأيت في كتاب بلغني`) therefore belongs to the matn, not to limbo.
        let last_span_end = spans.last().map(|s| s.1).unwrap_or(i + lens[i].max(1));
        let mut boundary = last_span_end;
        while boundary < chain_end && classes[boundary] == Class::Formula {
            boundary += lens[boundary].max(1);
        }
        if boundary < chain_end && classes[boundary] == Class::Verb {
            let after = boundary + lens[boundary].max(1);
            // `قال رسول الله`, `قال الله`: that قال is the matn's, not the chain's.
            let introduces_terminal = after < n && terminal_at(after);
            if !introduces_terminal {
                boundary = after;
                while boundary < chain_end && classes[boundary] == Class::Formula {
                    boundary += lens[boundary].max(1);
                }
            }
        }
        let boundary = boundary.min(chain_end.max(last_span_end));
        // The verb right before the boundary, for the terminal pattern.
        let closing_verb: Option<String> = (last_span_end..boundary)
            .rev()
            .find(|&x| classes[x] == Class::Verb && lens[x] >= 1)
            .map(|x| views[x..x + lens[x].max(1)].iter().map(|v| v.norm.clone()).collect::<Vec<_>>().join(" "));

        // The kind follows the verb that introduced the first transmitter:
        // `قال وبلغني عن X` is a citation, whatever قال is.
        let opening_group = spans
            .first()
            .and_then(|(a, _, _)| (i..*a).rev().find(|&x| classes[x] == Class::Verb).and_then(|x| groups[x]))
            .unwrap_or(opening_group);
        let (kind, needed) = if opening_group == Group::Citation { (Kind::Citation, 1) } else { (Kind::Isnad, params.min_links.max(1)) };
        if links < needed {
            i += lens[i].max(1);
            continue;
        }

        let tok_end = boundary.max(i + 1);

        // The matn: from the boundary to the next chain start, marker, heading or page end.
        let matn = if boundary < n && classes[boundary] != Class::Boundary {
            let b = boundary;
            let next_marker = markers.iter().copied().find(|&m| m > b);
            let next_heading = headings.iter().map(|h| h.0).filter(|&h| h > b).min();
            let next_chain = (b + 1..n).find(|&x| classes[x] == Class::Verb && chain_would_open(x, &classes, &groups, &lens, params, k));
            let end = [next_marker, next_heading, next_chain].into_iter().flatten().min().unwrap_or(n);
            if end > b { Some((b, end)) } else { None }
        } else {
            None
        };

        let chain_len = (tok_end - i).max(1);
        let name_tokens: usize = spans.iter().map(|s| s.1 - s.0).sum();
        let noun_prop = spans.iter().map(|s| (s.0..s.1).filter(|&x| views[x].pos == "noun_prop").count()).sum::<usize>();
        let conf = confidence(
            links,
            if name_tokens > 0 { noun_prop as f64 / name_tokens as f64 } else { 0.0 },
            matn.map(|(b, _)| is_terminal(views, b, closing_verb.as_deref())).unwrap_or(false),
            1.0 - (noise as f64 / chain_len as f64).min(1.0),
        );

        if conf.total >= params.min_confidence {
            let transmitters = spans
                .iter()
                .enumerate()
                .map(|(pos, (a, b, verb))| TransmitterSpan {
                    position: pos,
                    tok_start: *a,
                    tok_end: *b,
                    raw: views[*a..*b].iter().map(|v| v.surface.clone()).collect::<Vec<_>>().join(" "),
                    parts: names::parse(&views[*a..*b].iter().map(|v| v.norm.clone()).collect::<Vec<_>>()),
                    verb_before: verb.clone(),
                })
                .collect();
            out.push(Candidate {
                tok_start: i,
                tok_end,
                kind,
                group: opening_group,
                links,
                matn,
                transmitters,
                confidence: conf,
                classes: (i..tok_end).map(|x| (x, classes[x])).collect(),
            });
        }
        // Resume at the boundary: a matn may hold a chain of its own.
        i = tok_end.max(i + 1);
    }
    out
}

/// Would a chain opened at `x` be emitted? A cheap look: a Name within the
/// lookahead of the verb. Used only to end a matn at "another chain start".
fn chain_would_open(x: usize, classes: &[Class], groups: &[Option<Group>], lens: &[usize], params: &Params, k: usize) -> bool {
    if !groups[x].map(|g| params.groups.contains(&g)).unwrap_or(false) {
        return false;
    }
    let from = x + lens[x].max(1);
    classes[from..(from + k).min(classes.len())].iter().any(|c| *c == Class::Name)
}

/// Whether `lens` says token `i` is the continuation of a multi-token match
/// starting earlier (then it is not a chain start of its own).
fn lens_covers(lens: &[usize], i: usize) -> bool {
    (i.saturating_sub(4)..i).any(|s| s + lens[s] > i)
}

pub fn confidence(links: usize, noun_prop: f64, terminal: bool, clean: f64) -> Confidence {
    let l = (links.min(5) as f64) / 5.0;
    let t = if terminal { 1.0 } else { 0.0 };
    let total = 0.35 * l + 0.15 * noun_prop + 0.25 * t + 0.25 * clean;
    Confidence { links: l, noun_prop, terminal: t, clean, total }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `surface/pos` words → views; a bare word is a `noun`.
    fn views(s: &str) -> Vec<View> {
        s.split_whitespace()
            .map(|w| {
                let (sf, pos) = w.split_once('/').unwrap_or((w, "noun"));
                View { surface: sf.to_string(), norm: normalize_arabic(sf), pos: pos.to_string() }
            })
            .collect()
    }

    fn run(s: &str) -> Vec<Candidate> {
        extract_views(&views(s), &[], &[], &Lexicon::shipped(), &Params::default(), &HashMap::new())
    }

    #[test]
    fn classes_follow_the_spec_order_and_position_beats_pos() {
        let v = views("حدثنا/verb ابو داود السجستاني قال/verb نا/verb محمد بن السكن الابلي/adj قال/verb رايت/verb في/prep كتاب");
        let (c, g, _) = classify(&v, &Lexicon::shipped(), &Params::default(), &HashMap::new(), &[]);
        assert_eq!(c[0], Class::Verb);
        assert_eq!(g[0], Some(Group::Core));
        assert_eq!(c[1], Class::Connect, "ابو is a connector");
        assert_eq!(c[2], Class::Name, "داود follows a connector: position beats POS");
        assert_eq!(c[3], Class::Connect, "an ال-noun after a name continues it");
        assert_eq!(c[6], Class::Name);
        assert_eq!(c[7], Class::Connect);
        assert_eq!(c[8], Class::Name);
        assert_eq!(c[9], Class::Connect);
        assert_eq!(c[11], Class::Other, "رايت is not in the lexicon");
        assert_eq!(c[12], Class::Other);
        assert_eq!(c[13], Class::Other, "كتاب after a preposition is not a name");
    }

    #[test]
    fn formulae_are_transparent_and_a_proclitic_is_tolerated() {
        let v = views("وحدثنا/verb ابو بكر رحمه/verb الله عن/prep عائشة رضي/verb الله عنها/prep قالت/verb");
        let (c, _, lens) = classify(&v, &Lexicon::shipped(), &Params::default(), &HashMap::new(), &[]);
        assert_eq!(c[0], Class::Verb, "وحدثنا matches حدثنا");
        assert_eq!(c[3], Class::Formula);
        assert_eq!(c[4], Class::Formula);
        assert_eq!(lens[3], 2);
        assert_eq!(c[5], Class::Connect);
        assert_eq!(c[6], Class::Name);
        assert_eq!(c[7], Class::Formula);
        assert_eq!(c[10], Class::Verb);
    }

    #[test]
    fn a_plain_chain_yields_transmitters_links_and_a_matn() {
        // Abū Dāwūd, al-Zuhd, page 2 (sample corpus), with the matn shortened.
        let c = run("حدثنا/verb ابو داود السجستاني قال/verb نا/verb محمد بن السكن الابلي/adj قال/verb نا/verb سعيد بن عامر قال/verb نا/verb هشام صاحب الدستوائي قال/verb رايت/verb في/prep كتاب بلغني/verb انه/conj من/prep كلام عيسي ابن مريم");
        assert_eq!(c.len(), 1, "{:?}", c.iter().map(|x| (x.tok_start, x.tok_end, x.links)).collect::<Vec<_>>());
        let x = &c[0];
        assert_eq!(x.kind, Kind::Isnad);
        assert_eq!(x.links, 4);
        let spans: Vec<(usize, usize)> = x.transmitters.iter().map(|t| (t.tok_start, t.tok_end)).collect();
        assert_eq!(spans, vec![(1, 4), (6, 10), (12, 15), (17, 20)]);
        assert_eq!(x.transmitters[1].raw, "محمد بن السكن الابلي");
        assert_eq!(x.transmitters[1].parts.ism.as_deref(), Some("محمد"));
        assert_eq!(x.transmitters[1].parts.nasab.as_deref(), Some("بن السكن"));
        assert_eq!(x.transmitters[1].parts.nisba.as_deref(), Some("الابلي"));
        assert_eq!(x.transmitters[1].verb_before.as_deref(), Some("نا"));
        assert_eq!(x.transmitters[0].verb_before.as_deref(), Some("حدثنا"));
        assert_eq!(x.tok_start, 0);
        assert_eq!(x.tok_end, 21, "the chain ends after the verb that closes its last transmitter");
        // رأيت في كتاب بلغني: the lookahead sees بلغني and keeps the chain
        // alive, but nothing after هشام is a name, so the matn starts at رأيت.
        assert_eq!(x.matn, Some((21, 31)), "the matn runs from the boundary to the page end");
        assert!(x.confidence.terminal > 0.0, "… قال <matn> is a terminal pattern");
        assert!(x.confidence.total >= 0.5);
    }

    #[test]
    fn the_lookahead_decides_between_noise_and_the_boundary() {
        // ان محمدا العنقزي حدثهم: ان is OTHER but a NAME/VERB follows within 3.
        let c = run("حدثنا/verb ابو داود قال/verb نا/verb الهيثم بن خالد الجهني ان/conj محمدا العنقزي حدثهم/verb قال/verb انا/pron يونس بن ابي اسحاق عن/prep عمار الدهني/adj عن/prep وهب بن منبه قال/verb اني/conj اجد/verb في/prep كتاب الله");
        assert_eq!(c.len(), 1);
        let x = &c[0];
        // Five, not six: محمدا follows أنّ, which is OTHER, so by §4.2's
        // position rule it is noise, not a NAME — a known miss pattern
        // (`أنَّ فلاناً حدثهم`) recorded in the Phase 2 report.
        assert_eq!(x.links, 5, "{:?}", x.transmitters.iter().map(|t| &t.raw).collect::<Vec<_>>());
        assert!(x.transmitters.iter().all(|t| t.raw != "محمدا العنقزي"));
        assert_eq!(x.transmitters[2].raw, "يونس بن ابي اسحاق");
        assert_eq!(x.transmitters[2].verb_before.as_deref(), Some("انا"));
        assert_eq!(x.transmitters[3].verb_before.as_deref(), Some("عن"));
        assert_eq!(x.matn.map(|m| m.0), Some(27));
        assert!(x.confidence.clean < 1.0, "the noise token counts against cleanliness");
    }

    #[test]
    fn a_lone_verb_in_prose_opens_nothing() {
        // A pronoun أنا in running prose, no name after it.
        assert!(run("ثم/adv قال/verb انا/pron لا/part اعرف/verb ذلك/pron").is_empty());
        // Two verbs and one name: one link, below min_links.
        assert!(run("قال/verb محمد ان/conj الامر/noun كذلك/adv").is_empty());
    }

    #[test]
    fn min_links_is_a_parameter_and_citations_need_one() {
        let text = "قال/verb محمد بن سعيد ان/conj الامر كذلك/adv";
        let mut p = Params::default();
        p.min_links = 1;
        let c = extract_views(&views(text), &[], &[], &Lexicon::shipped(), &p, &HashMap::new());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, Kind::Isnad);
        // A citation-group verb opens a citation with one link, by default.
        let c = run("بلغني/verb ان/conj محمد بن سيرين قال/verb لا/part باس/noun به/prep");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, Kind::Citation);
        assert_eq!(c[0].group, Group::Citation);
    }

    #[test]
    fn a_disabled_group_is_invisible() {
        let mut p = Params::default();
        p.groups = vec![Group::Core];
        let c = extract_views(&views("بلغني/verb ان/conj محمد بن سيرين قال/verb لا/part باس/noun به/prep"), &[], &[], &Lexicon::shipped(), &p, &HashMap::new());
        assert!(c.is_empty());
    }

    #[test]
    fn a_heading_ends_a_chain_and_a_marker_ends_a_matn() {
        // Tokens: 0 حدثنا … 10 عليا 11 يقول 12 الحمد 13 لله | 14 باب 15 الصلاة (heading) |
        // 16 حدثنا 17 ابو 18 بكر 19 عن 20 مالك 21 قال 22 كان … 26 حديث (marker) 27 اخر
        let v = views("حدثنا/verb ابو داود قال/verb نا/verb محمد بن سعيد قال/verb سمعت/verb عليا يقول/verb الحمد لله باب الصلاة حدثنا/verb ابو بكر عن/prep مالك قال/verb كان/verb النبي يصلي/verb كذا حديث اخر");
        let c = extract_views(&v, &[(14, 16)], &[26], &Lexicon::shipped(), &Params::default(), &HashMap::new());
        assert_eq!(c.len(), 2, "{:?}", c.iter().map(|x| (x.tok_start, x.tok_end, x.matn)).collect::<Vec<_>>());
        // يقول is not a lexicon verb, so the matn starts there (§4.2: "the
        // matn starts at this OTHER") and stops at the heading.
        assert_eq!(c[0].matn, Some((11, 14)), "the first matn stops at the heading");
        assert_eq!(c[1].tok_start, 16);
        assert_eq!(c[1].links, 2);
        assert_eq!(c[1].matn, Some((22, 26)), "the second matn stops at the ḥadīth-number marker");
    }

    #[test]
    fn overrides_retag_a_token() {
        let mut ov = HashMap::new();
        // Make كتب a transmission verb for this run: the chain grows a link.
        ov.insert(9, Class::Verb);
        let text = "حدثنا/verb ابو داود قال/verb نا/verb محمد بن سعيد قال/verb كتب/verb فلان الينا/prep بذلك";
        let base = run(text);
        let with = extract_views(&views(text), &[], &[], &Lexicon::shipped(), &Params::default(), &ov);
        assert_eq!(base[0].links, 2);
        assert_eq!(with[0].links, 3, "{:?}", with[0].transmitters.iter().map(|t| &t.raw).collect::<Vec<_>>());
    }

    #[test]
    fn markers_are_found_at_line_starts_only() {
        let body = "قال رسول الله\n12 - حدثنا ابو بكر\nنص 3 - ليس علامة\n٤ – حدثنا عمر";
        // Tokens: قال(0) رسول(1) الله(2) | حدثنا(3) ابو(4) بكر(5) | نص(6) ليس(7) علامة(8) | حدثنا(9) عمر(10)
        assert_eq!(hadith_markers(body), vec![3, 9]);
    }

    #[test]
    fn confidence_is_monotone_in_each_component() {
        let a = confidence(2, 0.0, false, 1.0);
        let b = confidence(4, 0.0, false, 1.0);
        assert!(b.total > a.total);
        assert!(confidence(2, 0.5, false, 1.0).total > a.total);
        assert!(confidence(2, 0.0, true, 1.0).total > a.total);
        assert!(confidence(2, 0.0, false, 0.5).total < a.total);
        assert!(confidence(5, 1.0, true, 1.0).total <= 1.0 + 1e-9);
    }
}
