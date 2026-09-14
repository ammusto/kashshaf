//! The book as the statistics see it: one flat token stream with page
//! boundaries, on a chosen layer (Lab spec §4.1 "Layers").
//!
//! Everything in §4.1 is a function of this view. It is built once per
//! `(book, layer)` from the pages `BookSource::book_pages` returned, so the
//! algorithms never touch a source, a page or a `Token` directly — they see
//! interned keys, which is also what makes them fast enough for a
//! million-token book.

use crate::source::{Layer, Page};
use kashshaf_engine::{normalize_arabic, Token};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// The key a token contributes on a layer, or `None` when it has none
/// (a token without a root, on the root layer).
///
/// - surface: the surface with tashkil stripped and hamza/alif folded, the
///   engine's own normalization — so orthographic variants of one word
///   count as one, exactly as a search finds them;
/// - lemma: as the pipeline emits it, unchanged (the engine matches lemma
///   queries exactly);
/// - root: the pipeline's dotted, `#`-for-weak-letter form, unchanged.
pub fn key_of(token: &Token, layer: Layer) -> Option<String> {
    match layer {
        Layer::Surface => Some(normalize_arabic(&token.surface)),
        Layer::Lemma => Some(token.lemma.clone()),
        Layer::Root => token.root.clone(),
    }
}

/// A position in the book: which page (index into the pages slice) and
/// which token on it. Serialized so the UI can click through to the reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Pos {
    pub page: usize,
    pub idx: usize,
}

/// One book on one layer.
pub struct BookText {
    pub layer: Layer,
    /// Interned key per token in reading order; `None` = no key on this layer.
    pub keys: Vec<Option<u32>>,
    /// `vocab[id]` is the key string.
    pub vocab: Vec<String>,
    /// Global offset of each page's first token; `page_starts[p+1]` (or
    /// `total`) is one past its last.
    pub page_starts: Vec<usize>,
    /// Tokens in the book (with or without a key).
    pub total: usize,
    /// Tokens that have a key on this layer — the N the statistics divide by.
    pub keyed: usize,
    /// Every lemma per token, kept so the stop-word toggle (by lemma, §4.1)
    /// works on any layer.
    lemma_ids: Vec<u32>,
    lemma_vocab: Vec<String>,
}

impl BookText {
    pub fn build(pages: &[Page], layer: Layer) -> Self {
        let mut keys = Vec::new();
        let mut vocab: Vec<String> = Vec::new();
        let mut intern: HashMap<String, u32> = HashMap::new();
        let mut lemma_ids = Vec::new();
        let mut lemma_vocab: Vec<String> = Vec::new();
        let mut lemma_intern: HashMap<String, u32> = HashMap::new();
        let mut page_starts = Vec::with_capacity(pages.len());
        let mut keyed = 0usize;

        for page in pages {
            page_starts.push(keys.len());
            for t in &page.tokens {
                let k = key_of(t, layer).map(|s| {
                    *intern.entry(s.clone()).or_insert_with(|| {
                        vocab.push(s);
                        (vocab.len() - 1) as u32
                    })
                });
                if k.is_some() {
                    keyed += 1;
                }
                keys.push(k);
                let l = *lemma_intern.entry(t.lemma.clone()).or_insert_with(|| {
                    lemma_vocab.push(t.lemma.clone());
                    (lemma_vocab.len() - 1) as u32
                });
                lemma_ids.push(l);
            }
        }
        let total = keys.len();
        Self { layer, keys, vocab, page_starts, total, keyed, lemma_ids, lemma_vocab }
    }

    pub fn pages(&self) -> usize {
        self.page_starts.len()
    }

    /// Tokens on page `p`.
    pub fn page_len(&self, p: usize) -> usize {
        self.page_end(p) - self.page_starts[p]
    }

    pub fn page_end(&self, p: usize) -> usize {
        self.page_starts.get(p + 1).copied().unwrap_or(self.total)
    }

    /// Which page a global position is on.
    pub fn page_of(&self, global: usize) -> usize {
        match self.page_starts.binary_search(&global) {
            Ok(p) => p,
            Err(p) => p - 1,
        }
    }

    pub fn pos(&self, global: usize) -> Pos {
        let page = self.page_of(global);
        Pos { page, idx: global - self.page_starts[page] }
    }

    pub fn global(&self, pos: Pos) -> usize {
        self.page_starts[pos.page] + pos.idx
    }

    pub fn key(&self, global: usize) -> Option<&str> {
        self.keys[global].map(|id| self.vocab[id as usize].as_str())
    }

    pub fn id_of(&self, key: &str) -> Option<u32> {
        self.vocab.iter().position(|v| v == key).map(|i| i as u32)
    }

    pub fn lemma(&self, global: usize) -> &str {
        &self.lemma_vocab[self.lemma_ids[global] as usize]
    }

    /// Whether the token at `global` is a stop word (by lemma, whatever the
    /// layer).
    pub fn is_stop(&self, global: usize, stop: &StopList) -> bool {
        stop.contains(self.lemma(global))
    }

    /// The same book with every key outside `[start, end)` removed — how a
    /// statistic is restricted to one section (spec §4.1, "Section
    /// statistics"). Positions and pages are unchanged, so a hit inside the
    /// section still clicks through to the same place.
    pub fn masked(&self, start: usize, end: usize) -> Self {
        let mut out = Self {
            layer: self.layer,
            keys: self.keys.clone(),
            vocab: self.vocab.clone(),
            page_starts: self.page_starts.clone(),
            total: self.total,
            keyed: 0,
            lemma_ids: self.lemma_ids.clone(),
            lemma_vocab: self.lemma_vocab.clone(),
        };
        for (g, k) in out.keys.iter_mut().enumerate() {
            if g < start || g >= end {
                *k = None;
            } else if k.is_some() {
                out.keyed += 1;
            }
        }
        out
    }

    /// Count of every key, honouring the stop list when one is given.
    pub fn counts(&self, stop: Option<&StopList>) -> (HashMap<u32, u64>, u64) {
        let mut counts: HashMap<u32, u64> = HashMap::new();
        let mut n = 0u64;
        for (g, k) in self.keys.iter().enumerate() {
            let Some(id) = k else { continue };
            if let Some(s) = stop {
                if self.is_stop(g, s) {
                    continue;
                }
            }
            *counts.entry(*id).or_insert(0) += 1;
            n += 1;
        }
        (counts, n)
    }
}

/// Stop words by lemma (spec §4.1): a shipped default of function words,
/// editable by the user. Membership is exact on the lemma string, the way
/// the pipeline emits it.
#[derive(Debug, Clone, Default)]
pub struct StopList {
    lemmas: HashSet<String>,
}

impl StopList {
    pub fn new<I: IntoIterator<Item = String>>(lemmas: I) -> Self {
        Self { lemmas: lemmas.into_iter().collect() }
    }

    /// The shipped default: ~200 high-frequency function words — particles,
    /// prepositions, pronouns, demonstratives, relatives, the copulae and
    /// their sisters. Not the raw frequency head of the corpus, which is
    /// dominated by `قال`, `الله`, `بن` and `حدث`: those are content in a
    /// ḥadīth collection, and a stop list that hid them would hide the text.
    pub fn shipped() -> Self {
        Self::new(SHIPPED.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from))
    }

    pub fn contains(&self, lemma: &str) -> bool {
        self.lemmas.contains(lemma)
    }

    pub fn len(&self) -> usize {
        self.lemmas.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lemmas.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.lemmas.iter().map(String::as_str)
    }
}

/// `lexicons/stopwords.txt`: one lemma per line, `#` comments.
const SHIPPED: &str = include_str!("../../lexicons/stopwords.txt");

#[cfg(test)]
pub(crate) mod fixtures {
    //! Small books the §4.1 tests share, so every hand-computed number is
    //! checkable against the same text.
    use crate::source::Page;
    use kashshaf_engine::Token;

    /// `surface/lemma/root` triples → a token; `root` empty means none.
    pub fn tok(idx: usize, surface: &str, lemma: &str, root: &str) -> Token {
        Token {
            idx,
            surface: surface.to_string(),
            noclitic_surface: None,
            lemma: lemma.to_string(),
            root: if root.is_empty() { None } else { Some(root.to_string()) },
            pos: "noun".to_string(),
            features: vec![],
            clitics: vec![],
        }
    }

    /// A page from `"surface|lemma|root"` words separated by spaces.
    pub fn page(book_id: u64, part: u32, page_id: u64, body: &str, words: &str) -> Page {
        let tokens = words
            .split_whitespace()
            .enumerate()
            .map(|(i, w)| {
                let mut parts = w.split('|');
                let s = parts.next().unwrap();
                let l = parts.next().unwrap_or(s);
                let r = parts.next().unwrap_or("");
                tok(i, s, l, r)
            })
            .collect();
        Page {
            book_id,
            part_index: part,
            page_id,
            part_label: format!("ج{}", part + 1),
            page_number: page_id.to_string(),
            body: body.to_string(),
            tokens,
        }
    }

    /// Two pages, ten tokens, with a repeated word across pages:
    ///
    /// page 0: قال الرجل قال الله   (lemmas: قول رجل قول الله)
    /// page 1: رجل من الله في الكتاب قال   (lemmas: رجل من الله في كتاب قول)
    pub fn two_pages() -> Vec<Page> {
        vec![
            page(1, 0, 1, "قال الرجل قال الله", "قال|قول|ق.#.ل الرجل|رجل|ر.ج.ل قال|قول|ق.#.ل الله|الله|"),
            page(
                1,
                0,
                2,
                "رجل من الله في الكتاب قال",
                "رجل|رجل|ر.ج.ل من|من| الله|الله| في|في| الكتاب|كتاب|ك.ت.ب قال|قول|ق.#.ل",
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::two_pages;
    use super::*;

    #[test]
    fn keys_are_interned_per_layer_and_pages_are_located() {
        let pages = two_pages();
        let t = BookText::build(&pages, Layer::Lemma);
        assert_eq!(t.total, 10);
        assert_eq!(t.keyed, 10);
        assert_eq!(t.page_starts, vec![0, 4]);
        assert_eq!(t.page_len(0), 4);
        assert_eq!(t.page_len(1), 6);
        assert_eq!(t.key(0), Some("قول"));
        assert_eq!(t.key(9), Some("قول"));
        assert_eq!(t.keys[0], t.keys[9], "the same lemma interns to one id");
        assert_eq!(t.pos(5), Pos { page: 1, idx: 1 });
        assert_eq!(t.global(Pos { page: 1, idx: 1 }), 5);
        assert_eq!(t.page_of(3), 0);
        assert_eq!(t.page_of(4), 1);

        let r = BookText::build(&pages, Layer::Root);
        assert_eq!(r.keyed, 6, "four tokens have no root");
        assert_eq!(r.key(3), None);

        let s = BookText::build(&pages, Layer::Surface);
        // Surface keys are normalized: "قال" and "قال" agree, and tashkil would fold.
        assert_eq!(s.key(0), Some("قال"));
    }

    #[test]
    fn masking_keeps_positions_and_drops_keys_outside_the_range() {
        let pages = two_pages();
        let t = BookText::build(&pages, Layer::Lemma).masked(4, 10);
        assert_eq!(t.total, 10, "positions are unchanged");
        assert_eq!(t.keyed, 6);
        assert_eq!(t.key(0), None);
        assert_eq!(t.key(4), Some("رجل"));
        let (c, n) = t.counts(None);
        assert_eq!(n, 6);
        assert_eq!(c[&t.id_of("قول").unwrap()], 1);
    }

    #[test]
    fn counts_honour_the_stop_list_by_lemma_on_any_layer() {
        let pages = two_pages();
        let stop = StopList::new(["من".to_string(), "في".to_string()]);
        let t = BookText::build(&pages, Layer::Surface);
        let (all, n) = t.counts(None);
        assert_eq!(n, 10);
        assert_eq!(all[&t.id_of("قال").unwrap()], 3);
        let (kept, n) = t.counts(Some(&stop));
        assert_eq!(n, 8);
        assert!(kept.get(&t.id_of("من").unwrap()).is_none());
    }

    #[test]
    fn the_shipped_stop_list_is_function_words() {
        let s = StopList::shipped();
        assert!(s.len() >= 150, "shipped list has {} entries", s.len());
        for w in ["في", "من", "على", "إلى", "أن", "لا", "ما", "هو", "هذا", "الذي", "كان"] {
            assert!(s.contains(w), "{} should be a stop word", w);
        }
        for w in ["قال", "الله", "بن", "حدث", "رسول", "نبي", "كتاب"] {
            assert!(!s.contains(w), "{} must not be a stop word", w);
        }
    }
}
