import { describe, it, expect } from 'vitest';
import { buildCombinedRequest } from './combinedRequest';
import type { SearchInput } from '../types/search';

/**
 * The Boolean request: AND inputs stay AND terms whatever their clitic
 * toggle, OR inputs stay OR terms, and the toggle rides on the term as
 * `clitics` for the engine. Nothing is expanded on the client.
 */
const inp = (query: string, cliticToggle = false, mode: SearchInput['mode'] = 'surface'): SearchInput => ({ id: 1, query, mode, cliticToggle });

describe('buildCombinedRequest', () => {
  it('keeps two toggled AND terms as two AND terms with the flag, and no OR terms', () => {
    const r = buildCombinedRequest({ andInputs: [inp('كتاب', true), inp('علم', true)], orInputs: [] });
    expect(r.and_terms).toEqual([
      { query: 'كتاب', mode: 'surface', clitics: true },
      { query: 'علم', mode: 'surface', clitics: true },
    ]);
    expect(r.or_terms).toEqual([]);
  });

  it('one toggled AND term is still an AND term', () => {
    const r = buildCombinedRequest({ andInputs: [inp('كتاب', true), inp('علم')], orInputs: [] });
    expect(r.and_terms.map((t) => t.query)).toEqual(['كتاب', 'علم']);
    expect(r.and_terms[0].clitics).toBe(true);
    expect(r.and_terms[1].clitics).toBeUndefined();
    expect(r.or_terms).toEqual([]);
  });

  it('OR inputs stay OR terms, with the flag when toggled', () => {
    const r = buildCombinedRequest({ andInputs: [inp('كتاب')], orInputs: [inp('علم', true), inp('حكمة')] });
    expect(r.and_terms).toEqual([{ query: 'كتاب', mode: 'surface' }]);
    expect(r.or_terms).toEqual([
      { query: 'علم', mode: 'surface', clitics: true },
      { query: 'حكمة', mode: 'surface' },
    ]);
  });

  it('the toggle only means something in surface mode, and blank inputs are dropped', () => {
    const r = buildCombinedRequest({ andInputs: [inp('كتاب', true, 'lemma'), inp('  ')], orInputs: [inp('', true)] });
    expect(r.and_terms).toEqual([{ query: 'كتاب', mode: 'lemma' }]);
    expect(r.or_terms).toEqual([]);
  });

  it('strips punctuation like the old path did', () => {
    const r = buildCombinedRequest({ andInputs: [inp('«كتاب»،', true)], orInputs: [] });
    expect(r.and_terms[0].query).toBe('كتاب');
  });
});
