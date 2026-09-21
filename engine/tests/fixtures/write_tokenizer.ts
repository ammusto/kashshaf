/**
 * Writes engine/tests/fixtures/tokenizer.json: for a few bodies, the
 * stripped text, the char→token map and the 50-token snippet around a
 * token (first hit at most five in) as the app's tokenizer makes them, so
 * the engine's `snippet` module — which cuts a search row's body server-side
 * — is held to the app's own rule, and a row's `snippet_start_token` lines
 * the page's highlight indices up with the snippet's tokens.
 *
 *     npx tsx engine/tests/fixtures/write_tokenizer.ts
 */
import { writeFileSync } from 'node:fs';
import { buildCharToTokenMap, getSnippetRange, stripHtml } from '../../../packages/kashshaf-shared/src/utils/arabicTokenizer';

const MAX_TOKENS = 50;
const MAX_FROM_START = 5;

const words = (n: number, prefix = 'كلمة') => Array.from({ length: n }, (_, i) => `${prefix}${'ا'.repeat(i % 3)}`).join(' ');

const bodies: { label: string; body: string; center: number }[] = [
  { label: 'plain long', body: words(120), center: 40 },
  { label: 'hit near start', body: words(120), center: 2 },
  { label: 'hit at end', body: words(120), center: 119 },
  { label: 'short page', body: words(12), center: 7 },
  { label: 'html and breaks', body: `<title id=3 parent=1>باب الصلاة</title><br/>قال رسول الله صلى الله عليه وسلم: «من صلى» (12) <b>الفجر</b> ${words(60)}`, center: 8 },
  { label: 'punctuation, digits, latin, tashkil', body: `قَالَ، ثُمَّ 123 said abc الفَقِيهُ؛ ٱلْحَمْدُ… ${words(70, 'كلمةٌ')}`, center: 3 },
  { label: 'no tokens', body: '123 abc ...', center: 0 },
  { label: 'newlines survive', body: `سطر اول\nسطر ثان\n\n${words(55)}`, center: 4 },
];

const out = bodies.map(({ label, body, center }) => {
  const plain = stripHtml(body);
  const map = buildCharToTokenMap(plain);
  const total = map.reduce<number>((n, t) => (t === null ? n : Math.max(n, t + 1)), 0);
  const c = Math.min(center, Math.max(0, total - 1));
  const before = Math.min(c, MAX_FROM_START);
  const range = getSnippetRange(map, c, before, MAX_TOKENS - before - 1, MAX_FROM_START);
  const snippet = total === 0 ? plain : plain.slice(range.start, range.end);
  return { label, body, plain, map, center: c, snippet, start_token: total === 0 ? 0 : range.startToken };
});
writeFileSync(new URL('./tokenizer.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${out.length} bodies`);
