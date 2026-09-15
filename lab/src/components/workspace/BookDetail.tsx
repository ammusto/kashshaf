import { useMemo } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { formatCitation, parseCitation, stripCitationMarkup } from '@kashshaf/shared';

/**
 * A text's metadata, reproducing Kashshaf's `BookDetailView` (spec 1.5 §A1)
 * with one addition: **Add to Workspace**.
 *
 * Rendered in the pane rather than as a full-screen overlay, because in Lab
 * it is half of the workspace view, not a modal over a search.
 *
 * The Metadata panel (9 D) renders the same component with no callbacks,
 * which leaves the action bar off and the record itself untouched: one view
 * of a book's metadata, not two that can drift apart.
 */

export function BookDetail({
  book,
  authorName,
  genreName,
  inWorkspace = false,
  onAdd,
  onOpen,
  onBack,
}: {
  book: BookMetadata;
  authorName?: string;
  genreName?: string;
  inWorkspace?: boolean;
  /** Left out by the Metadata panel, which is read-only (9 D). */
  onAdd?: () => void;
  onOpen?: () => void;
  onBack?: () => void;
}) {
  const tags = useMemo(() => parseJsonArray(book.tags), [book.tags]);
  const meta = useMemo(() => parseMetadataJson(book.metadata_json), [book.metadata_json]);
  const citation = useMemo(() => {
    const data = parseCitation(book.citation_json);
    if (!data) return null;
    try {
      return stripCitationMarkup(formatCitation(data, 'chicago'));
    } catch {
      return null;
    }
  }, [book.citation_json]);

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0" data-testid="book-detail">
      {onBack && (
        <div className="px-4 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2">
          <button onClick={onBack} className="px-2 py-1 text-sm text-app-text-secondary hover:text-app-accent rounded">
            ‹ Back to texts
          </button>
          <div className="flex-1" />
          {inWorkspace ? (
            <>
              <span className="text-xs text-app-text-secondary">In the workspace</span>
              <button onClick={onOpen} className="px-3 py-1 text-sm bg-app-accent text-white rounded-lg">
                View Text
              </button>
            </>
          ) : (
            <button onClick={onAdd} className="px-3 py-1 text-sm bg-app-accent text-white rounded" data-testid="add-to-workspace">
              Add to Workspace
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 space-y-5">
          <h1 className="text-3xl font-bold text-app-text-primary font-arabic" dir="rtl">
            {book.title}
          </h1>
          <div className="text-xl text-app-text-secondary font-arabic" dir="rtl">
            {authorName || 'Unknown author'}
            {book.death_ah != null && book.death_ah !== 0 && <span className="text-app-text-secondary"> (ت {book.death_ah})</span>}
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <span key={t} className="px-2 py-0.5 text-xs rounded bg-app-surface-variant text-app-text-secondary font-arabic" dir="rtl">
                  {t}
                </span>
              ))}
            </div>
          )}

          <section className="bg-app-surface rounded-xl p-5 border border-app-border-light">
            <h2 className="text-base font-semibold mb-3">Kashshāf data</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <Field label="Kashshāf ID" value={String(book.id)} />
              <Field label="Genre" value={genreName || '—'} />
              <Field label="Tokens" value={book.token_count?.toLocaleString() ?? '—'} />
              <Field label="Author ID" value={book.author_id != null ? String(book.author_id) : '—'} />
              <Field label="Death" value={book.death_ah != null ? `${book.death_ah} AH` : '—'} />
              <Field label="Pages" value={book.page_count?.toLocaleString() ?? '—'} />
              <Field label="Parts" value={book.parts != null ? String(book.parts) : '—'} />
              <Field label="Source corpus" value={book.corpus || '—'} />
              <Field label="Source ID" value={book.original_id || '—'} />
            </div>
          </section>

          {meta && <MetadataJsonView meta={meta} />}

          {citation && (
            <section className="bg-app-surface rounded-xl p-5 border border-app-border-light">
              <h2 className="text-base font-semibold mb-3">Citation</h2>
              <p className="text-sm text-app-text-secondary font-arabic leading-7" dir="rtl">
                {citation}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-app-text-secondary">{label}</div>
      <div className="text-app-text-primary break-words">{value}</div>
    </div>
  );
}

function parseJsonArray(s?: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return s.split('|').map((x) => x.trim()).filter(Boolean);
  }
}

interface MetaValue {
  value_raw: string;
}
interface MetaPerson {
  name_raw: string;
  role_raw?: string;
}
interface ParsedMetadata {
  titles?: Record<string, MetaValue[] | undefined>;
  responsible_persons?: Record<string, MetaPerson[] | undefined>;
  publication?: Record<string, MetaValue[] | undefined>;
}

function parseMetadataJson(s?: string | null): ParsedMetadata | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as ParsedMetadata;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** The structured record the pipeline kept from the source catalogue. */
function MetadataJsonView({ meta }: { meta: ParsedMetadata }) {
  const groups: Array<[string, string[]]> = [];
  const push = (label: string, values: string[]) => {
    const kept = values.filter(Boolean);
    if (kept.length) groups.push([label, kept]);
  };
  for (const [key, vals] of Object.entries(meta.titles ?? {})) {
    push(`Title (${key})`, (vals ?? []).map((v) => v.value_raw));
  }
  for (const [key, people] of Object.entries(meta.responsible_persons ?? {})) {
    push(pretty(key), (people ?? []).map((p) => (p.role_raw ? `${p.name_raw} — ${p.role_raw}` : p.name_raw)));
  }
  for (const [key, vals] of Object.entries(meta.publication ?? {})) {
    push(pretty(key), (vals ?? []).map((v) => v.value_raw));
  }
  if (!groups.length) return null;
  return (
    <section className="bg-app-surface rounded-xl p-5 border border-app-border-light">
      <h2 className="text-base font-semibold mb-3">From the source catalogue</h2>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        {groups.map(([label, values]) => (
          <div key={label} className="contents">
            <dt className="text-xs text-app-text-secondary pt-0.5">{label}</dt>
            <dd className="font-arabic" dir="rtl">
              {values.join(' · ')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function pretty(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
