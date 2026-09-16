import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { labApi } from '../../api/lab';

/**
 * Choose a few books by name.
 *
 * The corpus is too big for a dropdown and its ids mean nothing to a reader,
 * so this is a typeahead over titles with the chosen books kept as chips.
 * Matching is on the normalised title, because a reader types الحلية for a
 * book printed حلية الأولياء.
 */
export function BookPicker({
  value,
  onChange,
  placeholder = 'Search a title…',
  max = 8,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
  max?: number;
}) {
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    labApi.listBooks().then(setBooks).catch(() => {});
  }, []);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const byId = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const hits = useMemo(() => {
    const needle = fold(q);
    if (!needle) return [];
    return books.filter((b) => !value.includes(b.id) && fold(b.title).includes(needle)).slice(0, 12);
  }, [books, q, value]);

  const add = (id: number) => {
    if (value.length >= max) return;
    onChange([...value, id]);
    setQ('');
    setOpen(false);
  };

  return (
    <div ref={box} className="relative flex-1 min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        {value.map((id) => (
          <span key={id} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-app-surface-variant border border-app-border-light text-xs">
            <span className="font-arabic" dir="rtl">{byId.get(id)?.title ?? `book ${id}`}</span>
            <button onClick={() => onChange(value.filter((x) => x !== id))} aria-label={`Remove book ${id}`} className="text-app-text-secondary">
              ×
            </button>
          </span>
        ))}
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          placeholder={value.length ? '' : placeholder}
          aria-label="Target text"
          dir="auto"
          className="input-bilingual flex-1 min-w-[8rem] px-2 py-1 border border-app-border-medium rounded font-arabic"
        />
      </div>
      {open && hits.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-app-surface border border-app-border-medium rounded shadow" role="listbox">
          {hits.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => add(b.id)}
                className="w-full text-right px-2 py-1 hover:bg-app-surface-variant font-arabic"
                dir="rtl"
              >
                {b.title}
                {b.death_ah != null && <span className="text-xs text-app-text-secondary font-ui" dir="ltr"> · d. {b.death_ah} AH</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Title matching ignores diacritics, hamza seats and the definite article. */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\bال/g, '')
    .toLowerCase()
    .trim();
}
