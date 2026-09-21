//! Name-search pattern expansion, as the app shows it and as the index
//! wants it.
//!
//! The form generates a short list of patterns for display — a kunya shown
//! as `اب* منصور`, no proclitics — and the search needs the long one: each
//! `اب*` as the three written forms ابو / ابا / ابي, then every pattern
//! with each of the five proclitics و ف ب ل ك on its first word. That is
//! about fifteen search patterns per displayed one, and a request carrying
//! the long list for a page's highlights ran past 2 KB of URL. The
//! expansion lives here, once, and every route that takes name patterns —
//! `/search/name`, the `/page` bundle, `/page/matches/name`, the desktop
//! commands — expands the short list the same way, so the highlights on a
//! page are the search's own.
//!
//! The rule mirrors `src/utils/namePatterns.ts` (`getKunyaVariants`,
//! `expandWithProclitics`); `expand_patterns` on the display patterns must
//! equal `generateSearchPatterns` as a set, and a fixture holds both apps
//! to it.

use crate::normalize::normalize_arabic;

/// The proclitics attached to a pattern's first word, in the app's order.
pub const PROCLITICS: [&str; 5] = ["و", "ف", "ب", "ل", "ك"];
/// The three written forms a displayed `اب*` stands for.
pub const KUNYA_FORMS: [&str; 3] = ["ابو", "ابا", "ابي"];
/// How the display collapses a kunya.
pub const KUNYA_MARK: &str = "اب*";

/// The written forms of one displayed pattern: three for a kunya, else itself.
fn kunya_forms(pattern: &str) -> Vec<String> {
    match pattern.strip_prefix(KUNYA_MARK).and_then(|rest| rest.strip_prefix(' ')) {
        Some(base) if !base.trim().is_empty() => KUNYA_FORMS.iter().map(|k| format!("{} {}", k, base)).collect(),
        _ => vec![pattern.to_string()],
    }
}

/// A pattern and the five with a proclitic on its first word.
fn with_proclitics(pattern: &str) -> Vec<String> {
    let mut words = pattern.split_whitespace();
    let Some(first) = words.next() else { return vec![pattern.to_string()] };
    let rest: Vec<&str> = words.collect();
    let rest = if rest.is_empty() { String::new() } else { format!(" {}", rest.join(" ")) };
    let mut out = Vec::with_capacity(6);
    out.push(pattern.to_string());
    for p in PROCLITICS {
        out.push(format!("{}{}{}", p, first, rest));
    }
    out
}

/// The search patterns for the displayed ones: normalised, each kunya in
/// its three forms, each with its proclitics, no pattern twice, in order.
pub fn expand_patterns(display: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in display {
        let normalized = normalize_arabic(raw.trim());
        if normalized.is_empty() {
            continue;
        }
        for form in kunya_forms(&normalized) {
            for p in with_proclitics(&form) {
                if seen.insert(p.clone()) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// The same for several forms at once (a name search's forms).
pub fn expand_forms(display: &[Vec<String>]) -> Vec<Vec<String>> {
    display.iter().map(|f| expand_patterns(f)).collect()
}

/// Normalised words of a pattern.
fn words(pattern: &str) -> Vec<String> {
    normalize_arabic(pattern.trim()).split_whitespace().map(|s| s.to_string()).collect()
}

fn contains_run(hay: &[String], needle: &[String]) -> bool {
    !needle.is_empty() && hay.len() >= needle.len() && hay.windows(needle.len()).any(|w| w == needle)
}

/// The patterns worth retrieving on: every pattern that contains another of
/// the list as a run of words is dropped, since a page that has the longer
/// has the shorter, and the shorter alone finds the same pages. Order is
/// kept; a pattern is never dropped for one equal to it. Highlights still
/// want the whole list — the longer pattern marks the words the shorter
/// does not.
pub fn minimal_patterns(patterns: &[String]) -> Vec<String> {
    let ws: Vec<Vec<String>> = patterns.iter().map(|p| words(p)).collect();
    patterns
        .iter()
        .enumerate()
        .filter(|(i, _)| !ws.iter().enumerate().any(|(j, other)| j != *i && other != &ws[*i] && contains_run(&ws[*i], other)))
        .map(|(_, p)| p.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_kunya_becomes_three_forms_each_with_its_proclitics() {
        let out = expand_patterns(&s(&["اب* منصور"]));
        assert_eq!(out.len(), 18);
        assert_eq!(out[0], "ابو منصور");
        assert_eq!(out[1], "وابو منصور");
        assert_eq!(out[6], "ابا منصور");
        assert_eq!(out[12], "ابي منصور");
        assert!(out.contains(&"كابي منصور".to_string()));
    }

    #[test]
    fn a_plain_pattern_gets_only_its_proclitics_on_the_first_word() {
        let out = expand_patterns(&s(&["احمد بن زياد"]));
        assert_eq!(out, s(&["احمد بن زياد", "واحمد بن زياد", "فاحمد بن زياد", "باحمد بن زياد", "لاحمد بن زياد", "كاحمد بن زياد"]));
    }

    #[test]
    fn repeats_and_blanks_are_dropped_and_input_is_normalised() {
        let out = expand_patterns(&s(&["أحمد", " ", "احمد"]));
        assert_eq!(out.len(), 6);
        assert_eq!(out[0], "احمد");
    }

    #[test]
    fn a_pattern_containing_another_is_not_retrieved_on() {
        let out = minimal_patterns(&s(&["ابو منصور معمر", "ابو منصور معمر بن احمد", "معمر بن احمد", "بن احمد الاصبهاني", "معمر"]));
        // "معمر" is inside the first three; "بن احمد الاصبهاني" contains none of the others.
        assert_eq!(out, s(&["بن احمد الاصبهاني", "معمر"]));
        // Equal patterns both stay; nothing is dropped for itself.
        assert_eq!(minimal_patterns(&s(&["احمد", "احمد"])), s(&["احمد", "احمد"]));
        // A run, not a subsequence: "ابو احمد" is not inside "ابو منصور احمد".
        assert_eq!(minimal_patterns(&s(&["ابو منصور احمد", "ابو احمد"])).len(), 2);
    }

    #[test]
    fn matches_the_app_s_own_expansion() {
        // Written by engine/tests/fixtures/write_name_expansion.ts from
        // src/utils/namePatterns.ts: display patterns and the search
        // patterns the app used to send, per form.
        let raw = include_str!("../tests/fixtures/name_expansion.json");
        let cases: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let display: Vec<String> = case["display"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let expected: std::collections::BTreeSet<String> = case["search"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let got: std::collections::BTreeSet<String> = expand_patterns(&display).into_iter().collect();
            assert_eq!(got, expected, "form {}", case["label"]);
        }
    }
}
