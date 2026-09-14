import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/lab', () => ({
  labApi: { saveExport: vi.fn(async (name: string) => `C:/lab/exports/20260914-${name}`) },
}));

import { BOM, csvCell, toCsv, toJson, exportTable, type ExportColumn } from './exportTable';
import { labApi } from '../api/lab';

interface Row {
  key: string;
  count: number;
  note: string | null;
}

const columns: ExportColumn<Row>[] = [
  { key: 'key', label: 'Key', value: (r) => r.key },
  { key: 'count', label: 'Count', value: (r) => r.count },
  { key: 'note', label: 'Note, if any', value: (r) => r.note },
];

const rows: Row[] = [
  { key: 'قال', count: 3, note: null },
  { key: 'a "quoted" thing', count: 1, note: 'x,y' },
];

describe('csv', () => {
  it('quotes only what needs quoting and doubles inner quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('with,comma')).toBe('"with,comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3.5)).toBe('3.5');
  });

  it('starts with a UTF-8 BOM and uses CRLF, per spec §6.6', () => {
    const csv = toCsv(columns, rows);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1)).toBe('Key,Count,"Note, if any"\r\nقال,3,\r\n"a ""quoted"" thing",1,"x,y"\r\n');
  });
});

describe('json', () => {
  it('uses column keys and null for missing values', () => {
    const parsed = JSON.parse(toJson(columns, rows));
    expect(parsed).toEqual([
      { key: 'قال', count: 3, note: null },
      { key: 'a "quoted" thing', count: 1, note: 'x,y' },
    ]);
  });
});

describe('exportTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves to exports/ with the format extension and returns the path', async () => {
    const r = await exportTable('frequencies-lemma', 'csv', columns, rows);
    expect(labApi.saveExport).toHaveBeenCalledWith('frequencies-lemma.csv', expect.stringContaining('Key,Count'));
    expect(r.path).toBe('C:/lab/exports/20260914-frequencies-lemma.csv');
    // No OS dialog under test: the exports/ copy is the result.
    expect(r.savedAs).toBeNull();
  });
});
