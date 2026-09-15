import { useEffect, useMemo, useState } from 'react';
import { labApi, type PageSpan } from '../../api/lab';
import { Pages } from '../../api/pages';
import { flattenToc, tocApi, type TocNode } from '../../api/workspace';

/**
 * How much of a text a run should read (spec 1.5 §G): the whole thing, one
 * section of it, or a range of pages given as the book prints them.
 *
 * Pages are named the way §C1 names them everywhere else, so a reader who
 * types what they see on the page gets the page they meant, whatever the
 * corpus's own page ids are.
 */

export type ScopeKind = 'book' | 'section' | 'range';

export interface Scope {
  span: PageSpan | null;
  /** What the run is, in words, for the heavy-run warning and the report. */
  label: string;
}

export const WHOLE_BOOK: Scope = { span: null, label: 'the whole text' };

export function ScopePicker({
  bookId,
  onChange,
  disabled,
}: {
  bookId: number | null;
  onChange: (scope: Scope) => void;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState<ScopeKind>('book');
  const [pages, setPages] = useState<Pages>(() => Pages.empty());
  const [sections, setSections] = useState<TocNode[]>([]);
  const [sectionId, setSectionId] = useState<number | null>(null);
  const [fromPage, setFromPage] = useState('');
  const [toPage, setToPage] = useState('');
  const [fromPart, setFromPart] = useState('1');
  const [toPart, setToPart] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bookId == null) return;
    let live = true;
    labApi
      .listPages(bookId)
      .then((e) => live && setPages(new Pages(e)))
      .catch(() => live && setPages(Pages.empty()));
    tocApi
      .tree(bookId)
      .then((t) => live && setSections(flattenToc(t)))
      .catch(() => live && setSections([]));
    setKind('book');
    setSectionId(null);
    return () => {
      live = false;
    };
  }, [bookId]);

  const resolve = useMemo(
    () =>
      async (k: ScopeKind, sid: number | null): Promise<Scope | null> => {
        if (k === 'book' || bookId == null) return WHOLE_BOOK;
        if (k === 'section') {
          if (sid == null) return null;
          const range = await tocApi.sectionRange(bookId, sid).catch(() => null);
          if (!range) {
            setError('That heading has no range in the table of contents.');
            return null;
          }
          return { span: { start: range.start, end: range.end }, label: range.title };
        }
        const a = pages.find(fromPage, fromPart);
        const b = pages.find(toPage, toPart);
        if (!a || !b) {
          setError('Give a first and a last page as the text prints them.');
          return null;
        }
        const [lo, hi] = [a, b].sort((x, y) => x.part_index - y.part_index || x.page_id - y.page_id);
        const after = pages.at(pages.indexOf(hi.part_index, hi.page_id) + 1);
        return {
          span: { start: [lo.part_index, lo.page_id], end: after ? [after.part_index, after.page_id] : null },
          label: `pages ${pages.labelOf(lo)} to ${pages.labelOf(hi)}`,
        };
      },
    [bookId, pages, fromPage, toPage, fromPart, toPart]
  );

  // Tell the caller whenever the scope settles into something usable.
  useEffect(() => {
    setError(null);
    let live = true;
    void resolve(kind, sectionId).then((s) => {
      if (live && s) onChange(s);
    });
    return () => {
      live = false;
    };
    // `onChange` is the caller's handler; the scope's parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, sectionId, resolve]);

  return (
    <span className="flex items-center gap-1.5 text-xs" data-testid="scope-picker">
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as ScopeKind)}
        disabled={disabled}
        aria-label="How much to read"
        className="border border-app-border-medium rounded px-1 py-0.5"
      >
        <option value="book">whole text</option>
        <option value="section" disabled={sections.length === 0}>
          one section
        </option>
        <option value="range">page range</option>
      </select>

      {kind === 'section' && (
        <select
          value={sectionId ?? ''}
          onChange={(e) => setSectionId(e.target.value ? Number(e.target.value) : null)}
          disabled={disabled}
          aria-label="Section"
          className="border border-app-border-medium rounded px-1 py-0.5 font-arabic max-w-[16rem]"
          dir="rtl"
        >
          <option value="">choose a section…</option>
          {sections.map((s) => (
            <option key={`${s.id}-${s.part_index}-${s.page_id}`} value={s.id}>
              {' '.repeat(s.depth * 2)}
              {s.title}
            </option>
          ))}
        </select>
      )}

      {kind === 'range' && (
        <span className="flex items-center gap-1">
          {pages.multiPart && (
            <input value={fromPart} onChange={(e) => setFromPart(e.target.value)} aria-label="From part" className="w-8 px-1 py-0.5 text-center border border-app-border-medium rounded tabular-nums" />
          )}
          {pages.multiPart && <span className="text-app-text-secondary">:</span>}
          <input value={fromPage} onChange={(e) => setFromPage(e.target.value)} aria-label="From page" placeholder="from" className="w-14 px-1 py-0.5 text-center border border-app-border-medium rounded tabular-nums" />
          <span className="text-app-text-secondary">to</span>
          {pages.multiPart && (
            <input value={toPart} onChange={(e) => setToPart(e.target.value)} aria-label="To part" className="w-8 px-1 py-0.5 text-center border border-app-border-medium rounded tabular-nums" />
          )}
          {pages.multiPart && <span className="text-app-text-secondary">:</span>}
          <input value={toPage} onChange={(e) => setToPage(e.target.value)} aria-label="To page" placeholder="to" className="w-14 px-1 py-0.5 text-center border border-app-border-medium rounded tabular-nums" />
        </span>
      )}

      {error && <span className="text-app-error">{error}</span>}
    </span>
  );
}
