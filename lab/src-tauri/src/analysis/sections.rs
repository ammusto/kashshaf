//! Section statistics (Lab spec §4.1): the table of contents from `<title>`
//! tags, with each section's token span.
//!
//! Pages carry headings as `<title id=N parent=M>…</title>`, `parent` naming
//! the enclosing section (0 at the top). A section runs from its heading to
//! the next heading of the same or a shallower depth, or to the end of the
//! book. Token spans are in the same coordinates as everything else —
//! display tokens counted by the alignment rules — so a section can be
//! handed to any statistic as a `[start, end)` range of global positions.

use super::align::{is_arabic_letter, is_tashkil, should_skip};
use super::text::BookText;
use crate::source::Page;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Section {
    pub id: u64,
    pub parent: u64,
    /// 0 for a top-level section.
    pub depth: usize,
    pub title: String,
    /// Where the heading is.
    pub page: usize,
    pub tok_start_on_page: usize,
    /// `[start, end)` in global positions; the heading's own tokens are
    /// inside the span.
    pub start: usize,
    pub end: usize,
    pub tokens: usize,
}

/// A heading found on one page: `(id, parent, text, first token, last token + 1)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub id: u64,
    pub parent: u64,
    pub text: String,
    pub tok_start: usize,
    pub tok_end: usize,
}

/// Parse `id=N parent=M` from a tag's attribute text; quotes optional.
fn attr(tag: &str, name: &str) -> Option<u64> {
    let mut rest = tag;
    while let Some(i) = rest.find(name) {
        let after = &rest[i + name.len()..];
        let before_ok = i == 0 || !rest[..i].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_');
        if before_ok {
            let v = after.trim_start().strip_prefix('=').map(|s| s.trim_start().trim_start_matches(['"', '\'']));
            if let Some(v) = v {
                let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !digits.is_empty() {
                    return digits.parse().ok();
                }
            }
        }
        rest = after;
    }
    None
}

/// The headings on one page, with their token spans in that page's display
/// token coordinates — the same walk `align::char_to_token_map` makes over
/// the stripped text, done here over the raw body so tag positions are known.
pub fn headings(body: &str) -> Vec<Heading> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut count = 0usize; // tokens completed so far
    let mut in_word = false;
    let mut open: Option<(u64, u64, usize, String)> = None; // id, parent, tok_start, text

    // The token index the *next* Arabic letter would start: the current
    // token if a word is open, else the count so far.
    let cur = |count: usize, in_word: bool| if in_word { count - 1 } else { count };

    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            if let Some(rel) = chars[i + 1..].iter().position(|&x| x == '>') {
                let tag: String = chars[i + 1..i + 1 + rel].iter().collect();
                let lower = tag.trim().to_ascii_lowercase();
                if lower.starts_with("title") {
                    open = Some((attr(&tag, "id").unwrap_or(0), attr(&tag, "parent").unwrap_or(0), cur(count, in_word), String::new()));
                } else if lower.starts_with("/title") {
                    if let Some((id, parent, start, text)) = open.take() {
                        out.push(Heading { id, parent, text: text.trim().to_string(), tok_start: start, tok_end: cur(count, in_word).max(start) + usize::from(in_word) });
                    }
                } else if lower.trim_end_matches('/').trim_end() == "br" {
                    // A boundary, as in stripHtml.
                    if in_word {
                        in_word = false;
                    }
                    if let Some((_, _, _, t)) = open.as_mut() {
                        t.push('\n');
                    }
                }
                i += rel + 2;
                continue;
            }
        }
        if let Some((_, _, _, t)) = open.as_mut() {
            t.push(c);
        }
        if should_skip(c) {
            i += 1;
            continue;
        }
        if is_arabic_letter(c) || is_tashkil(c) {
            if !in_word {
                count += 1;
                in_word = true;
            }
        } else if in_word {
            in_word = false;
        }
        i += 1;
    }
    out
}

/// The table of contents of a book, with token spans.
pub fn sections(text: &BookText, pages: &[Page]) -> Vec<Section> {
    let mut heads: Vec<(usize, Heading)> = Vec::new();
    for (p, page) in pages.iter().enumerate() {
        for h in headings(&page.body) {
            heads.push((p, h));
        }
    }
    // Depth from the parent chain; unknown parents count as top level.
    let ids: std::collections::HashMap<u64, u64> = heads.iter().map(|(_, h)| (h.id, h.parent)).collect();
    let depth_of = |mut id: u64| {
        let mut d = 0;
        let mut seen = 0;
        while let Some(&parent) = ids.get(&id) {
            if parent == 0 || seen > 64 {
                break;
            }
            d += 1;
            id = parent;
            seen += 1;
        }
        d
    };
    let starts: Vec<usize> = heads.iter().map(|(p, h)| text.page_starts[*p] + h.tok_start).collect();
    let depths: Vec<usize> = heads.iter().map(|(_, h)| depth_of(h.id)).collect();
    heads
        .iter()
        .enumerate()
        .map(|(i, (p, h))| {
            let start = starts[i];
            let end = (i + 1..heads.len())
                .find(|&j| depths[j] <= depths[i])
                .map(|j| starts[j])
                .unwrap_or(text.total);
            Section {
                id: h.id,
                parent: h.parent,
                depth: depths[i],
                title: h.text.clone(),
                page: *p,
                tok_start_on_page: h.tok_start,
                start,
                end,
                tokens: end.saturating_sub(start),
            }
        })
        .collect()
}

/// Section starts as global positions, for the span-aware options.
pub fn boundaries(sections: &[Section]) -> Vec<usize> {
    let mut v: Vec<usize> = sections.iter().map(|s| s.start).collect();
    v.sort_unstable();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::page;
    use crate::source::Layer;

    #[test]
    fn attributes_parse_quoted_and_bare() {
        assert_eq!(attr("title id=12 parent=3", "id"), Some(12));
        assert_eq!(attr("title id=12 parent=3", "parent"), Some(3));
        assert_eq!(attr("title id=\"7\" parent='0'", "id"), Some(7));
        assert_eq!(attr("title id=\"7\" parent='0'", "parent"), Some(0));
        assert_eq!(attr("title parent=3", "id"), None);
    }

    #[test]
    fn headings_carry_display_token_spans() {
        // "نص" (tok 0) then a heading of two words (toks 1–2), then "قال" (tok 3).
        let h = headings("نص\n<title id=1 parent=0> باب الإيمان</title>\nقال");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].id, 1);
        assert_eq!(h[0].parent, 0);
        assert_eq!(h[0].text, "باب الإيمان");
        assert_eq!((h[0].tok_start, h[0].tok_end), (1, 3));
        // The alignment contract: a heading flush against the next word merges.
        let h = headings("<title id=2 parent=1>باب</title>قال");
        assert_eq!((h[0].tok_start, h[0].tok_end), (0, 1));
    }

    #[test]
    fn digits_and_punctuation_in_a_heading_are_not_tokens() {
        let h = headings("<title id=1 parent=0> 12 - باب الصلاة</title>\nنص");
        assert_eq!((h[0].tok_start, h[0].tok_end), (0, 2));
        assert_eq!(h[0].text, "12 - باب الصلاة");
    }

    #[test]
    fn a_page_without_headings_has_none() {
        assert!(headings("قال رسول الله").is_empty());
        assert!(headings("").is_empty());
    }

    #[test]
    fn sections_nest_and_span_to_the_next_peer() {
        let pages = vec![
            page(1, 0, 1, "<title id=1 parent=0>كتاب الإيمان</title>\nقال رسول الله\n<title id=2 parent=1>باب أول</title>\nنص أول", "كتاب الإيمان قال رسول الله باب أول نص أول"),
            page(1, 0, 2, "نص ثان\n<title id=3 parent=1>باب ثان</title>\nنص ثالث\n<title id=4 parent=0>كتاب الصلاة</title>\nآخر", "نص ثان باب ثان نص ثالث كتاب الصلاة آخر"),
        ];
        let text = BookText::build(&pages, Layer::Surface);
        assert_eq!(text.total, 18);
        let s = sections(&text, &pages);
        assert_eq!(s.len(), 4);
        let by_id = |id: u64| s.iter().find(|x| x.id == id).unwrap();
        let k = by_id(1);
        assert_eq!((k.depth, k.start, k.end, k.tokens), (0, 0, 15, 15), "كتاب الإيمان runs to كتاب الصلاة");
        let b1 = by_id(2);
        assert_eq!((b1.depth, b1.page, b1.tok_start_on_page, b1.start, b1.end), (1, 0, 5, 5, 11));
        let b2 = by_id(3);
        assert_eq!((b2.depth, b2.start, b2.end), (1, 11, 15), "a sub-section ends at the next peer or the parent's end");
        let k2 = by_id(4);
        assert_eq!((k2.depth, k2.start, k2.end, k2.tokens), (0, 15, 18, 3));
        assert_eq!(boundaries(&s), vec![0, 5, 11, 15]);
    }
}
