//! Frequency list (Lab spec §4.1).
//!
//! Counts per key on a layer, with the corpus count, corpus rank and
//! per-million rates alongside when a frequency table is available.

use super::text::{BookText, StopList};
use crate::source::FreqTable;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreqRow {
    pub key: String,
    pub count: u64,
    /// Occurrences per million tokens of the book (keyed tokens, stop words
    /// excluded when the toggle is on, so the rates sum to a million).
    pub per_million: f64,
    /// Corpus count and rank, when a table was given; `None` otherwise.
    pub corpus_count: Option<u64>,
    pub corpus_rank: Option<u32>,
    pub corpus_per_million: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreqList {
    /// Tokens the rates are relative to.
    pub total: u64,
    pub distinct: usize,
    pub rows: Vec<FreqRow>,
}

pub fn per_million(count: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        count as f64 * 1_000_000.0 / total as f64
    }
}

/// The list, sorted by count descending then key, honouring the stop list
/// when given. The UI re-sorts; this order is the one exports use.
pub fn frequency_list(text: &BookText, stop: Option<&StopList>, corpus: Option<&FreqTable>) -> FreqList {
    let (counts, total) = text.counts(stop);
    let mut rows: Vec<FreqRow> = counts
        .into_iter()
        .map(|(id, count)| {
            let key = text.vocab[id as usize].clone();
            let (corpus_count, corpus_rank, corpus_per_million) = match corpus {
                Some(t) => {
                    let f = t.get(&key);
                    (Some(f.count), f.rank, Some(per_million(f.count, t.total)))
                }
                None => (None, None, None),
            };
            FreqRow { per_million: per_million(count, total), key, count, corpus_count, corpus_rank, corpus_per_million }
        })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    FreqList { total, distinct: rows.len(), rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::text::fixtures::two_pages;
    use crate::source::{FreqLayer, Layer};
    use std::collections::HashMap;

    #[test]
    fn counts_rates_and_corpus_columns() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let mut c = HashMap::new();
        c.insert("قول".to_string(), 500_000u64);
        c.insert("رجل".to_string(), 400_000u64);
        c.insert("الله".to_string(), 100_000u64);
        let corpus = FreqTable::from_counts(FreqLayer::Lemma, "t", c); // total 1,000,000

        let list = frequency_list(&text, None, Some(&corpus));
        assert_eq!(list.total, 10);
        assert_eq!(list.distinct, 6);
        let top = &list.rows[0];
        assert_eq!(top.key, "قول");
        assert_eq!(top.count, 3);
        assert!((top.per_million - 300_000.0).abs() < 1e-9);
        assert_eq!(top.corpus_count, Some(500_000));
        assert_eq!(top.corpus_rank, Some(1));
        assert!((top.corpus_per_million.unwrap() - 500_000.0).abs() < 1e-9);
        // Ties (رجل 2, الله 2) are broken by key so the order is stable.
        assert_eq!(list.rows[1].key, "الله");
        assert_eq!(list.rows[2].key, "رجل");
        // A key the corpus table lacks reads as 0 with no rank.
        let kitab = list.rows.iter().find(|r| r.key == "كتاب").unwrap();
        assert_eq!(kitab.corpus_count, Some(0));
        assert_eq!(kitab.corpus_rank, None);
    }

    #[test]
    fn the_stop_toggle_changes_the_denominator_too() {
        let pages = two_pages();
        let text = BookText::build(&pages, Layer::Lemma);
        let stop = StopList::new(["من".to_string(), "في".to_string()]);
        let list = frequency_list(&text, Some(&stop), None);
        assert_eq!(list.total, 8);
        assert!(list.rows.iter().all(|r| r.key != "من" && r.key != "في"));
        let sum: f64 = list.rows.iter().map(|r| r.per_million).sum();
        assert!((sum - 1_000_000.0).abs() < 1e-6);
        assert!(list.rows[0].corpus_count.is_none());
    }
}
