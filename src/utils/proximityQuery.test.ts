import { describe, it, expect } from 'vitest';
import { describeProximityQuery, normalizeProximityQuery, proximityChainLabel } from './proximityQuery';

describe('normalizeProximityQuery', () => {
  it('reads the two-term shape stored before 0.7.0 as a pair', () => {
    expect(normalizeProximityQuery({ type: 'proximity', term1: 'قال', field1: 'surface', term2: 'الله', field2: 'lemma', distance: 5 })).toEqual({
      terms: [
        { query: 'قال', mode: 'surface' },
        { query: 'الله', mode: 'lemma' },
      ],
      distances: [5],
      ordered: false,
      pageTerms: [],
    });
  });

  it('reads a chain with its ordering and page terms', () => {
    const q = {
      terms: [
        { query: 'a', mode: 'surface' },
        { query: 'b', mode: 'root' },
        { query: 'c', mode: 'lemma' },
      ],
      distances: [3, 4],
      ordered: true,
      pageTerms: [{ query: 'x', mode: 'surface' }],
    };
    expect(normalizeProximityQuery(q)).toEqual(q);
  });

  it('rejects what cannot be searched', () => {
    expect(normalizeProximityQuery(null)).toBeNull();
    expect(normalizeProximityQuery({ terms: [{ query: 'a', mode: 'surface' }], distances: [] })).toBeNull();
    expect(normalizeProximityQuery({ terms: [{ query: 'a', mode: 'surface' }, { query: 'b', mode: 'surface' }], distances: [1, 2] })).toBeNull();
    expect(normalizeProximityQuery({ term1: 'a', field1: 'surface', distance: 1 })).toBeNull();
  });

  it('clamps a distance and defaults an unknown mode', () => {
    const q = normalizeProximityQuery({ term1: 'a', field1: 'stem', term2: 'b', field2: 'root', distance: 0 });
    expect(q?.distances).toEqual([1]);
    expect(q?.terms[0].mode).toBe('surface');
  });
});

describe('the description', () => {
  const q = {
    terms: [
      { query: 'قال', mode: 'surface' as const },
      { query: 'الله', mode: 'surface' as const },
      { query: 'رسول', mode: 'lemma' as const },
    ],
    distances: [3, 5],
    ordered: true,
    pageTerms: [{ query: 'النبي', mode: 'surface' as const }, { query: 'الصلاة', mode: 'lemma' as const }],
  };

  it('states the chain, the ordering and the page terms', () => {
    expect(proximityChainLabel(q)).toBe('قال ~3 الله ~5 رسول');
    expect(describeProximityQuery(q)).toBe('قال ~3 الله ~5 رسول · ordered · also on the page: النبي, الصلاة');
    expect(describeProximityQuery({ ...q, ordered: false, pageTerms: [] })).toBe('قال ~3 الله ~5 رسول · unordered');
  });
});
