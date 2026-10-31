import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MetadataTooltip, parseContent } from './Tooltip';

/**
 * The metadata card reads right to left. The labels on the right end on one
 * vertical line and the values on the left start on it, " - " between: a
 * label column sized to its widest label, labels set against its left edge,
 * values against the right edge of theirs.
 */
describe('metadata card', () => {
  it('sets labels and values against the line where they meet', () => {
    render(
      <MetadataTooltip
        book={{ title: 'كتاب الأغاني', author_id: 1, death_ah: 356, corpus: 'shamela' }}
        position={{ x: 100, y: 100 }}
        authorsMap={new Map([[1, 'أبو الفرج الأصفهاني']])}
      />
    );
    const grid = document.querySelector('[data-testid="tooltip"] [dir="rtl"]') as HTMLElement;
    expect(grid.className).toContain('grid-cols-[auto_1fr]');
    const cells = [...grid.children] as HTMLElement[];
    const labels = cells.filter((_, i) => i % 2 === 0);
    const values = cells.filter((_, i) => i % 2 === 1);
    expect(labels.map((el) => el.textContent)).toEqual(['Title -', 'Author -', 'Death -', 'Corpus Source -']);
    for (const el of labels) {
      expect(el.getAttribute('dir')).toBe('ltr');
      expect(el.className).toContain('text-left');
    }
    for (const el of values) expect(el.className).toContain('text-right');
    expect(values.map((el) => el.textContent)).toEqual(['كتاب الأغاني', 'أبو الفرج الأصفهاني', '356 AH', 'Shamela']);
    expect(grid.textContent).not.toContain(':');
  });
});

/**
 * An Arabic phrase in a tooltip is one right-to-left span, spaces and all.
 * Split word by word, each word was its own right-to-left box laid out left
 * to right, and the phrase read backwards.
 */
describe('tooltip content', () => {
  it('keeps an Arabic phrase in one right-to-left span', () => {
    const { container } = render(<>{parseContent('This will include a search for just the kunya and nisba, e.g. أبو منصور الأصبهاني')}</>);
    const rtl = [...container.querySelectorAll('span[dir="rtl"]')];
    expect(rtl.map((el) => el.textContent)).toEqual(['أبو منصور الأصبهاني']);
    expect(container.textContent).toBe('This will include a search for just the kunya and nisba, e.g. أبو منصور الأصبهاني');
  });

  it('leaves the space after a phrase in the surrounding text', () => {
    const { container } = render(<>{parseContent('Enter nasab, e.g. معمر بن أحمد and so on')}</>);
    const rtl = [...container.querySelectorAll('span[dir="rtl"]')];
    expect(rtl.map((el) => el.textContent)).toEqual(['معمر بن أحمد']);
    expect(container.textContent).toBe('Enter nasab, e.g. معمر بن أحمد and so on');
  });
});
