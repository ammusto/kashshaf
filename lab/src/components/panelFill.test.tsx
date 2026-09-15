import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every panel fills the window (Phase 8 A).
 *
 * A flex item with no `flex-grow` sizes to its content, so a panel whose root
 * was only `flex` occupied as much of the row as its widest child needed and
 * left the rest dead. Four panels were built that way. Phase 7 reported Stats
 * fixed after changing its padding, which was a symptom: the root still could
 * not grow.
 *
 * This reads the source rather than rendering, because jsdom does no layout
 * and would report every width as zero. What it checks is the rule that makes
 * filling possible, which is the thing that was missing.
 */

const ROOT = join(__dirname);

/** Panel name, file, and the test id its root element carries. */
const PANELS: Array<[string, string, string]> = [
  ['Metadata', 'workspace/MetadataPanel.tsx', 'metadata-panel'],
  ['Read', 'read/ReadPanel.tsx', 'read-panel'],
  ['Stats', 'stats/StatsPanel.tsx', 'stats-panel'],
  ['Isnād', 'isnad/IsnadWorkbench.tsx', 'isnad-panel'],
  ['Reuse', 'reuse/ReusePanel.tsx', 'reuse-panel'],
  ['Qurʾān', 'quran/QuranPanel.tsx', 'quran-panel'],
  ['Network', 'network/NetworkPanel.tsx', 'network-panel'],
  ['Poetry', 'poetry/PoetryPanel.tsx', 'poetry-panel'],
];

/** The opening tag of the element carrying this test id, however many lines
 *  it is written over. */
function rootElement(source: string, testId: string): string {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => l.includes(`data-testid="${testId}"`));
  expect(at, `nothing carries data-testid="${testId}"`).toBeGreaterThanOrEqual(0);
  let from = at;
  while (from > 0 && !lines[from].trimStart().startsWith('<')) from -= 1;
  let to = at;
  while (to < lines.length - 1 && !lines[to].trimEnd().endsWith('>')) to += 1;
  return lines
    .slice(from, to + 1)
    .map((l) => l.trim())
    .join(' ');
}

describe('every panel fills the window', () => {
  for (const [name, file, testId] of PANELS) {
    it(`${name} grows to fill its row`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const root = rootElement(source, testId);

      // flex-grow, or it is only as wide as its content.
      expect(root, `${name}'s root must grow: ${root}`).toMatch(/\bflex-1\b/);
      // and it must be allowed to shrink, or a wide child pushes it out.
      expect(root, `${name}'s root must be able to shrink: ${root}`).toMatch(/\bmin-w-0\b/);
      // and it must not cap its own width.
      expect(root, `${name}'s root must not cap its width: ${root}`).not.toMatch(/\bmax-w-/);
      // min-h-0 lets an inner scroller work rather than growing the page.
      expect(root, `${name}'s root needs min-h-0: ${root}`).toMatch(/\bmin-h-0\b/);
    });
  }

  it('the shell puts panels in a row that can shrink', () => {
    const app = readFileSync(join(ROOT, '..', 'App.tsx'), 'utf8');
    // The row holding the rail and the panel.
    expect(app).toMatch(/<div className="flex-1 flex min-h-0">/);
    // And nothing between the shell and the panel caps the width.
    const boundary = readFileSync(join(ROOT, 'ui', 'PanelBoundary.tsx'), 'utf8');
    expect(boundary).toContain('if (!error) return this.props.children;');
  });
});
