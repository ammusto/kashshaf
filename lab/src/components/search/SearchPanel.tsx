import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { stripHtml } from '@kashshaf/shared';
import { searchApi, toTerms, type Hit, type SearchInput, type SearchMode, type SearchResults } from '../../api/search';
import { Pages, type At } from '../../api/pages';
import { labApi } from '../../api/lab';
import { LoadingOverlay, Notice } from '../ui/Running';

/**
 * Search within the open text (spec 1.5 §D).
 *
 * Kashshaf's boolean form, narrowed to one book: a mode per term, the clitic
 * toggle, up to three ANDed terms and three ORed ones. The result rows are
 * Kashshaf's too — the page label first, then the line the hit sits in — and
 * clicking one opens the Read panel at that page with the words marked.
 */

const EMPTY = (id: number): SearchInput => ({ id, query: '', mode: 'surface', cliticToggle: false });
const PAGE_SIZE = 50;

export function SearchPanel({
  book,
  onShowHit,
}: {
  book: BookMetadata | null;
  /** Open the Read panel at this page, with these token indices marked. */
  onShowHit: (at: At, matched: number[]) => void;
}) {
  const [andInputs, setAnd] = useState<SearchInput[]>([EMPTY(1)]);
  const [orInputs, setOr] = useState<SearchInput[]>([EMPTY(2)]);
  const [tab, setTab] = useState<'and' | 'or'>('and');
  const nextId = useRef(3);

  const [results, setResults] = useState<SearchResults | null>(null);
  const [offset, setOffset] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<Pages>(() => Pages.empty(book?.parts));

  const bookId = book?.id ?? null;

  useEffect(() => {
    if (bookId == null) return;
    let live = true;
    labApi
      .listPages(bookId)
      .then((entries) => live && setPages(new Pages(entries, book?.parts)))
      .catch(() => live && setPages(Pages.empty(book?.parts)));
    return () => {
      live = false;
    };
  }, [bookId, book?.parts]);

  // A new text means the old results are about a different book.
  useEffect(() => {
    setResults(null);
    setOffset(0);
    setError(null);
  }, [bookId]);

  const inputs = tab === 'and' ? andInputs : orInputs;
  const setInputs = tab === 'and' ? setAnd : setOr;

  const hasQuery = [...andInputs, ...orInputs].some((i) => i.query.trim());

  const run = useCallback(
    async (at = 0) => {
      if (bookId == null) return;
      const { and_terms, or_terms } = toTerms(andInputs, orInputs);
      if (and_terms.length === 0 && or_terms.length === 0) return;
      setRunning(true);
      setError(null);
      try {
        const r = await searchApi.book({ book_id: bookId, and_terms, or_terms, limit: PAGE_SIZE, offset: at });
        setResults(r);
        setOffset(at);
      } catch (e) {
        setResults(null);
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [bookId, andInputs, orInputs]
  );

  const clear = () => {
    setAnd([EMPTY(nextId.current++)]);
    setOr([EMPTY(nextId.current++)]);
    setTab('and');
    setResults(null);
    setError(null);
  };

  if (!book) return <Empty />;

  return (
    <div className="flex-1 flex min-h-0" data-testid="search-panel">
      <aside className="w-80 shrink-0 border-r border-app-border-light bg-app-surface flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-app-text-secondary">Search this text</h2>
            <button onClick={clear} className="text-xs text-app-text-tertiary hover:text-app-error">
              Clear form
            </button>
          </div>

          <div className="flex gap-1">
            {(['and', 'or'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 h-8 rounded text-xs font-medium border ${
                  tab === t ? 'bg-app-accent-light text-app-accent border-app-accent' : 'border-app-border-light hover:bg-app-surface-variant'
                }`}
              >
                {t.toUpperCase()}
                {(t === 'and' ? andInputs : orInputs).filter((i) => i.query.trim()).length > 0 &&
                  ` (${(t === 'and' ? andInputs : orInputs).filter((i) => i.query.trim()).length})`}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-app-text-tertiary">
            {tab === 'and' ? 'Every term must be on the page.' : 'Any one of these terms is enough.'}
          </p>

          {inputs.map((inp) => (
            <Row
              key={inp.id}
              input={inp}
              onChange={(u) => setInputs(inputs.map((i) => (i.id === inp.id ? u : i)))}
              onRemove={() => setInputs(inputs.filter((i) => i.id !== inp.id))}
              canRemove={inputs.length > 1}
            />
          ))}

          {inputs.length < 3 && (
            <button
              onClick={() => setInputs([...inputs, EMPTY(nextId.current++)])}
              className="w-full h-8 text-xs border border-dashed border-app-border-medium rounded hover:bg-app-surface-variant"
            >
              + Add a term
            </button>
          )}

          <button
            onClick={() => void run(0)}
            disabled={!hasQuery || running}
            className="w-full h-9 text-sm bg-app-accent text-white rounded disabled:opacity-40"
            data-testid="run-search"
          >
            {running ? 'Searching…' : 'Search'}
          </button>
        </div>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col min-h-0 relative">
        <Notice error={error} />
        {results && (
          <div className="px-4 py-2 border-b border-app-border-light text-xs text-app-text-secondary flex items-center gap-3" data-testid="search-summary">
            <span>
              {results.total.toLocaleString()} page{results.total === 1 ? '' : 's'}
              {results.capped && ' or more'}
            </span>
            <span className="text-app-text-tertiary">{results.elapsed_ms} ms</span>
            {results.total > PAGE_SIZE && (
              <span className="ltr:ml-auto flex items-center gap-2">
                <button onClick={() => void run(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40">
                  ‹
                </button>
                <span className="tabular-nums">
                  {(offset + 1).toLocaleString()}–{Math.min(offset + results.hits.length, results.total).toLocaleString()}
                </span>
                <button
                  onClick={() => void run(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= results.total}
                  className="px-2 py-0.5 border border-app-border-medium rounded disabled:opacity-40"
                >
                  ›
                </button>
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {results?.hits.map((h) => (
            <HitRow key={`${h.part_index}:${h.page_id}`} hit={h} pages={pages} onClick={() => onShowHit({ part_index: h.part_index, page_id: h.page_id }, h.matched)} />
          ))}
          {results && results.hits.length === 0 && <p className="p-6 text-sm text-app-text-tertiary">Nothing in this text matches that.</p>}
          {!results && !error && (
            <p className="p-6 text-sm text-app-text-tertiary">
              Search the open text. A term can be matched on its surface form, its lemma or its root, and the clitic toggle
              also matches the word with و ف ب ل or ك in front of it.
            </p>
          )}
        </div>

        {running && <LoadingOverlay step={{ label: 'Searching the text…' }} />}
      </section>
    </div>
  );
}

function HitRow({ hit, pages, onClick }: { hit: Hit; pages: Pages; onClick: () => void }) {
  const line = useMemo(() => stripHtml(hit.body).replace(/\s+/g, ' ').trim(), [hit.body]);
  return (
    <button onClick={onClick} className="w-full text-right px-4 py-3 border-b border-app-border-light hover:bg-app-surface-variant block" data-testid="search-hit">
      <div className="flex items-baseline gap-3">
        <span className="text-xs text-app-text-tertiary tabular-nums shrink-0">{pages.label(hit.part_index, hit.page_id)}</span>
        <span className="flex-1 min-w-0 font-arabic text-base leading-7 line-clamp-3" dir="rtl">
          {line}
        </span>
      </div>
    </button>
  );
}

function Row({
  input,
  onChange,
  onRemove,
  canRemove,
}: {
  input: SearchInput;
  onChange: (u: SearchInput) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="space-y-2 p-2 bg-app-surface-variant rounded-lg">
      <div className="flex gap-2 items-center">
        <input
          dir="rtl"
          value={input.query}
          onChange={(e) => onChange({ ...input, query: e.target.value })}
          placeholder="ابحث..."
          aria-label="Term"
          className="flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-medium focus:outline-none focus:border-app-accent text-right font-arabic text-lg"
        />
        {canRemove && (
          <button onClick={onRemove} aria-label="Remove this term" className="w-8 h-8 rounded-md bg-red-50 text-red-500 hover:bg-red-100">
            ✕
          </button>
        )}
      </div>
      <div className="flex gap-1.5 h-8">
        {(['surface', 'lemma', 'root'] as SearchMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => onChange({ ...input, mode })}
            className={`flex-1 rounded text-xs font-medium ${
              input.mode === mode ? 'bg-app-accent text-white' : 'bg-app-surface border border-app-border-light hover:bg-app-accent-light'
            }`}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={input.cliticToggle}
          onChange={(e) => onChange({ ...input, cliticToggle: e.target.checked })}
          disabled={input.mode !== 'surface'}
          className="w-3.5 h-3.5 accent-app-accent"
        />
        <span className={`text-xs ${input.mode === 'surface' ? 'text-app-text-primary' : 'text-app-text-tertiary'}`}>Ignore clitics</span>
      </label>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-app-text-tertiary">Open a text from the workspace to search it.</p>
    </div>
  );
}
