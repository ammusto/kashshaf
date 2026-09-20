import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { parseContent } from './Tooltip';

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
