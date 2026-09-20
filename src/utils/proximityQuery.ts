import type { ProximitySearchQuery, ProximityTerm } from '../types/search';
import { PROXIMITY_MAX_PAGE_TERMS, PROXIMITY_MAX_TERMS } from '../types/search';

/**
 * A proximity query as stored — in history, in a saved search — read back.
 *
 * Since 0.7.0 the query is a chain: `terms` (two or three), one `distances`
 * entry per link, `ordered`, and `pageTerms` that must be on the page. What
 * was stored before that is `{ term1, field1, term2, field2, distance }`,
 * which is the same thing with two terms; it comes back as such. Anything
 * else is null.
 */
export function normalizeProximityQuery(raw: unknown): ProximitySearchQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const term = (v: unknown): ProximityTerm | null => {
    if (!v || typeof v !== 'object') return null;
    const t = v as Record<string, unknown>;
    const query = typeof t.query === 'string' ? t.query : typeof t.term === 'string' ? t.term : '';
    const mode = t.mode ?? t.field;
    if (!query.trim()) return null;
    return { query, mode: mode === 'lemma' || mode === 'root' ? mode : 'surface' };
  };
  if (Array.isArray(r.terms)) {
    const terms = r.terms.map(term).filter((t): t is ProximityTerm => t !== null);
    if (terms.length < 2 || terms.length > PROXIMITY_MAX_TERMS) return null;
    const distances = Array.isArray(r.distances) ? r.distances.map((d) => clampDistance(Number(d))) : [];
    if (distances.length !== terms.length - 1) return null;
    const pageTerms = Array.isArray(r.pageTerms) ? r.pageTerms.map(term).filter((t): t is ProximityTerm => t !== null) : [];
    if (pageTerms.length > PROXIMITY_MAX_PAGE_TERMS) return null;
    return { terms, distances, ordered: r.ordered === true, pageTerms };
  }
  const t1 = term({ query: r.term1, mode: r.field1 });
  const t2 = term({ query: r.term2, mode: r.field2 });
  if (!t1 || !t2) return null;
  return { terms: [t1, t2], distances: [clampDistance(Number(r.distance))], ordered: false, pageTerms: [] };
}

export function clampDistance(d: number): number {
  if (!Number.isFinite(d)) return 1;
  return Math.max(1, Math.min(100, Math.round(d)));
}

/** The chain alone, for a tab's title: `A ~3 B ~5 C`. */
export function proximityChainLabel(q: ProximitySearchQuery): string {
  return q.terms.map((t, i) => (i === 0 ? t.query : `~${q.distances[i - 1]} ${t.query}`)).join(' ');
}

/**
 * The whole query, as the results header states it: the chain, whether it
 * is ordered, and the page terms if any.
 *
 *     قال ~3 الله ~5 رسول · ordered · also on the page: النبي, الصلاة
 */
export function describeProximityQuery(q: ProximitySearchQuery): string {
  const parts = [proximityChainLabel(q), q.ordered ? 'ordered' : 'unordered'];
  if (q.pageTerms.length > 0) parts.push(`also on the page: ${q.pageTerms.map((t) => t.query).join(', ')}`);
  return parts.join(' · ');
}
