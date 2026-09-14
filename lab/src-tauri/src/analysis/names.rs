//! Transmitter name segmentation (Lab spec §4.2, "Transmitter segmentation").
//!
//! A port of the structure `src/utils/namePatterns.ts` encodes for name
//! search — kunya (`أبو X`), ism, nasab (`بن …` chain, up to 3), nisba
//! (trailing `ال`-adjectives), plus laqab/title — applied in the other
//! direction: from a span of tokens to its parts. Kashshaf's name search
//! matches the same structure, so a transmitter parsed here can be searched
//! there.
//!
//! Everything works on normalized surfaces (the engine's `normalize_arabic`),
//! so `أبو`/`ابو`, `ابن`/`بن` and tashkil never make two forms of one name.

use kashshaf_engine::normalize_arabic;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameParts {
    pub kunya: Option<String>,
    pub ism: Option<String>,
    pub nasab: Option<String>,
    pub nisba: Option<String>,
    pub laqab: Option<String>,
}

/// The kunya heads Kashshaf's name search treats as one (`getKunyaVariants`).
pub const KUNYA_HEADS: [&str; 3] = ["ابو", "ابا", "ابي"];
/// Feminine kunya.
pub const KUNYA_HEADS_F: [&str; 1] = ["ام"];
/// Nasab connectors (`getNasabParts`), plus the `ابن` spelling.
pub const NASAB: [&str; 4] = ["بن", "ابن", "بنت", "ابنة"];
/// First halves of compound isms that are one name: عبد الله, عبد الرحمن …
const COMPOUND_HEADS: [&str; 3] = ["عبد", "ذو", "ذي"];
/// Second halves of `X الدين`-type laqabs.
const LAQAB_TAILS: [&str; 6] = ["الدين", "الملك", "الدولة", "الاسلام", "الملة", "الحق"];
/// Titles that precede a name and are not part of it.
const TITLES: [&str; 10] = ["الشيخ", "الحافظ", "الامام", "السيد", "المولي", "القاضي", "الفقيه", "العلامة", "المحدث", "الاستاذ"];

fn is_kunya_head(w: &str) -> bool {
    KUNYA_HEADS.contains(&w) || KUNYA_HEADS_F.contains(&w)
}

fn is_nasab(w: &str) -> bool {
    NASAB.contains(&w)
}

fn has_al(w: &str) -> bool {
    w.starts_with("ال") && w.chars().count() > 3
}

/// Parse a transmitter span, given as its tokens' surfaces in order.
pub fn parse(surfaces: &[String]) -> NameParts {
    let w: Vec<String> = surfaces.iter().map(|s| normalize_arabic(s)).filter(|s| !s.is_empty()).collect();
    let mut parts = NameParts::default();
    let mut i = 0;

    // Leading titles: الشيخ الحافظ أبو … — kept as laqab, not as the name.
    let mut titles = Vec::new();
    while i < w.len() && TITLES.contains(&w[i].as_str()) {
        titles.push(w[i].clone());
        i += 1;
    }

    // Kunya: أبو X (X may itself be compound: أبو عبد الله).
    if i + 1 < w.len() && is_kunya_head(&w[i]) {
        let head = w[i].clone();
        let (name, used) = take_name(&w, i + 1);
        parts.kunya = Some(format!("{} {}", head, name));
        i += 1 + used;
    }

    // Ism: the next name unless a nasab connector comes first (أبو X بن Y).
    if i < w.len() && !is_nasab(&w[i]) && !has_al(&w[i]) {
        let (name, used) = take_name(&w, i);
        parts.ism = Some(name);
        i += used;
    }

    // Nasab: up to three بن X links (نسب beyond that is kept out, as the
    // search does).
    let mut nasab = Vec::new();
    while i + 1 < w.len() && is_nasab(&w[i]) && nasab.len() < 3 {
        let connector = if w[i] == "بنت" || w[i] == "ابنة" { "بنت" } else { "بن" };
        let (name, used) = take_name(&w, i + 1);
        nasab.push(format!("{} {}", connector, name));
        i += 1 + used;
    }
    if !nasab.is_empty() {
        parts.nasab = Some(nasab.join(" "));
    }

    // Laqab: X الدين when it reads as a title; then trailing nisbas.
    let mut nisbas = Vec::new();
    let mut laqab = titles;
    while i < w.len() {
        if i + 1 < w.len() && LAQAB_TAILS.contains(&w[i + 1].as_str()) && !has_al(&w[i]) {
            laqab.push(format!("{} {}", w[i], w[i + 1]));
            i += 2;
        } else if has_al(&w[i]) || TITLES.contains(&w[i].as_str()) {
            nisbas.push(w[i].clone());
            i += 1;
        } else {
            // Something the structure does not place (a second ism, noise);
            // fold it into the ism so nothing is lost.
            match parts.ism.as_mut() {
                Some(ism) if parts.nasab.is_none() => {
                    ism.push(' ');
                    ism.push_str(&w[i]);
                }
                _ => nisbas.push(w[i].clone()),
            }
            i += 1;
        }
    }
    if !nisbas.is_empty() {
        parts.nisba = Some(nisbas.join(" "));
    }
    if !laqab.is_empty() {
        parts.laqab = Some(laqab.join(" "));
    }
    parts
}

/// One name starting at `i`: a compound (عبد الله, ذو النون) or one word.
/// Returns `(name, tokens used)`.
fn take_name(w: &[String], i: usize) -> (String, usize) {
    if i + 1 < w.len() && COMPOUND_HEADS.contains(&w[i].as_str()) && !is_nasab(&w[i + 1]) {
        return (format!("{} {}", w[i], w[i + 1]), 2);
    }
    // A kunya inside a nasab: بن أبي بكر.
    if i + 1 < w.len() && is_kunya_head(&w[i]) {
        let (inner, used) = take_name(w, i + 1);
        return (format!("{} {}", w[i], inner), 1 + used);
    }
    (w[i].clone(), 1)
}

/// The normalized form of a whole span, as `name_form.form_norm` stores it
/// (spec §6.3): the engine's normalization, then the kunya heads and the
/// two spellings of `بن` unified, so `أبو بكر بن أبي شيبة` and
/// `ابي بكر ابن ابي شيبة` are one form.
pub fn form_norm(raw: &str) -> String {
    normalize_arabic(raw)
        .split_whitespace()
        .map(|t| match t {
            "ابا" | "ابي" => "ابو",
            "ابن" => "بن",
            "ابنة" => "بنت",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> NameParts {
        parse(&s.split_whitespace().map(String::from).collect::<Vec<_>>())
    }

    #[test]
    fn kunya_ism_nasab_nisba() {
        let n = p("أبو بكر محمد بن أحمد بن زياد الأصبهاني");
        assert_eq!(n.kunya.as_deref(), Some("ابو بكر"));
        assert_eq!(n.ism.as_deref(), Some("محمد"));
        assert_eq!(n.nasab.as_deref(), Some("بن احمد بن زياد"));
        assert_eq!(n.nisba.as_deref(), Some("الاصبهاني"));
        assert_eq!(n.laqab, None);
    }

    #[test]
    fn compound_names_stay_whole() {
        let n = p("عبد الله بن عمر الصفار");
        assert_eq!(n.ism.as_deref(), Some("عبد الله"));
        assert_eq!(n.nasab.as_deref(), Some("بن عمر"));
        assert_eq!(n.nisba.as_deref(), Some("الصفار"));
        let n = p("أبو عبد الله محمد");
        assert_eq!(n.kunya.as_deref(), Some("ابو عبد الله"));
        assert_eq!(n.ism.as_deref(), Some("محمد"));
    }

    #[test]
    fn kunya_directly_followed_by_nasab() {
        let n = p("أبو الحسن بن أبي بكر");
        assert_eq!(n.kunya.as_deref(), Some("ابو الحسن"));
        assert_eq!(n.ism, None);
        assert_eq!(n.nasab.as_deref(), Some("بن ابي بكر"));
    }

    #[test]
    fn nasab_is_capped_at_three_links_and_ibn_is_bin() {
        let n = p("أحمد بن محمد بن هانئ بن عبد الله بن زيد الأثرم");
        // ئ folds to ي under the engine normalization.
        assert_eq!(n.nasab.as_deref(), Some("بن محمد بن هاني بن عبد الله"));
        let n = p("ابن عباس");
        assert_eq!(n.ism, None);
        assert_eq!(n.nasab.as_deref(), Some("بن عباس"));
        let n = p("عائشة بنت أبي بكر");
        assert_eq!(n.nasab.as_deref(), Some("بنت ابي بكر"));
    }

    #[test]
    fn titles_and_laqabs() {
        let n = p("الشيخ الحافظ أبو الحسن بن أبي بكر");
        assert_eq!(n.laqab.as_deref(), Some("الشيخ الحافظ"));
        assert_eq!(n.kunya.as_deref(), Some("ابو الحسن"));
        let n = p("أحمد نظام الدين");
        assert_eq!(n.ism.as_deref(), Some("احمد"));
        assert_eq!(n.laqab.as_deref(), Some("نظام الدين"));
        let n = p("أبو هريرة بن الحافظ شمس الدين الذهبي");
        assert_eq!(n.kunya.as_deref(), Some("ابو هريرة"));
        assert_eq!(n.nasab.as_deref(), Some("بن الحافظ"));
        assert_eq!(n.laqab.as_deref(), Some("شمس الدين"));
        assert_eq!(n.nisba.as_deref(), Some("الذهبي"));
    }

    #[test]
    fn a_two_word_ism_without_structure_is_kept() {
        let n = p("محمد أمين الاسترابادي");
        assert_eq!(n.ism.as_deref(), Some("محمد امين"));
        assert_eq!(n.nisba.as_deref(), Some("الاسترابادي"));
    }

    #[test]
    fn form_norm_unifies_the_search_variants() {
        assert_eq!(form_norm("أبو بكر بن أبي شيبة"), form_norm("ابي بكر ابن ابي شيبة"));
        assert_eq!(form_norm("عَبْدُ اللهِ"), "عبد الله");
        assert_ne!(form_norm("محمد بن سعيد"), form_norm("محمد بن سعد"));
    }
}
