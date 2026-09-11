//! `*`-only glob patterns for compound-index wildcards.
//!
//! A word may contain any number of `*`; each matches any (possibly empty)
//! sequence of characters. Supported shapes: prefix `أب*`, suffix `*رف`,
//! infix `أح*مد`, contains `*قول*`, multi-segment `مع*رف*`. No `?`, no
//! character classes. Surfaces in the triple maps are already normalized, so
//! matching is a plain byte comparison of the literal segments.

use crate::normalize::count_arabic_letters;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobPattern {
    /// The word as typed (normalized by the caller).
    pub raw: String,
    /// Literal segments between the stars, in order, empty segments dropped.
    pub segments: Vec<String>,
    /// The word does not start with `*`: `segments[0]` must be a prefix.
    pub anchored_start: bool,
    /// The word does not end with `*`: the last segment must be a suffix.
    pub anchored_end: bool,
}

impl GlobPattern {
    pub fn parse(word: &str) -> Self {
        let has_star = word.contains('*');
        let segments: Vec<String> = word.split('*').filter(|s| !s.is_empty()).map(str::to_string).collect();
        Self {
            raw: word.to_string(),
            anchored_start: !word.starts_with('*'),
            anchored_end: !word.ends_with('*'),
            segments: if has_star { segments } else { vec![word.to_string()] },
        }
    }

    /// Does the word contain a `*` at all?
    pub fn is_wildcard(&self) -> bool {
        self.raw.contains('*')
    }

    /// Literal Arabic letters across all segments (validation: at least 2).
    pub fn literal_letters(&self) -> usize {
        self.segments.iter().map(|s| count_arabic_letters(s)).sum()
    }

    /// The literal prefix every match must start with, when there is one.
    /// Lets the expansion binary-search the surface-sorted array instead of
    /// scanning it.
    pub fn literal_prefix(&self) -> Option<&str> {
        if self.anchored_start {
            self.segments.first().map(String::as_str)
        } else {
            None
        }
    }

    /// Iterative `*`-only glob match.
    pub fn matches(&self, s: &str) -> bool {
        if !self.is_wildcard() {
            return s == self.raw;
        }
        let segs = &self.segments;
        if segs.is_empty() {
            return true;
        }
        let mut rest = s;
        let mut i = 0usize;
        let mut j = segs.len();
        if self.anchored_start {
            let first = segs[0].as_str();
            if !rest.starts_with(first) {
                return false;
            }
            rest = &rest[first.len()..];
            i = 1;
        }
        if self.anchored_end && j > i {
            let last = segs[j - 1].as_str();
            if !rest.ends_with(last) {
                return false;
            }
            rest = &rest[..rest.len() - last.len()];
            j -= 1;
        }
        for seg in &segs[i..j] {
            match rest.find(seg.as_str()) {
                Some(p) => rest = &rest[p + seg.len()..],
                None => return false,
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> GlobPattern {
        GlobPattern::parse(s)
    }

    #[test]
    fn parse_shapes() {
        let g = p("أب*");
        assert_eq!(g.segments, vec!["أب"]);
        assert!(g.anchored_start && !g.anchored_end);
        let g = p("*رف");
        assert_eq!(g.segments, vec!["رف"]);
        assert!(!g.anchored_start && g.anchored_end);
        let g = p("أح*مد");
        assert_eq!(g.segments, vec!["أح", "مد"]);
        assert!(g.anchored_start && g.anchored_end);
        let g = p("*قول*");
        assert_eq!(g.segments, vec!["قول"]);
        assert!(!g.anchored_start && !g.anchored_end);
        let g = p("مع*رف*");
        assert_eq!(g.segments, vec!["مع", "رف"]);
        assert!(g.anchored_start && !g.anchored_end);
        assert_eq!(g.literal_letters(), 4);
        assert_eq!(g.literal_prefix(), Some("مع"));
        assert_eq!(p("*قول*").literal_prefix(), None);
    }

    #[test]
    fn literal_word() {
        let g = p("كتاب");
        assert!(!g.is_wildcard());
        assert_eq!(g.segments, vec!["كتاب"]);
        assert!(g.matches("كتاب"));
        assert!(!g.matches("كتابه"));
    }

    #[test]
    fn prefix() {
        let g = p("أب*");
        assert!(g.matches("أب"));
        assert!(g.matches("أبو"));
        assert!(g.matches("أبواب"));
        assert!(!g.matches("بأب"));
    }

    #[test]
    fn suffix() {
        let g = p("*رف");
        assert!(g.matches("رف"));
        assert!(g.matches("عرف"));
        assert!(g.matches("معرف"));
        assert!(!g.matches("رفع"));
    }

    #[test]
    fn infix() {
        let g = p("أح*مد");
        assert!(g.matches("أحمد"));
        assert!(g.matches("أحامد"));
        assert!(!g.matches("أحم"));
        assert!(!g.matches("محمد"));
        // prefix and suffix must not overlap
        assert!(!p("اب*با").matches("ابا"));
        assert!(p("اب*با").matches("اببا"));
        assert!(p("اب*با").matches("ابxبا"));
    }

    #[test]
    fn contains() {
        let g = p("*قول*");
        assert!(g.matches("قول"));
        assert!(g.matches("يقول"));
        assert!(g.matches("مقولة"));
        assert!(g.matches("والمقولات"));
        assert!(!g.matches("قال"));
    }

    #[test]
    fn multi_segment() {
        let g = p("مع*رف*");
        assert!(g.matches("معرف"));
        assert!(g.matches("معارف"));
        assert!(g.matches("معرفة"));
        assert!(g.matches("معترفون"));
        assert!(!g.matches("مرفع"));
        assert!(!g.matches("عرفمع"));
        let g = p("ا*ب*ج*د");
        assert!(g.matches("ابجد"));
        assert!(g.matches("اxبxجxد"));
        assert!(!g.matches("ابجدx"));
        assert!(!g.matches("ادجب"));
    }

    #[test]
    fn empty_segments_and_bare_star() {
        let g = p("مع**رف");
        assert_eq!(g.segments, vec!["مع", "رف"]);
        assert!(g.matches("معرف"));
        let g = p("*");
        assert!(g.segments.is_empty());
        assert!(g.matches("anything"));
        assert!(g.matches(""));
        assert_eq!(g.literal_letters(), 0);
        let g = p("**");
        assert!(g.matches("x"));
    }
}
