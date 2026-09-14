//! The alignment contract (Lab spec §3.3).
//!
//! Every span Lab stores is addressed by token index, and those indices must
//! be the ones the frontend computes from the page body it renders — otherwise
//! a highlight lands on the wrong word and an annotation saved today points
//! somewhere else tomorrow. This module is a port of
//! `packages/kashshaf-shared/src/utils/arabicTokenizer.ts`
//! (`buildCharToTokenMap` / `getTokenCount` over `stripHtml`), so the
//! invariant can be checked in Rust against real pages.
//!
//! The TypeScript walks UTF-16 code units and this walks `char`s. They differ
//! only on astral characters, where TS sees two surrogates and Rust sees one
//! `char`; neither is an Arabic letter, a tashkil mark or a stripped
//! character, so both are word boundaries and the counts agree. Every
//! character the two actually branch on is in the BMP.
//!
//! The rules themselves are the pipeline's: `strip_punct`, `strip_latin` and
//! `strip_digits` run *before* tokenization there, so a stripped character
//! never ends a word — it is skipped, and the word continues through it.

/// Punctuation the pipeline strips (`PUNCT_SYMBOLS` in the TypeScript).
const PUNCT: &[char] = &[
    '.', ',', '،', ':', ';', '!', '?', '؟', '؛', '«', '»', '"', '\u{201C}', '\u{201D}', '\'',
    '\u{2018}', '\u{2019}', '(', ')', '[', ']', '{', '}', '⦗', '⦘', '﴾', '﴿', '/', '\\', '–', '—',
    '-', '_', '…', '·', '•', '●', '○', '◦', '۔', '؍', '٫', '٬', '٭', '±', '×', '÷', '=', '≠', '<',
    '>', '≤', '≥', '∞', '∑', '∏', '√', '∫', '∂', '∇', '¡', '¿', '†', '‡', '§', '¶', '©', '®', '™',
    '°', '′', '″', '‴',
];

fn is_punct(c: char) -> bool {
    PUNCT.contains(&c)
}

fn is_latin_letter(c: char) -> bool {
    matches!(c, 'A'..='Z' | 'a'..='z' | '\u{00C0}'..='\u{024F}' | '\u{1E00}'..='\u{1EFF}')
}

fn is_digit(c: char) -> bool {
    matches!(c, '0'..='9' | '\u{0660}'..='\u{0669}' | '\u{06F0}'..='\u{06F9}')
}

/// Stripped before tokenization, so it neither starts nor ends a word.
pub fn should_skip(c: char) -> bool {
    is_punct(c) || is_latin_letter(c) || is_digit(c)
}

/// Tashkil and the superscript alef: part of the current word, never a token.
pub fn is_tashkil(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}')
}

/// An Arabic letter for word-boundary purposes (tashkil excluded).
pub fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0600}'..='\u{06FF}' | '\u{0750}'..='\u{077F}' | '\u{08A0}'..='\u{08FF}')
        && !is_tashkil(c)
}

/// Strip HTML the way the frontend does: `<br>` becomes a newline, every other
/// tag is removed with nothing in its place. A `<title>` flush against the
/// next word therefore merges with it — which is what the pipeline does too,
/// verified over every page of the sample corpus.
pub fn strip_html(html: &str) -> String {
    let chars: Vec<char> = html.chars().collect();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            // An unclosed '<' is literal text: the JavaScript regex `<[^>]*>`
            // needs a '>' to match.
            match chars[i + 1..].iter().position(|&c| c == '>') {
                Some(rel) => {
                    let tag: String = chars[i + 1..i + 1 + rel].iter().collect();
                    if is_br(&tag) {
                        out.push('\n');
                    }
                    i += rel + 2;
                }
                None => {
                    out.push(chars[i]);
                    i += 1;
                }
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// The one tag the frontend replaces rather than deletes: `<br\s*\/?>`, any case.
fn is_br(tag: &str) -> bool {
    tag.trim_end_matches('/').trim_end().eq_ignore_ascii_case("br")
}

/// Token index for each `char` of `text`, or `None` where no token owns it.
/// The Rust analogue of `buildCharToTokenMap`; indices are by `char`, so pair
/// it with `text.chars()`, not with byte offsets.
pub fn char_to_token_map(text: &str) -> Vec<Option<usize>> {
    let mut map = Vec::with_capacity(text.len());
    let mut current = 0usize;
    let mut in_word = false;
    for c in text.chars() {
        if should_skip(c) {
            map.push(None);
            continue;
        }
        if is_arabic_letter(c) || is_tashkil(c) {
            map.push(Some(current));
            in_word = true;
        } else {
            map.push(None);
            if in_word {
                current += 1;
                in_word = false;
            }
        }
    }
    map
}

/// How many tokens the frontend will find in this page body — the number
/// `Page.tokens.len()` must equal (spec §3.3).
pub fn display_token_count(body: &str) -> usize {
    char_to_token_map(&strip_html(body))
        .iter()
        .flatten()
        .max()
        .map(|m| m + 1)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same fixtures as
    /// `packages/kashshaf-shared/src/utils/arabicTokenizer.test.ts`. Both
    /// sides of the contract must give the same answers to the same inputs,
    /// so the two lists are kept identical on purpose.
    #[test]
    fn counts_match_the_typescript_fixtures() {
        let cases: &[(&str, usize)] = &[
            ("", 0),
            ("كتاب", 1),
            ("قال رسول الله", 3),
            ("  قال   رسول \n\n الله  ", 3),
            ("قَالَ رَسُولُ اللَّهِ", 3),
            ("هَٰذَا", 1),
            ("كتا.ب", 1),
            ("قال، رسول", 2),
            ("كتا5ب", 1),
            ("كتا٥ب", 1),
            ("كتاxب", 1),
            ("قال 123 رسول", 2),
            ("قال abc رسول", 2),
            ("قال ، رسول", 2),
            ("عبد-الله", 1),
            ("﴿الحمد لله﴾", 2),
        ];
        for (text, expected) in cases {
            assert_eq!(display_token_count(text), *expected, "{:?}", text);
        }
    }

    #[test]
    fn a_tag_is_removed_with_nothing_in_its_place() {
        assert_eq!(display_token_count("<title id=\"1\" parent=\"0\">باب الإيمان</title>قال رسول"), 3);
        assert_eq!(display_token_count("<title id=\"1\" parent=\"0\">باب الإيمان</title>\nقال رسول"), 4);
        assert_eq!(display_token_count("نص\n<title id=1 parent=0> باب الإيمان</title>\nقال رسول"), 5);
    }

    #[test]
    fn br_becomes_a_newline_and_so_a_boundary() {
        assert_eq!(strip_html("قال<br/>رسول"), "قال\nرسول");
        assert_eq!(strip_html("قال<BR>رسول"), "قال\nرسول");
        assert_eq!(strip_html("قال<br />رسول"), "قال\nرسول");
        assert_eq!(display_token_count("قال<br/>رسول"), 2);
    }

    #[test]
    fn an_unclosed_angle_bracket_stays_literal() {
        assert_eq!(strip_html("قال < رسول"), "قال < رسول");
        // '<' is in the stripped-punctuation set, so it is skipped, not a
        // boundary: the two words merge exactly as they do in the frontend.
        assert_eq!(display_token_count("قال<رسول"), 1);
    }

    #[test]
    fn the_map_agrees_with_the_typescript_map() {
        assert_eq!(
            char_to_token_map("قال رسول"),
            vec![Some(0), Some(0), Some(0), None, Some(1), Some(1), Some(1), Some(1)]
        );
        assert_eq!(char_to_token_map("كتا.ب"), vec![Some(0), Some(0), Some(0), None, Some(0)]);
        assert_eq!(display_token_count("قال "), 1);
        assert_eq!(display_token_count("قال"), 1);
    }
}
