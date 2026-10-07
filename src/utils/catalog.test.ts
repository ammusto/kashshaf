import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookMetadata } from '../types';
import type { SearchAPI } from '../api';
import { centuryOf, isLightRow, fetchFullBook, resetFullRowCache, withExportFields } from './catalog';

/**
 * The light catalogue's helpers: the century the pipeline would have
 * stamped, what counts as a light row, the once-per-book full fetch, and
 * the export's one-request fill of its extra columns.
 */

const light = (id: number): BookMetadata => ({ id, title: `كتاب ${id}`, author_id: 1, death_ah: 450, genre_id: 2, page_count: 10, token_count: 100, parts: 1 });
const full = (id: number): BookMetadata => ({ ...light(id), corpus: 'shamela', original_id: `s${id}`, paginated: true, tags: '[]', metadata_json: '{}', citation_json: '{"title":"x"}' });

describe('centuryOf', () => {
  it('is the ceiling of the death year over 100, and 1 for a year of 0', () => {
    expect(centuryOf(450)).toBe(5);
    expect(centuryOf(500)).toBe(5);
    expect(centuryOf(501)).toBe(6);
    expect(centuryOf(1)).toBe(1);
    expect(centuryOf(0)).toBe(1);
    expect(centuryOf(null)).toBeUndefined();
    expect(centuryOf(undefined)).toBeUndefined();
  });
});

describe('isLightRow', () => {
  it('tells a catalogue row from a full one', () => {
    expect(isLightRow(light(1))).toBe(true);
    expect(isLightRow(full(1))).toBe(false);
    // A full row whose optional strings are null is still full.
    expect(isLightRow({ ...light(1), metadata_json: null as unknown as string, citation_json: null as unknown as string, tags: null as unknown as string })).toBe(false);
  });
});

describe('fetchFullBook', () => {
  beforeEach(() => resetFullRowCache());

  it('fetches a light row once and returns a full row as it is', async () => {
    const api = { getBook: vi.fn(async (id: number) => full(id)) } as unknown as SearchAPI;
    const a = await fetchFullBook(api, light(7));
    const b = await fetchFullBook(api, light(7));
    expect(a?.metadata_json).toBe('{}');
    expect(b).toBe(a);
    expect(api.getBook).toHaveBeenCalledTimes(1);
    await fetchFullBook(api, full(8));
    expect(api.getBook).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed fetch so the next try asks again', async () => {
    const getBook = vi.fn<(id: number) => Promise<BookMetadata | null>>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(full(7));
    const api = { getBook } as unknown as SearchAPI;
    await expect(fetchFullBook(api, light(7))).rejects.toThrow('down');
    expect((await fetchFullBook(api, light(7)))?.id).toBe(7);
    expect(getBook).toHaveBeenCalledTimes(2);
  });
});

describe('withExportFields', () => {
  it('fills the export columns of light rows in one request and leaves full rows alone', async () => {
    const getExportFields = vi.fn(async (ids: number[]) => ids.filter((id) => id !== 3).map((id) => ({ id, citation_json: `{"id":${id}}`, paginated: false, corpus: 'openiti', original_id: `o${id}` })));
    const api = { getExportFields } as unknown as SearchAPI;
    const out = await withExportFields(api, [light(1), full(2), light(3)]);
    expect(getExportFields).toHaveBeenCalledTimes(1);
    expect(getExportFields).toHaveBeenCalledWith([1, 3]);
    expect(out[0]).toMatchObject({ id: 1, citation_json: '{"id":1}', corpus: 'openiti', original_id: 'o1', paginated: false });
    expect(out[1]).toEqual(full(2));
    // Unknown to the server: keeps what it had.
    expect(out[2]).toEqual(light(3));
  });

  it('asks nothing when every row is full', async () => {
    const getExportFields = vi.fn();
    const api = { getExportFields } as unknown as SearchAPI;
    const rows = [full(1), full(2)];
    expect(await withExportFields(api, rows)).toBe(rows);
    expect(getExportFields).not.toHaveBeenCalled();
  });
});
