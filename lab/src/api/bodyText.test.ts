import { describe, it, expect } from 'vitest';
import { stripHtml } from '@kashshaf/shared';
import { readBody, headingAt } from './bodyText';

/**
 * The reader's text must stay byte-for-byte what `stripHtml` produces, because
 * `buildCharToTokenMap` runs on it and every stored span is a token index into
 * the result. These check that the heading positions come for free.
 */

describe('readBody', () => {
  it('produces exactly stripHtml, so token indices do not move', () => {
    const bodies = [
      'قال رسول الله',
      '<title id=3 parent=0>باب الزهد</title>\nحدثنا أبو بكر',
      'سطر<br/>سطر آخر',
      'نص <span class="x">داخلي</span> هنا',
      '<title id=1 parent=0>مقدمة',
      '',
    ];
    for (const b of bodies) {
      expect(readBody(b).plain).toBe(stripHtml(b));
    }
  });

  it('keeps the newlines that were in the body', () => {
    const { plain } = readBody('البيت الأول\nالبيت الثاني\nالبيت الثالث');
    expect(plain.split('\n')).toHaveLength(3);
  });

  it('turns a line break tag into a newline, as stripHtml does', () => {
    expect(readBody('سطر<br/>سطر').plain).toBe('سطر\nسطر');
  });

  it('reports where a heading lands in the stripped text', () => {
    const body = '<title id=7 parent=3>باب التواضع</title>\nحدثنا';
    const { plain, headings } = readBody(body);
    expect(headings).toHaveLength(1);
    const h = headings[0];
    expect(plain.slice(h.start, h.end)).toBe('باب التواضع');
    expect(h.id).toBe(7);
    expect(h.parent).toBe(3);
  });

  it('finds several headings on one page, with their ids', () => {
    const body = '<title id=1 parent=0>الأول</title> نص <title id=2 parent=1>الثاني</title> نص آخر';
    const { plain, headings } = readBody(body);
    expect(headings.map((h) => plain.slice(h.start, h.end))).toEqual(['الأول', 'الثاني']);
    expect(headings.map((h) => h.id)).toEqual([1, 2]);
  });

  it('treats a heading cut off by the page end as a heading', () => {
    const { plain, headings } = readBody('نص <title id=9 parent=0>باب لم يكتمل');
    expect(headings).toHaveLength(1);
    expect(plain.slice(headings[0].start, headings[0].end)).toBe('باب لم يكتمل');
  });

  it('ignores an unopened closing tag rather than throwing', () => {
    const { headings } = readBody('نص </title> بعده');
    expect(headings).toEqual([]);
  });

  it('locates a position inside a heading', () => {
    const { headings } = readBody('<title id=4 parent=0>باب</title> نص');
    expect(headingAt(headings, 0)?.id).toBe(4);
    expect(headingAt(headings, 2)?.id).toBe(4);
    expect(headingAt(headings, 3)).toBeNull();
    expect(headingAt(headings, 10)).toBeNull();
  });
});
