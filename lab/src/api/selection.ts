/**
 * Reading the browser's own text selection back as a token range.
 *
 * The reader used to capture the mouse to paint a token range, which made
 * the page behave unlike any other text: you could not select a line, or
 * copy one. Now the selection is the browser's, and this turns whatever the
 * reader selected into the `[start, end)` that every stored span is
 * expressed in, by looking at the `data-token` the spans still carry.
 */

/** The token a node sits inside, or null when it is outside the text. */
function tokenOf(node: Node | null): number | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el) {
    const attr = el.getAttribute?.('data-token');
    if (attr != null) {
      const n = Number(attr);
      if (Number.isFinite(n)) return n;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * The token range the current selection covers, within `container`.
 *
 * Null when nothing is selected, when the selection is collapsed, or when it
 * lies outside the text. The range is half-open and always ascending, so a
 * backwards drag gives the same answer as a forwards one.
 */
export function tokenRangeOfSelection(container: HTMLElement | null): [number, number] | null {
  if (!container) return null;
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  // The ends may land on whitespace between two tokens, so fall back to
  // every token the range actually intersects.
  let lo = tokenOf(range.startContainer);
  let hi = tokenOf(range.endContainer);

  if (lo == null || hi == null) {
    const touched: number[] = [];
    for (const el of container.querySelectorAll('[data-token]')) {
      if (range.intersectsNode(el)) {
        const n = Number(el.getAttribute('data-token'));
        if (Number.isFinite(n)) touched.push(n);
      }
    }
    if (touched.length === 0) return null;
    lo = Math.min(...touched);
    hi = Math.max(...touched);
  }

  const start = Math.min(lo, hi);
  const end = Math.max(lo, hi) + 1;
  return start < end ? [start, end] : null;
}

/** The selected text itself, for showing what is about to be analysed. */
export function selectedText(): string {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  return sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
}
