import { describe, it, expect } from 'vitest';
import { buildCharToTokenMap, getTokenCount, stripHtml } from './arabicTokenizer';

/**
 * The alignment contract (Lab spec §3.3): token `idx` as the pipeline and the
 * backends report it must equal the index this tokenizer produces for the same
 * page body. `lab/src-tauri/src/analysis/align.rs` is a port of the counting
 * rules below and `verify_alignment` checks real pages against it; these cases
 * are the shared fixtures, so a change on either side fails on both.
 */

/** What both implementations agree on: the number of tokens in a page body. */
function count(body: string): number {
  return getTokenCount(buildCharToTokenMap(stripHtml(body)));
}

describe('token counting', () => {
  const cases: [string, string, number][] = [
    ['empty', '', 0],
    ['one word', 'كتاب', 1],
    ['three words', 'قال رسول الله', 3],
    ['collapses runs of whitespace', '  قال   رسول \n\n الله  ', 3],
    ['tashkil stays inside its word', 'قَالَ رَسُولُ اللَّهِ', 3],
    ['superscript alef stays inside its word', 'هَٰذَا', 1],
    // strip_punct / strip_latin / strip_digits run BEFORE tokenization in the
    // pipeline, so a stripped character never splits a word.
    ['punctuation does not split a word', 'كتا.ب', 1],
    ['punctuation between words is not a word', 'قال، رسول', 2],
    ['digits do not split a word', 'كتا5ب', 1],
    ['arabic-indic digits do not split a word', 'كتا٥ب', 1],
    ['latin letters do not split a word', 'كتاxب', 1],
    ['a digit-only run is not a token', 'قال 123 رسول', 2],
    ['a latin-only run is not a token', 'قال abc رسول', 2],
    ['bare punctuation is not a token', 'قال ، رسول', 2],
    ['hyphen is stripped, not a boundary', 'عبد-الله', 1],
    ['aya brackets are stripped', '﴿الحمد لله﴾', 2],
  ];
  for (const [name, text, expected] of cases) {
    it(name, () => expect(count(text)).toBe(expected));
  }
});

describe('stripHtml', () => {
  // A tag is removed without a separator in its place, so a heading that ends
  // flush against the following word merges with it. That is not a bug to fix
  // here: the pipeline strips tags the same way, and the two agree on every
  // page of the sample corpus (822 of its 13,958 tags sit flush against text
  // on both sides). Changing this would break the contract, not mend it.
  it('removes a tag without putting a separator in its place', () => {
    expect(count('<title id="1" parent="0">باب الإيمان</title>قال رسول')).toBe(3);
    expect(count('<title id="1" parent="0">باب الإيمان</title>\nقال رسول')).toBe(4);
  });

  it('keeps the words apart when the body separates them, as real pages do', () => {
    expect(count('نص\n<title id=1 parent=0> باب الإيمان</title>\nقال رسول')).toBe(5);
  });

  it('leaves an unclosed angle bracket as stripped punctuation, not a boundary', () => {
    // `<[^>]*>` needs a closing '>' to match, so the '<' survives stripHtml —
    // and '<' is itself in the stripped set, so the words merge.
    expect(stripHtml('قال < رسول')).toBe('قال < رسول');
    expect(count('قال<رسول')).toBe(1);
  });

  it('turns <br> into a newline, which is a word boundary', () => {
    expect(stripHtml('قال<br/>رسول')).toBe('قال\nرسول');
    expect(count('قال<br/>رسول')).toBe(2);
  });
});

describe('char-to-token map', () => {
  it('maps every character of a word to that word’s index', () => {
    const map = buildCharToTokenMap('قال رسول');
    expect(map.slice(0, 3)).toEqual([0, 0, 0]);
    expect(map[3]).toBeNull();               // the space
    expect(map.slice(4)).toEqual([1, 1, 1, 1]);
  });

  it('maps stripped characters to null without advancing the index', () => {
    const map = buildCharToTokenMap('كتا.ب');
    expect(map).toEqual([0, 0, 0, null, 0]);
  });

  it('does not emit an index for a trailing boundary', () => {
    expect(getTokenCount(buildCharToTokenMap('قال '))).toBe(1);
    expect(getTokenCount(buildCharToTokenMap('قال'))).toBe(1);
  });
});
