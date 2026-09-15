/**
 * Arabic normalisation for *searching metadata* — titles, author names,
 * genre names.
 *
 * This is deliberately separate from `arabicTokenizer.ts`. That module is the
 * token-alignment contract with the pipeline and must not move; this one only
 * decides whether a reader's typing matches a title, and is free to be as
 * forgiving as a catalogue search should be. Both Kashshaf's Metadata Browser
 * and Kashshaf Lab's text browser call it, so the two answer a query alike.
 *
 * It strips the diacritics and unifies the letters that a cataloguer may have
 * written either way: the hamza carriers, the two yāʾs, the Persian kāf and
 * yāʾ, and tāʾ marbūṭa's Urdu form.
 */

// U+064B to U+065F (the tashkil block), U+0670 (the superscript alif)
// and U+0671 (the alif wasla). The range stops at U+065F on purpose:
// extending it to U+0670 would swallow the Arabic-Indic digits.
const DIACRITICS = /[ً-ٰٟٱ]/g;

export function normalizeArabicForSearch(text: string): string {
  return text
    .replace(DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[یے]/g, 'ي')
    .replace(/[ۀە]/g, 'ه')
    .replace(/ۃ/g, 'ة')
    .toLowerCase();
}
