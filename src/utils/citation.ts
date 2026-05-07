/**
 * Citation formatting for MLA and Chicago bibliographic styles.
 *
 * Source data is the `citation_json` column on each book in metadata.db. The
 * structure is fixed (see CitationData below) but most fields are optional, so
 * formatters skip whatever's missing. Volume/page are passed in separately
 * from the reader since they reflect what the user is currently looking at,
 * not metadata about the book.
 */

export type CitationStyle = 'mla' | 'chicago';

export interface CitationData {
  title: string;
  authors: string[];
  editors: string[];
  translators: string[];
  arrangers: string[];
  place: string | null;
  publisher: string | null;
  date: string | null;
  edition: string | null;
  volumes: string | null;
  warnings: string[];
}

export interface CitationOptions {
  /** Volume label as printed (e.g. "1", "الجزء الأول"). */
  volume?: string;
  /** Page number as printed (e.g. "23", "أ"). */
  page?: string;
  /** Whether to append the vol/page reference to the citation. */
  includePageRef?: boolean;
}

export function parseCitation(jsonStr?: string | null): CitationData | null {
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter((x: unknown) => typeof x === 'string') : [],
      editors: Array.isArray(parsed.editors) ? parsed.editors.filter((x: unknown) => typeof x === 'string') : [],
      translators: Array.isArray(parsed.translators) ? parsed.translators.filter((x: unknown) => typeof x === 'string') : [],
      arrangers: Array.isArray(parsed.arrangers) ? parsed.arrangers.filter((x: unknown) => typeof x === 'string') : [],
      place: typeof parsed.place === 'string' ? parsed.place : null,
      publisher: typeof parsed.publisher === 'string' ? parsed.publisher : null,
      date: typeof parsed.date === 'string' ? parsed.date : null,
      edition: typeof parsed.edition === 'string' ? parsed.edition : null,
      volumes: typeof parsed.volumes === 'string' ? parsed.volumes : null,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((x: unknown) => typeof x === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** Join non-empty parts with a separator, ignoring null/undefined/empty strings. */
function joinClean(parts: (string | null | undefined)[], sep: string): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

/**
 * Format as Chicago bibliographic-style citation.
 *
 * Example output:
 *   al-Muḥāsibī, al-Ḥārith. *Al-tawahhum*. Aleppo: Maktabat al-Turāth al-Islāmī.
 *   Vol. 1, p. 23.
 */
export function formatChicago(c: CitationData, opts: CitationOptions = {}): string {
  const parts: string[] = [];

  if (c.authors.length > 0) {
    parts.push(c.authors.join(', ') + '.');
  }

  // Title in italics (HTML-safe; rendered with dangerouslySetInnerHTML or by
  // the consumer splitting on <em>). We keep the markup explicit so the
  // formatter has a single output that both copy-paste and rendered display
  // can use.
  parts.push(`<em>${escapeHtml(c.title)}</em>.`);

  if (c.editors.length > 0) {
    parts.push(`Edited by ${c.editors.join(', ')}.`);
  }
  if (c.translators.length > 0) {
    parts.push(`Translated by ${c.translators.join(', ')}.`);
  }
  if (c.arrangers.length > 0) {
    parts.push(`Arranged by ${c.arrangers.join(', ')}.`);
  }
  if (c.edition) {
    parts.push(`${c.edition}.`);
  }

  // Place: Publisher, Date.
  const pub = joinClean(
    [c.place, c.publisher ? `${c.place ? ': ' : ''}${c.publisher}` : null, c.date ? `${(c.place || c.publisher) ? ', ' : ''}${c.date}` : null],
    ''
  );
  if (pub) parts.push(pub + '.');

  if (opts.includePageRef) {
    if (opts.volume && opts.page) {
      parts.push(`Vol. ${opts.volume}, p. ${opts.page}.`);
    } else if (opts.page) {
      parts.push(`P. ${opts.page}.`);
    }
  }

  return parts.join(' ');
}

/**
 * Format as MLA-style citation.
 *
 * Example output:
 *   al-Muḥāsibī, al-Ḥārith. *Al-tawahhum*. Maktabat al-Turāth al-Islāmī. Vol. 1, p. 23.
 */
export function formatMLA(c: CitationData, opts: CitationOptions = {}): string {
  const parts: string[] = [];

  if (c.authors.length > 0) {
    parts.push(c.authors.join(', ') + '.');
  }

  // Title in italics, comma if more follows, period if not.
  const hasMore =
    c.editors.length > 0 ||
    c.translators.length > 0 ||
    c.arrangers.length > 0 ||
    !!c.edition ||
    !!c.publisher ||
    !!c.date;
  parts.push(`<em>${escapeHtml(c.title)}</em>${hasMore ? ',' : '.'}`);

  const middle: string[] = [];
  if (c.editors.length > 0) middle.push(`edited by ${c.editors.join(', ')}`);
  if (c.translators.length > 0) middle.push(`translated by ${c.translators.join(', ')}`);
  if (c.arrangers.length > 0) middle.push(`arranged by ${c.arrangers.join(', ')}`);
  if (c.edition) middle.push(c.edition);
  if (c.publisher) middle.push(c.publisher);
  if (c.date) middle.push(c.date);
  if (middle.length > 0) parts.push(middle.join(', ') + '.');

  if (opts.includePageRef) {
    if (opts.volume && opts.page) {
      parts.push(`Vol. ${opts.volume}, p. ${opts.page}.`);
    } else if (opts.page) {
      parts.push(`P. ${opts.page}.`);
    }
  }

  return parts.join(' ');
}

export function formatCitation(
  c: CitationData,
  style: CitationStyle,
  opts: CitationOptions = {}
): string {
  return style === 'mla' ? formatMLA(c, opts) : formatChicago(c, opts);
}

/** Strip the <em> tags for plain-text copying. */
export function stripCitationMarkup(html: string): string {
  return html.replace(/<\/?em>/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
