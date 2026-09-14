//! Concordance / KWIC (Lab spec §4.1).
//!
//! A query is a term or a phrase on one layer, matched with the rules
//! Kashshaf's search uses, so a hit here is a hit there:
//!
//! - **surface**: the query is normalized with the engine's
//!   `normalize_arabic` and compared with each token's normalized surface;
//!   a word may carry `*` wildcards in the engine's glob grammar; with the
//!   clitic toggle on, the first word also matches with any of the
//!   proclitics `و ف ب ل ك` attached, which is exactly the expansion
//!   Kashshaf's online search performs;
//! - **lemma**: exact, as the engine matches lemma terms;
//! - **root**: the query is converted with the engine's
//!   `normalize_root_query` to the dotted, `#`-for-weak-letter form the
//!   tokens carry.
//!
//! Every hit is returned with N tokens of context either side, never
//! crossing a page (the reader shows a page at a time, so a line that ran
//! onto the next page would show context the click-through cannot). Sorting
//! is by position, or by the context words nearest the node.

use super::text::BookText;
use crate::source::Layer;
use kashshaf_engine::{normalize_arabic, normalize_root_query, GlobPattern};
use serde::{Deserialize, Serialize};

/// Kashshaf's proclitic expansion (`src/api/online.ts`).
pub const PROCLITICS: [char; 5] = ['و', 'ف', 'ب', 'ل', 'ك'];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcordanceQuery {
    pub layer: Layer,
    pub query: String,
    /// Surface only: also match the first word with a proclitic attached.
    pub clitics: bool,
}

/// One matched span, in book coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub page: usize,
    /// `[tok_start, tok_end)` on that page.
    pub tok_start: usize,
    pub tok_end: usize,
    /// Global position of `tok_start`, for sorting and dispersion.
    pub global: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KwicLine {
    pub hit: Hit,
    pub left: Vec<String>,
    pub node: Vec<String>,
    pub right: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortBy {
    Position,
    /// By the words immediately left of the node, nearest first.
    Left,
    /// By the words immediately right of the node.
    Right,
}

/// How one query word matches a token key.
enum WordMatcher {
    /// Any of these exact keys (the clitic variants of one word).
    Exact(Vec<String>),
    /// Any of these globs (the clitic variants of a wildcard word).
    Glob(Vec<GlobPattern>),
}

impl WordMatcher {
    fn matches(&self, key: &str) -> bool {
        match self {
            WordMatcher::Exact(v) => v.iter().any(|w| w == key),
            WordMatcher::Glob(v) => v.iter().any(|g| g.matches(key)),
        }
    }
}

/// Translate the query into one matcher per word, using the engine's rules.
fn matchers(q: &ConcordanceQuery) -> Vec<WordMatcher> {
    let words: Vec<String> = match q.layer {
        Layer::Surface => normalize_arabic(&q.query).split_whitespace().map(String::from).collect(),
        Layer::Lemma => q.query.split_whitespace().map(String::from).collect(),
        Layer::Root => normalize_root_query(&q.query).split_whitespace().map(String::from).collect(),
    };
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            // Clitic expansion applies to the first word only, as in Kashshaf.
            let variants: Vec<String> = if q.layer == Layer::Surface && q.clitics && i == 0 {
                std::iter::once(w.clone()).chain(PROCLITICS.iter().map(|p| format!("{}{}", p, w))).collect()
            } else {
                vec![w.clone()]
            };
            if q.layer == Layer::Surface && w.contains('*') {
                WordMatcher::Glob(variants.iter().map(|v| GlobPattern::parse(v)).collect())
            } else {
                WordMatcher::Exact(variants)
            }
        })
        .collect()
}

/// Every hit of the query in the book, in reading order.
pub fn find_hits(text: &BookText, q: &ConcordanceQuery) -> Vec<Hit> {
    let ms = matchers(q);
    if ms.is_empty() || text.layer != q.layer {
        return Vec::new();
    }
    // Resolve each matcher to the vocabulary ids it accepts: one pass over
    // the vocabulary per word, then the scan compares integers.
    let accepted: Vec<Vec<bool>> = ms
        .iter()
        .map(|m| text.vocab.iter().map(|v| m.matches(v)).collect())
        .collect();
    let n = ms.len();
    let mut hits = Vec::new();
    for p in 0..text.pages() {
        let (start, end) = (text.page_starts[p], text.page_end(p));
        if end - start < n {
            continue;
        }
        'pos: for g in start..=end - n {
            for (k, acc) in accepted.iter().enumerate() {
                match text.keys[g + k] {
                    Some(id) if acc[id as usize] => {}
                    _ => continue 'pos,
                }
            }
            hits.push(Hit { page: p, tok_start: g - start, tok_end: g - start + n, global: g });
        }
    }
    hits
}

/// The display form of a token for a KWIC line: the raw surface, whatever
/// layer was searched, so the line reads as text.
fn surfaces(text: &BookText, pages: &[crate::source::Page], page: usize, from: usize, to: usize) -> Vec<String> {
    let _ = text;
    pages[page].tokens[from..to].iter().map(|t| t.surface.clone()).collect()
}

/// KWIC lines for `hits`, with `context` tokens either side, within the page.
pub fn kwic(text: &BookText, pages: &[crate::source::Page], hits: &[Hit], context: usize) -> Vec<KwicLine> {
    hits.iter()
        .map(|h| {
            let len = text.page_len(h.page);
            let l0 = h.tok_start.saturating_sub(context);
            let r1 = (h.tok_end + context).min(len);
            KwicLine {
                hit: *h,
                left: surfaces(text, pages, h.page, l0, h.tok_start),
                node: surfaces(text, pages, h.page, h.tok_start, h.tok_end),
                right: surfaces(text, pages, h.page, h.tok_end, r1),
            }
        })
        .collect()
}

/// Sort lines in place. Left context compares the word nearest the node
/// first (so lines group by the preceding word), right context the word
/// after it; ties fall back to position.
pub fn sort_lines(lines: &mut [KwicLine], by: SortBy) {
    match by {
        SortBy::Position => lines.sort_by_key(|l| l.hit.global),
        SortBy::Left => lines.sort_by(|a, b| {
            let ka: Vec<&String> = a.left.iter().rev().collect();
            let kb: Vec<&String> = b.left.iter().rev().collect();
            ka.cmp(&kb).then_with(|| a.hit.global.cmp(&b.hit.global))
        }),
        SortBy::Right => lines.sort_by(|a, b| a.right.cmp(&b.right).then_with(|| a.hit.global.cmp(&b.hit.global))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::{page, two_pages};

    fn q(layer: Layer, s: &str, clitics: bool) -> ConcordanceQuery {
        ConcordanceQuery { layer, query: s.to_string(), clitics }
    }

    #[test]
    fn lemma_hits_are_exact_and_in_reading_order() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let hits = find_hits(&text, &q(Layer::Lemma, "قول", false));
        assert_eq!(
            hits,
            vec![
                Hit { page: 0, tok_start: 0, tok_end: 1, global: 0 },
                Hit { page: 0, tok_start: 2, tok_end: 3, global: 2 },
                Hit { page: 1, tok_start: 5, tok_end: 6, global: 9 },
            ]
        );
        // The surface form is not the lemma: no hits.
        assert!(find_hits(&text, &q(Layer::Lemma, "قال", false)).is_empty());
    }

    #[test]
    fn a_phrase_must_be_contiguous_and_on_one_page() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        // "الله رجل" straddles the page break (page 0 ends الله, page 1 starts رجل).
        assert!(find_hits(&text, &q(Layer::Lemma, "الله رجل", false)).is_empty());
        let hits = find_hits(&text, &q(Layer::Lemma, "قول الله", false));
        assert_eq!(hits, vec![Hit { page: 0, tok_start: 2, tok_end: 4, global: 2 }]);
    }

    #[test]
    fn surface_matching_normalizes_and_expands_clitics() {
        let pages = vec![page(1, 0, 1, "", "وقال|قول|ق.#.ل قَالَ|قول|ق.#.ل فقال|قول| بقال|x| الرجل|رجل|")];
        let text = BookText::build(&pages, Layer::Surface);
        // Without clitics: the tashkil-bearing form is normalized and matches.
        let hits = find_hits(&text, &q(Layer::Surface, "قال", false));
        assert_eq!(hits.iter().map(|h| h.tok_start).collect::<Vec<_>>(), vec![1]);
        // With clitics: وقال، فقال، بقال join in — the Kashshaf expansion.
        let hits = find_hits(&text, &q(Layer::Surface, "قال", true));
        assert_eq!(hits.iter().map(|h| h.tok_start).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        // A query typed with tashkil finds the same.
        let hits = find_hits(&text, &q(Layer::Surface, "قَالَ", false));
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn surface_wildcards_use_the_glob_grammar() {
        let pages = vec![page(1, 0, 1, "", "معرفة|x| معارف|x| عرف|x| المعرفة|x|")];
        let text = BookText::build(&pages, Layer::Surface);
        let starts = |s: &str, c: bool| find_hits(&text, &q(Layer::Surface, s, c)).iter().map(|h| h.tok_start).collect::<Vec<_>>();
        assert_eq!(starts("مع*", false), vec![0, 1]);
        // معارف ends in رف too: a suffix glob is a suffix glob.
        assert_eq!(starts("*رف", false), vec![1, 2]);
        // معارف has an alif between ع and ر, so a contiguous عرف is not in it.
        assert_eq!(starts("*عرف*", false), vec![0, 2, 3]);
        assert_eq!(starts("مع*رف*", false), vec![0, 1]);
    }

    #[test]
    fn root_queries_are_converted_to_the_dotted_form() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Root);
        let hits = find_hits(&text, &q(Layer::Root, "قول", false));
        assert_eq!(hits.len(), 3, "قول → ق.#.ل matches every قال");
        let hits = find_hits(&text, &q(Layer::Root, "رجل", false));
        assert_eq!(hits.len(), 2);
        assert!(find_hits(&text, &q(Layer::Root, "كتب", false)).len() == 1);
    }

    #[test]
    fn kwic_context_stays_on_the_page() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let hits = find_hits(&text, &q(Layer::Lemma, "قول", false));
        let lines = kwic(&text, &pages, &hits, 8);
        assert_eq!(lines[0].left, Vec::<String>::new());
        assert_eq!(lines[0].node, vec!["قال"]);
        assert_eq!(lines[0].right, vec!["الرجل", "قال", "الله"]);
        // The last hit is the final token of page 1: no right context, and
        // the left context does not reach back into page 0.
        assert_eq!(lines[2].right, Vec::<String>::new());
        assert_eq!(lines[2].left, vec!["رجل", "من", "الله", "في", "الكتاب"]);
        let lines = kwic(&text, &pages, &hits, 1);
        assert_eq!(lines[2].left, vec!["الكتاب"]);
    }

    #[test]
    fn sorting_by_context_groups_lines() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let hits = find_hits(&text, &q(Layer::Lemma, "قول", false));
        let mut lines = kwic(&text, &pages, &hits, 2);
        sort_lines(&mut lines, SortBy::Left);
        // Left contexts (nearest first): [] < ["الرجل","قال"] < ["الكتاب","في"]
        // (empty first; ر < ك), so the order is 0, 2, 9.
        assert_eq!(lines.iter().map(|l| l.hit.global).collect::<Vec<_>>(), vec![0, 2, 9]);
        sort_lines(&mut lines, SortBy::Right);
        // Right contexts: ["الرجل","قال"], ["الله"], [] — empty first.
        assert_eq!(lines.iter().map(|l| l.hit.global).collect::<Vec<_>>(), vec![9, 0, 2]);
        sort_lines(&mut lines, SortBy::Position);
        assert_eq!(lines.iter().map(|l| l.hit.global).collect::<Vec<_>>(), vec![0, 2, 9]);
    }
}
