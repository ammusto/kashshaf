//! Custom Tantivy collectors.

use tantivy::collector::{Collector, SegmentCollector};
use tantivy::{DocAddress, DocId, Score, SegmentOrdinal, SegmentReader};

// ---------------------------------------------------------------------------
// AllDocsCollector: enumerates every matching page hit (text_id, part_index,
// page_id) without scoring or limit. Fast-field readers are cached per segment
// in `for_segment` rather than rebuilt per document.
// ---------------------------------------------------------------------------

pub struct AllDocsCollector;

impl Collector for AllDocsCollector {
    type Fruit = Vec<(u64, u64, u64)>;
    type Child = AllDocsSegmentCollector;

    fn for_segment(
        &self,
        _segment_local_id: SegmentOrdinal,
        reader: &SegmentReader,
    ) -> tantivy::Result<Self::Child> {
        let id_reader = reader.fast_fields().u64("text_id")?.first_or_default_col(0);
        let part_reader = reader.fast_fields().u64("part_index")?.first_or_default_col(0);
        let page_reader = reader.fast_fields().u64("page_id")?.first_or_default_col(0);
        Ok(AllDocsSegmentCollector {
            id_reader,
            part_reader,
            page_reader,
            triples: Vec::new(),
        })
    }

    fn requires_scoring(&self) -> bool {
        false
    }

    fn merge_fruits(&self, segment_fruits: Vec<Self::Fruit>) -> tantivy::Result<Self::Fruit> {
        let total: usize = segment_fruits.iter().map(|v| v.len()).sum();
        let mut out = Vec::with_capacity(total);
        for v in segment_fruits {
            out.extend(v);
        }
        Ok(out)
    }
}

pub struct AllDocsSegmentCollector {
    id_reader: std::sync::Arc<dyn tantivy::columnar::ColumnValues<u64>>,
    part_reader: std::sync::Arc<dyn tantivy::columnar::ColumnValues<u64>>,
    page_reader: std::sync::Arc<dyn tantivy::columnar::ColumnValues<u64>>,
    triples: Vec<(u64, u64, u64)>,
}

impl SegmentCollector for AllDocsSegmentCollector {
    type Fruit = Vec<(u64, u64, u64)>;

    fn collect(&mut self, doc: DocId, _score: Score) {
        self.triples.push((
            self.id_reader.get_val(doc),
            self.part_reader.get_val(doc),
            self.page_reader.get_val(doc),
        ));
    }

    fn harvest(self) -> Self::Fruit {
        self.triples
    }
}

// ---------------------------------------------------------------------------
// ReadingOrderCollector: for a single-segment index whose doc ids are
// monotonic in reading order (death_ah, text_id, part_index, page_id) — as
// guaranteed by the indexer's `check_order` — the N-th matching doc id *is*
// the N-th result. This collector counts every hit and keeps only the
// addresses in `[offset, offset + limit)`, so pagination costs O(hits) doc-id
// iterations and O(limit) document fetches instead of O(offset + limit).
//
// It is only correct on a single segment: the window is computed from the
// segment-local running count. `SearchEngine` checks the segment count and
// falls back to `TopDocs` ordering otherwise.
// ---------------------------------------------------------------------------

pub struct ReadingOrderCollector {
    pub offset: usize,
    pub limit: usize,
}

/// (total hits, addresses of the requested window in reading order)
pub type ReadingOrderFruit = (usize, Vec<DocAddress>);

impl Collector for ReadingOrderCollector {
    type Fruit = ReadingOrderFruit;
    type Child = ReadingOrderSegmentCollector;

    fn for_segment(
        &self,
        segment_local_id: SegmentOrdinal,
        _reader: &SegmentReader,
    ) -> tantivy::Result<Self::Child> {
        Ok(ReadingOrderSegmentCollector {
            segment_ord: segment_local_id,
            offset: self.offset,
            end: self.offset.saturating_add(self.limit),
            seen: 0,
            docs: Vec::with_capacity(self.limit.min(1024)),
        })
    }

    fn requires_scoring(&self) -> bool {
        false
    }

    fn merge_fruits(
        &self,
        segment_fruits: Vec<(SegmentOrdinal, usize, Vec<DocId>)>,
    ) -> tantivy::Result<Self::Fruit> {
        // Segment fruits arrive in segment order. With one segment (the only
        // case the engine uses this collector for) this is exact. With several,
        // the window is a best-effort concatenation and the engine should not
        // have called us.
        let mut total = 0usize;
        let mut docs: Vec<DocAddress> = Vec::new();
        for (seg_ord, count, ids) in segment_fruits {
            total += count;
            docs.extend(ids.into_iter().map(|d| DocAddress::new(seg_ord, d)));
        }
        Ok((total, docs))
    }
}

pub struct ReadingOrderSegmentCollector {
    segment_ord: SegmentOrdinal,
    offset: usize,
    end: usize,
    seen: usize,
    docs: Vec<DocId>,
}

impl SegmentCollector for ReadingOrderSegmentCollector {
    type Fruit = (SegmentOrdinal, usize, Vec<DocId>);

    #[inline]
    fn collect(&mut self, doc: DocId, _score: Score) {
        if self.seen >= self.offset && self.seen < self.end {
            self.docs.push(doc);
        }
        self.seen += 1;
    }

    fn harvest(self) -> Self::Fruit {
        (self.segment_ord, self.seen, self.docs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tantivy::collector::Count;
    use tantivy::query::AllQuery;
    use tantivy::schema::{Schema, FAST, INDEXED, STORED};
    use tantivy::{doc, Index, IndexWriter};

    fn build(n: u64) -> Index {
        let mut sb = Schema::builder();
        let text_id = sb.add_u64_field("text_id", INDEXED | FAST | STORED);
        let part = sb.add_u64_field("part_index", INDEXED | FAST | STORED);
        let page = sb.add_u64_field("page_id", INDEXED | FAST | STORED);
        let index = Index::create_in_ram(sb.build());
        let mut w: IndexWriter = index.writer_with_num_threads(1, 20_000_000).unwrap();
        for i in 0..n {
            w.add_document(doc!(text_id => 1u64, part => 0u64, page => i)).unwrap();
        }
        w.commit().unwrap();
        index
    }

    #[test]
    fn window_and_count() {
        let index = build(100);
        let reader = index.reader().unwrap();
        let s = reader.searcher();
        assert_eq!(s.segment_readers().len(), 1);

        let (total, page) = s
            .search(&AllQuery, &ReadingOrderCollector { offset: 10, limit: 5 })
            .unwrap();
        assert_eq!(total, 100);
        assert_eq!(page.len(), 5);
        let ids: Vec<u32> = page.iter().map(|a| a.doc_id).collect();
        assert_eq!(ids, vec![10, 11, 12, 13, 14]);

        let (total, page) = s
            .search(&AllQuery, &ReadingOrderCollector { offset: 98, limit: 5 })
            .unwrap();
        assert_eq!(total, 100);
        assert_eq!(page.len(), 2);

        let (total, page) = s
            .search(&AllQuery, &ReadingOrderCollector { offset: 500, limit: 5 })
            .unwrap();
        assert_eq!(total, 100);
        assert!(page.is_empty());

        let c = s.search(&AllQuery, &Count).unwrap();
        assert_eq!(c, 100);
    }

    #[test]
    fn all_docs_collector_reads_fast_fields() {
        let index = build(7);
        let reader = index.reader().unwrap();
        let s = reader.searcher();
        let triples = s.search(&AllQuery, &AllDocsCollector).unwrap();
        assert_eq!(triples.len(), 7);
        assert_eq!(triples[3], (1, 0, 3));
    }
}
