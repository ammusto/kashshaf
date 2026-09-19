/**
 * Marks along the reader's hot paths, for the Performance panel and for
 * `performance.getEntriesByType('measure')`: opening a book from a result
 * is several round trips and renders, and which one is slow on a 33,000-page
 * book is not visible without them. Nothing here throws where
 * `performance` is missing.
 */

export function perfMark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* an environment without the API */
  }
}

/** A measure from `from` to now, named `name`, if the start mark exists. */
export function perfMeasure(name: string, from: string): void {
  try {
    if (performance.getEntriesByName(from, 'mark').length === 0) return;
    performance.measure(name, from);
  } catch {
    /* an environment without the API */
  }
}

/** Drop the marks of a path before it is walked again. */
export function perfReset(prefix: string): void {
  try {
    for (const e of performance.getEntriesByType('mark')) if (e.name.startsWith(prefix)) performance.clearMarks(e.name);
    for (const e of performance.getEntriesByType('measure')) if (e.name.startsWith(prefix)) performance.clearMeasures(e.name);
  } catch {
    /* an environment without the API */
  }
}
