import { describe, it, expect } from 'vitest';
import { createEmptyNameForm, expandDisplayPatterns, generateDisplayPatterns, generateSearchPatterns, type NameFormData } from './namePatterns';

/**
 * The app sends a name form's displayed patterns (`اب* منصور`, no
 * proclitics) and the server expands them. `expandDisplayPatterns` is the
 * client's copy of that rule, for the fallback against a server that
 * predates it, and must give exactly the search patterns the app used to
 * send: the engine's `expand_name_patterns` is held to the same fixture
 * (engine/tests/fixtures/name_expansion.json, written from these functions).
 */

function form(over: Partial<NameFormData>): NameFormData {
  return { ...createEmptyNameForm('f'), ...over };
}

const FORMS: [string, NameFormData][] = [
  ['kunya + nasab + nisba', form({ kunyas: ['أبو منصور'], nasab: 'معمر بن أحمد بن زياد', nisbas: ['الأصبهاني'] })],
  ['rare boxes', form({ kunyas: ['ابي بكر'], nasab: 'محمد بن عمر', nisbas: ['البغدادي'], allowRareKunyaNisba: true, allowKunyaNasab: true })],
  ['shuhra', form({ nasab: 'علي بن الحسين', shuhra: 'أبو الفرج' })],
  ['two kunyas', form({ kunyas: ['ابو عبد الله', 'ابو الحسن'], nasab: 'محمد', allowOneNasab: true, allowTwoNasab: true })],
];

describe('name patterns: displayed, and expanded by the server', () => {
  it.each(FORMS)('%s: expanding the displayed patterns gives the search patterns', (_label, f) => {
    const display = generateDisplayPatterns(f);
    const expanded = new Set(expandDisplayPatterns(display));
    const search = new Set(generateSearchPatterns(f));
    expect(expanded).toEqual(search);
  });

  it('the displayed list is about a fifteenth of the expanded one, and fits a URL', () => {
    const f = FORMS[0][1];
    const display = generateDisplayPatterns(f);
    const search = generateSearchPatterns(f);
    expect(display.length).toBeGreaterThan(0);
    expect(search.length).toBe(display.length * 15);
    const params = new URLSearchParams();
    for (const n of display) params.append('name', n);
    expect(`/page?id=1&part_index=0&page_id=1&include=tokens&${params}`.length).toBeLessThan(2048);
  });

  it('a kunya expands to three forms with their proclitics, once each', () => {
    const out = expandDisplayPatterns(['اب* منصور', 'اب* منصور']);
    expect(out).toHaveLength(18);
    expect(out[0]).toBe('ابو منصور');
    expect(out).toContain('كابي منصور');
  });
});
