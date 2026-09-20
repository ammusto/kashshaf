import { describe, it, expect } from 'vitest';
import { continuationLabel, pageLabelC1, phraseExceedsCrossPageSpan, secondaryIsAfter, CROSS_PAGE_MAX_SPAN } from './crossPage';

describe('cross-page helpers', () => {
  it('flags a phrase longer than the boundary index guarantees', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `كلمة${i}`).join(' ');
    expect(phraseExceedsCrossPageSpan(words(CROSS_PAGE_MAX_SPAN))).toBe(false);
    expect(phraseExceedsCrossPageSpan(words(CROSS_PAGE_MAX_SPAN + 1))).toBe(true);
    expect(phraseExceedsCrossPageSpan('  ')).toBe(false);
  });

  it('labels the other page by the C1 rule', () => {
    const sec = { part_index: 1, page_id: 11, part_label: '2', page_number: '11', matched_token_indices: [0] };
    expect(continuationLabel(sec, true, true)).toBe('continues on p. 2:11');
    expect(continuationLabel(sec, false, false)).toBe('continues from p. 11');
    expect(pageLabelC1('', '', 7, 0, true)).toBe('1:7');
  });

  it('decides which way the match continues from the page coordinates', () => {
    expect(secondaryIsAfter({ part_index: 0, page_id: 10 }, { part_index: 0, page_id: 11 })).toBe(true);
    expect(secondaryIsAfter({ part_index: 1, page_id: 1 }, { part_index: 0, page_id: 400 })).toBe(false);
  });
});
