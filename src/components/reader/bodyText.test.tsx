import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Token } from '../../types';
import { buildCharToTokenMap, getTokenCount, stripHtml } from '@kashshaf/shared';
import { PageView, toRuns, groupRuns } from './PageView';

/**
 * Line breaks and headings in the reader (corpus 4.4.0: a median of six
 * newlines a page, none of them a `<br>`; 284 of 2,345 headings flush
 * against the next word).
 *
 * Before: a newline survived only when it stood alone between two words;
 * one that touched punctuation, a digit or a space shared its run with them,
 * went into a span, and CSS collapsed it. 47% of the corpus's newlines were
 * lost that way. Headings were stripped with nothing in their place.
 */

const tok = (idx: number, surface: string): Token => ({ idx, surface, lemma: surface, pos: 'noun', features: [], clitics: [] });

function mount(body: string, tokens: Token[]) {
  return render(
    <PageView
      index={0}
      body={body}
      tokens={tokens}
      matched={[]}
      label="1"
      startsPart={false}
      partLabel="1"
      onWordClick={vi.fn()}
      onMeasure={vi.fn()}
      onMount={vi.fn()}
    />
  );
}

describe('line breaks in the reader', () => {
  it('keeps a newline that follows punctuation, where the old <br> rule lost it', () => {
    const body = 'البيت الأول،\nالبيت الثاني.\n٢ - البيت الثالث';
    const { getByTestId } = mount(body, [0, 1, 2, 3, 4, 5].map((i) => tok(i, 'x')));
    const text = getByTestId('page-text');
    expect(text.className).toContain('whitespace-pre-line');
    // The text node still carries the three lines; pre-line draws them.
    expect(text.textContent).toBe(body);
    expect(text.textContent?.split('\n')).toHaveLength(3);
  });

  it('keeps the token map untouched: indices are those of the stripped body', () => {
    // No separator is inserted where the tag was, so الزهد and حدثنا are one
    // token (the contract); the heading boundary only splits its rendering.
    const body = '<title id=3 parent=0>باب الزهد</title>حدثنا أبو بكر';
    const { container } = mount(body, [0, 1, 2, 3].map((i) => tok(i, 'x')));
    const indices = Array.from(container.querySelectorAll('[data-token]')).map((el) => Number(el.getAttribute('data-token')));
    expect(indices).toEqual([0, 1, 1, 2, 3]);
    expect(new Set(indices).size).toBe(getTokenCount(buildCharToTokenMap(stripHtml(body))));
  });

  it('draws a heading in its own colour, inline, with its words still clickable', () => {
    const body = '<title id=3 parent=0>باب الزهد</title>حدثنا أبو بكر';
    const { container } = mount(body, [0, 1, 2, 3].map((i) => tok(i, 'x')));
    const heading = container.querySelector('[data-heading="3"]') as HTMLElement;
    expect(heading).not.toBeNull();
    expect(heading.className).toBe('text-app-heading');
    expect(heading.textContent).toBe('باب الزهد');
    expect(heading.querySelectorAll('[data-token]')).toHaveLength(2);
    // The heading's last word and the prose's first word are one token in the
    // contract (no separator is inserted); the colour boundary is visual only.
    expect(container.querySelector('[data-token="1"]')?.textContent).toBe('الزهد');
  });

  it('a marker before a heading stays beside it: no break is added on either side', () => {
    const body = '*<title id=3 parent=0>باب الزهد</title>\nحدثنا';
    const { getByTestId } = mount(body, [0, 1, 2].map((i) => tok(i, 'x')));
    // Exactly the stripped body: the star, the heading, then the one newline
    // the corpus wrote, then the prose.
    expect(getByTestId('page-text').textContent).toBe('*باب الزهد\nحدثنا');
  });
});

describe('toRuns and groupRuns', () => {
  it('a heading is a boundary like a highlight, and carries its id', () => {
    const plain = 'باب نص';
    const map = buildCharToTokenMap(plain);
    const runs = toRuns(plain, map, new Set(), new Set(), [{ start: 0, end: 3, id: 9, parent: 0 }]);
    expect(runs.map((r) => [r.text, r.heading])).toEqual([
      ['باب', 9],
      [' ', undefined],
      ['نص', undefined],
    ]);
  });

  it('groups a heading into one span and keeps the newline after it', () => {
    const plain = 'باب الزهد\nنص';
    const map = buildCharToTokenMap(plain);
    const groups = groupRuns(toRuns(plain, map, new Set(), new Set(), [{ start: 0, end: 9, id: 1, parent: 0 }]));
    expect(groups).toHaveLength(3);
    const [heading, gap, rest] = groups;
    expect('runs' in heading && heading.runs.map((r) => r.text)).toEqual(['باب', ' ', 'الزهد']);
    expect('text' in gap && gap.text).toBe('\n');
    expect('text' in rest && rest.text).toBe('نص');
  });

  it('without headings the runs are what they always were', () => {
    const runs = toRuns('ab cd', [0, 0, null, 1, 1], new Set([0, 1]), new Set([0, 1, 3, 4]));
    expect(runs).toEqual([
      { text: 'ab', token: 0, highlighted: true, secondary: false },
      { text: ' ', token: null, highlighted: false, secondary: false },
      { text: 'cd', token: 1, highlighted: false, secondary: true },
    ]);
  });
});
