/**
 * Writes engine/tests/fixtures/name_expansion.json: for a few name forms,
 * the display patterns the app shows and the search patterns it used to
 * send, so the engine's `expand_name_patterns` (which now does the
 * expansion server-side) is held to the app's own rule.
 *
 *     npx vite-node engine/tests/fixtures/write_name_expansion.ts
 */
import { writeFileSync } from 'node:fs';
import { createEmptyNameForm, generateDisplayPatterns, generateSearchPatterns, type NameFormData } from '../../../src/utils/namePatterns';

function form(over: Partial<NameFormData>): NameFormData {
  return { ...createEmptyNameForm('f'), ...over };
}

const cases: { label: string; form: NameFormData }[] = [
  { label: 'kunya + nasab + nisba', form: form({ kunyas: ['أبو منصور'], nasab: 'معمر بن أحمد بن زياد', nisbas: ['الأصبهاني'] }) },
  { label: 'nasab only', form: form({ nasab: 'أحمد بن زياد' }) },
  { label: 'kunya + nasab, rare boxes on', form: form({ kunyas: ['ابي بكر'], nasab: 'محمد بن عمر', nisbas: ['البغدادي'], allowRareKunyaNisba: true, allowKunyaNasab: true }) },
  { label: 'shuhra', form: form({ nasab: 'علي بن الحسين', shuhra: 'أبو الفرج' }) },
  { label: 'two kunyas, one-name boxes', form: form({ kunyas: ['ابو عبد الله', 'ابو الحسن'], nasab: 'محمد', allowOneNasab: true }) },
];

const out = cases.map(({ label, form }) => ({ label, display: generateDisplayPatterns(form), search: generateSearchPatterns(form) }));
writeFileSync(new URL('./name_expansion.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${out.length} forms, ${out.reduce((n, c) => n + c.search.length, 0)} search patterns`);
