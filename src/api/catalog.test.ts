import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnlineAPI, catalogUrl } from './online';

/**
 * The catalogue comes from the CDN, at the keyed name /health reports or,
 * from an older server, by its corpus version, and falls back to the API's
 * /books when the file is absent for
 * that version (4.3.0 was published before the catalogue existed), when
 * the CDN fails, or when /health gives no version.
 */

let urls: string[];
let cdnStatus: number;
let healthBody: unknown;

const ROWS = [{ id: 1, title: 'كتاب', author_id: 1, death_ah: 450, genre_id: 2, page_count: 3, token_count: 4, parts: 1 }];

beforeEach(() => {
  urls = [];
  cdnStatus = 200;
  healthBody = { corpus_version: '4.4.0' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/health')) return new Response(JSON.stringify(healthBody), { status: 200 });
      if (url.startsWith('https://cdn.kashshaf.com/')) {
        if (cdnStatus === -1) throw new TypeError('network down');
        return new Response(cdnStatus === 200 ? JSON.stringify(ROWS) : 'no', { status: cdnStatus });
      }
      if (url.endsWith('/books')) return new Response(JSON.stringify(ROWS.map((r) => ({ ...r, from: 'api' }))), { status: 200 });
      return new Response('{}', { status: 404 });
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

const api = () => new OnlineAPI();

describe('the catalogue', () => {
  it('comes from the CDN at the corpus version /health reports, and /books is not asked', async () => {
    const rows = await api().getAllBooks();
    expect(rows).toEqual(ROWS);
    expect(urls.some((u) => u === catalogUrl('4.4.0'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/books'))).toBe(false);
  });

  it('comes from the file /health names by metadata.db hash, when it names one', async () => {
    healthBody = { corpus_version: '4.4.0', catalog: 'catalog/4.4.0/books.33774ec4c0d9.json' };
    expect(await api().getAllBooks()).toEqual(ROWS);
    expect(urls).toContain('https://cdn.kashshaf.com/catalog/4.4.0/books.33774ec4c0d9.json');
    expect(urls).not.toContain(catalogUrl('4.4.0'));
  });

  it('ignores a /health catalogue that is not a keyed catalogue path', async () => {
    healthBody = { corpus_version: '4.4.0', catalog: '../../evil.json' };
    expect(await api().getAllBooks()).toEqual(ROWS);
    expect(urls).toContain(catalogUrl('4.4.0'));
    expect(urls.some((u) => u.includes('evil'))).toBe(false);
  });

  it('falls back to /books when the file is absent for the version', async () => {
    cdnStatus = 404;
    const rows = await api().getAllBooks();
    expect(rows[0]).toMatchObject({ id: 1, from: 'api' });
  });

  it('falls back to /books when the CDN cannot be reached', async () => {
    cdnStatus = -1;
    expect((await api().getAllBooks())[0]).toMatchObject({ from: 'api' });
  });

  it('falls back to /books when /health has no usable version', async () => {
    healthBody = {};
    expect((await api().getAllBooks())[0]).toMatchObject({ from: 'api' });
    expect(urls.some((u) => u.startsWith('https://cdn.kashshaf.com/'))).toBe(false);
    healthBody = { corpus_version: '../x' };
    urls = [];
    expect((await api().getAllBooks())[0]).toMatchObject({ from: 'api' });
    expect(urls.some((u) => u.startsWith('https://cdn.kashshaf.com/'))).toBe(false);
  });
});
