//! The snippet a search row carries instead of the page's whole body
//! (audit finding 4): up to fifty tokens of the page around the first
//! highlight, the highlight at most five tokens in.
//!
//! The cut is made in tokens, with the tokenizer the apps use to map
//! characters to token indices (`packages/kashshaf-shared/src/utils/
//! arabicTokenizer.ts`, itself held to the pipeline's): `char_to_token`
//! and `snippet_range` are ports of `buildCharToTokenMap` and
//! `getSnippetRange`, and `engine/tests/fixtures/tokenizer.json`, written
//! from the TypeScript, holds them to it. A row says where its snippet
//! starts (`snippet_start_token`), so a client rebuilds the same map on the
//! snippet and shifts the page's highlight indices by that much; the
//! indices themselves stay the page's, as the reader needs them.

/// Tokens a snippet holds at most, and how far in the first highlight may sit.
pub const SNIPPET_TOKENS: usize = 50;
pub const SNIPPET_MAX_FROM_START: usize = 5;

fn is_arabic_range(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF)
}

fn is_tashkil(c: char) -> bool {
    matches!(c as u32, 0x064B..=0x065F | 0x0670)
}

/// An Arabic letter: in the Arabic ranges, not a diacritic.
pub fn is_arabic_letter(c: char) -> bool {
    is_arabic_range(c) && !is_tashkil(c)
}

fn is_latin_letter(c: char) -> bool {
    matches!(c as u32, 0x41..=0x5A | 0x61..=0x7A | 0x00C0..=0x024F | 0x1E00..=0x1EFF)
}

fn is_digit(c: char) -> bool {
    matches!(c as u32, 0x30..=0x39 | 0x0660..=0x0669 | 0x06F0..=0x06F9)
}

/// The punctuation the pipeline strips before tokenising (`PUNCT_SYMBOLS`
/// in the app's tokenizer): inside a word it is skipped, never a boundary.
const PUNCT: &str = ".,،:;!?؟؛«»\"\"''()[]{}⦗⦘﴾﴿/\\–—-_…·•●○◦۔؍٫٬٭±×÷=≠<>≤≥∞∑∏√∫∂∇¡¿†‡§¶©®™°′″‴";

fn skipped(c: char) -> bool {
    PUNCT.contains(c) || is_latin_letter(c) || is_digit(c)
}

/// `stripHtml`: a `<br>` is a newline, every other tag is dropped.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after = &rest[lt..];
        match after.find('>') {
            Some(gt) => {
                let tag = &after[..=gt];
                let inner = tag[1..tag.len() - 1].trim_start();
                let lower: String = inner.chars().take(3).flat_map(|c| c.to_lowercase()).collect();
                if lower.starts_with("br") && inner[2..].trim_start().trim_end_matches('/').trim().is_empty() {
                    out.push('\n');
                }
                rest = &after[gt + 1..];
            }
            None => {
                // An unclosed `<` is text.
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `buildCharToTokenMap` on the stripped text: one entry per character,
/// the token it belongs to or `None`. Stripped punctuation, Latin letters
/// and digits neither belong to a token nor end one; any other non-Arabic
/// character ends the word.
pub fn char_to_token(plain: &str) -> Vec<Option<u32>> {
    let mut out = Vec::with_capacity(plain.len());
    let mut token = 0u32;
    let mut in_word = false;
    for c in plain.chars() {
        if skipped(c) {
            out.push(None);
            continue;
        }
        if is_arabic_letter(c) || is_tashkil(c) {
            out.push(Some(token));
            in_word = true;
        } else {
            out.push(None);
            if in_word {
                token += 1;
                in_word = false;
            }
        }
    }
    out
}

/// The character range (in characters, end exclusive) of tokens
/// `[start_token, end_token)`, and those token bounds, around `center`
/// as `getSnippetRange` picks them.
pub struct SnippetRange {
    pub start: usize,
    pub end: usize,
    pub start_token: u32,
    pub end_token: u32,
}

pub fn snippet_range(map: &[Option<u32>], center: u32, tokens_before: usize, tokens_after: usize, max_from_start: Option<usize>) -> SnippetRange {
    let total = map.iter().flatten().max().map(|t| t + 1).unwrap_or(0);
    let mut start_token = center.saturating_sub(tokens_before as u32);
    let end_token = total.min(center.saturating_add(tokens_after as u32 + 1));
    if let Some(m) = max_from_start {
        if center - start_token > m as u32 {
            start_token = center - m as u32;
        }
    }
    let (mut start, mut end) = (map.len(), 0usize);
    for (i, t) in map.iter().enumerate() {
        if let Some(t) = t {
            if *t >= start_token && *t < end_token {
                start = start.min(i);
                end = end.max(i + 1);
            }
        }
    }
    if start >= map.len() {
        return SnippetRange { start: 0, end: map.len(), start_token: 0, end_token: total };
    }
    SnippetRange { start, end, start_token, end_token }
}

/// The row's snippet: the stripped body cut to `SNIPPET_TOKENS` tokens with
/// the first highlight no more than `SNIPPET_MAX_FROM_START` in, and the
/// token index the snippet starts at. A body with no tokens comes back as
/// it is, from token 0.
pub fn snip(body: &str, first_match: Option<u32>) -> (String, u32) {
    let plain = strip_html(body);
    let center = first_match.unwrap_or(0);
    let before = (center as usize).min(SNIPPET_MAX_FROM_START);
    let after = SNIPPET_TOKENS - before - 1;
    let start_token = center - before as u32;
    let end_token = center.saturating_add(after as u32 + 1);
    // One pass, the same walk `char_to_token` makes, stopping once the
    // snippet's last token has ended: the byte range of tokens
    // `[start_token, end_token)`.
    let mut token = 0u32;
    let mut in_word = false;
    let mut start: Option<usize> = None;
    let mut end = 0usize;
    let mut any = false;
    for (i, c) in plain.char_indices() {
        if skipped(c) {
            continue;
        }
        if is_arabic_letter(c) || is_tashkil(c) {
            any = true;
            if token >= start_token && token < end_token {
                if start.is_none() {
                    start = Some(i);
                }
                end = i + c.len_utf8();
            }
            in_word = true;
        } else if in_word {
            token += 1;
            in_word = false;
            if token >= end_token {
                break;
            }
        }
    }
    if !any {
        return (plain, 0);
    }
    match start {
        // The hit lies past the last token (a stale index): the whole page from 0.
        None => (plain, 0),
        Some(s) => (plain[s..end].to_string(), start_token),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tags_and_keeps_breaks() {
        assert_eq!(strip_html("قال<br/>رسول <b>الله</b>"), "قال\nرسول الله");
        assert_eq!(strip_html("<title id=3 parent=1>باب</title> كلام"), "باب كلام");
        assert_eq!(strip_html("a < b"), "a < b");
    }

    #[test]
    fn punctuation_and_digits_are_skipped_inside_a_word() {
        // "قال،" is one token; "12" is nothing; the space ends a word.
        let m = char_to_token("قال، 12 رسول");
        let tokens: Vec<Option<u32>> = m;
        assert_eq!(tokens[0..3], [Some(0), Some(0), Some(0)]);
        assert_eq!(tokens[3], None); // ،
        assert_eq!(tokens[4], None); // space
        assert_eq!(tokens[5], None); // 1
        assert_eq!(tokens.last(), Some(&Some(1)));
    }

    #[test]
    fn the_snippet_starts_at_most_five_tokens_before_the_first_hit() {
        let body: String = (0..120).map(|i| format!("كلمة{}", "ا".repeat(i % 3))).collect::<Vec<_>>().join(" ");
        let (text, start) = snip(&body, Some(40));
        assert_eq!(start, 35);
        let n = char_to_token(&text).iter().flatten().max().unwrap() + 1;
        assert_eq!(n, 50);
        // The hit is the sixth token of the snippet.
        assert_eq!(40 - start, 5);
    }

    #[test]
    fn matches_the_app_s_tokenizer() {
        // Written by engine/tests/fixtures/write_tokenizer.ts from the app's
        // arabicTokenizer.ts: the char→token map and the snippet around a
        // token, per text.
        let raw = include_str!("../tests/fixtures/tokenizer.json");
        let cases: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let body = case["body"].as_str().unwrap();
            let plain = strip_html(body);
            assert_eq!(plain, case["plain"].as_str().unwrap(), "strip_html of {body:?}");
            let map = char_to_token(&plain);
            let want: Vec<Option<u32>> = case["map"].as_array().unwrap().iter().map(|v| v.as_u64().map(|x| x as u32)).collect();
            assert_eq!(map, want, "char_to_token of {plain:?}");
            let center = case["center"].as_u64().unwrap() as u32;
            let (text, start) = snip(body, Some(center));
            assert_eq!(text, case["snippet"].as_str().unwrap(), "snippet of {plain:?} around {center}");
            assert_eq!(start, case["start_token"].as_u64().unwrap() as u32);
        }
    }
}
