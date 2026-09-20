import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnlineAPI, PAGE_URL_MAX } from './online';

/**
 * The page bundle's request shape for a name search: the displayed
 * patterns, as `name=` parameters of one GET under 2 KB; a request that
 * would not fit a URL goes as a POST body instead, as a guard that the
 * displayed patterns should never trigger.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload = String(input).includes('/page/matches/name')
        ? [1, 2]
        : { page: { id: 1, part_index: 0, page_id: 1, part_label: '1', page_number: '1', body: '', score: 1, matched_token_indices: [] }, tokens: [], matches: [3] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Nineteen displayed patterns of a full name form, as the sidebar shows
 * them (a kunya, a three-part nasab, a nisba, the boxes on): the shape and
 * length of the real list, about 150 encoded bytes each.
 */
const displayed = [
  'اب* منصور معمر بن احمد',
  'اب* منصور معمر بن احمد الاصبهاني',
  'اب* منصور معمر بن احمد بن زياد',
  'اب* منصور معمر بن احمد بن زياد الاصبهاني',
  'اب* منصور معمر الاصبهاني',
  'اب* منصور بن احمد',
  'اب* منصور بن احمد الاصبهاني',
  'اب* منصور بن احمد بن زياد',
  'اب* منصور بن احمد بن زياد الاصبهاني',
  'معمر بن احمد بن زياد',
  'معمر بن احمد بن زياد الاصبهاني',
  'معمر بن احمد الاصبهاني',
  'اب* منصور الاصبهاني',
  'اب* منصور معمر',
  'معمر',
  'معمر الاصبهاني',
  'معمر بن احمد',
  'المعروف بابي منصور',
  'المشهور بابي منصور',
];

describe('the page bundle for a name search', () => {
  it('sends the displayed patterns as one GET, well under the URL guard', async () => {
    const api = new OnlineAPI();
    const bundle = await api.getPageBundle(1, 0, 1, { tokens: true, namePatterns: displayed });
    expect(bundle?.matches).toEqual([3]);
    expect(calls).toHaveLength(1);
    const { url, method } = calls[0];
    expect(method).toBe('GET');
    const u = new URL(url);
    expect(u.pathname).toBe('/page');
    expect(u.searchParams.getAll('name')).toEqual(displayed);
    const sent = url.length - u.origin.length;
    expect(sent).toBeLessThanOrEqual(PAGE_URL_MAX);
    // Nineteen real patterns: about 2.9 KB once encoded, ~500 characters.
    expect(sent).toBeLessThan(3200);
  });

  it('falls back to a POST body past the guard, which the displayed patterns never reach', async () => {
    const api = new OnlineAPI();
    const huge = Array.from({ length: 300 }, (_, i) => `وابو منصور معمر بن احمد بن زياد الاصبهاني ${i}`);
    await api.getPageBundle(1, 0, 1, { tokens: true, namePatterns: huge });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(new URL(calls[0].url).pathname).toBe('/page');
    expect((calls[0].body as { names: string[] }).names).toEqual(huge);
    expect((calls[0].body as { include: string[] }).include).toEqual(['tokens']);
  });

  it("asks for a page's name highlights in one request, expanded by the server", async () => {
    const api = new OnlineAPI();
    const positions = await api.getNameMatchPositions(1, 0, 1, displayed, true);
    expect(positions).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(new URL(calls[0].url).pathname).toBe('/page/matches/name');
    expect(calls[0].body).toMatchObject({ patterns: displayed, expand: true });
  });
});
