import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { normalizeArabicForSearch } from '@kashshaf/shared';
import { disambiguationApi, type NameCandidate, type NameForm, type NameOccurrence, type Op } from '../../api/isnad';
import type { Pages } from '../../api/pages';
import { Notice } from '../ui/Running';

/**
 * The name disambiguator (Phase 10 A).
 *
 * One person is written a dozen ways across a book. The workbench links a
 * transmitter row at a time, which is the wrong grain for this question:
 * here the unit is the *form*, every row that carries it moves together, and
 * the answer is recorded once.
 *
 * Left, every form in the text with its count. Right, the forms that could
 * be the same person: those whose every shared name part agrees, ordered by
 * how often the two keep the same company in a chain. Each row says which
 * parts corroborate it and who stood on either side, so the judgment can be
 * made here rather than by going and reading five chains.
 *
 * Under them, apart and labelled, the pairs that agree only by way of a
 * commonly confused name — الحسن for الحسين, سعد for سعيد. Those are a
 * question, not a suggestion, and are never mixed into the list above.
 */

export function Disambiguator({
  book,
  labels,
  onOp,
  onOpen,
  onClose,
  version,
}: {
  book: BookMetadata;
  labels: Pages;
  /** Applies through the workbench's undo stack. */
  onOp: (op: Op) => Promise<void>;
  /** Open one occurrence in the workbench's reader. */
  onOpen: (isnadId: number, transmitterId: number) => void;
  onClose: () => void;
  /** Bumped when something changed under us, to reload. */
  version: number;
}) {
  const [forms, setForms] = useState<NameForm[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<NameCandidate[]>([]);
  const [group, setGroup] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setForms(await disambiguationApi.forms(book.id));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [book.id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // The candidates of whichever form is selected.
  useEffect(() => {
    if (!selected) {
      setCandidates([]);
      return;
    }
    let live = true;
    setBusy(true);
    disambiguationApi
      .candidates(book.id, selected)
      .then((c) => live && setCandidates(c))
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [book.id, selected, version]);

  const pick = (form: NameForm) => {
    setSelected(form.form_norm);
    setGroup(new Set([form.form_norm]));
    setMessage(null);
    setExpanded(new Set());
  };

  const toggle = (form_norm: string) =>
    setGroup((prev) => {
      const next = new Set(prev);
      if (!next.delete(form_norm)) next.add(form_norm);
      // The form being examined stays in: it is one of the names in question.
      if (selected) next.add(selected);
      return next;
    });

  const chosen = useMemo(() => [...group], [group]);
  const likely = useMemo(() => candidates.filter((c) => !c.confusable), [candidates]);
  const confused = useMemo(() => candidates.filter((c) => c.confusable), [candidates]);
  const named = useMemo(() => new Map(forms.map((f) => [f.form_norm, f])), [forms]);

  const toggleOpen = (form: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(form)) next.add(form);
      return next;
    });

  const samePerson = async () => {
    if (chosen.length < 2) return;
    setBusy(true);
    try {
      await onOp({ op: 'same_name', book_id: book.id, forms: chosen, canonical_name: null });
      setMessage(`${chosen.length} forms are now one person.`);
      setGroup(new Set(selected ? [selected] : []));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const notSame = async () => {
    if (chosen.length < 2) return;
    setBusy(true);
    try {
      const n = await disambiguationApi.notSame(book.id, chosen);
      setMessage(`${n} pair${n === 1 ? '' : 's'} will not be suggested again.`);
      setGroup(new Set(selected ? [selected] : []));
      if (selected) setCandidates(await disambiguationApi.candidates(book.id, selected));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const needle = normalizeArabicForSearch(search.trim());
  const shownForms = needle ? forms.filter((f) => normalizeArabicForSearch(f.raw).includes(needle)) : forms;

  return (
    <div className="flex-1 min-w-0 flex min-h-0" data-testid="disambiguator">
      {/* ------------------------------------------------ the name list --- */}
      <section className="w-96 shrink-0 flex flex-col min-h-0 border-r border-app-border-light bg-app-surface">
        <div className="px-3 py-2 border-b border-app-border-light flex items-center gap-2">
          <h2 className="text-sm font-semibold flex-1">Names</h2>
          <span className="text-xs text-app-text-secondary" data-testid="form-count">
            {forms.length.toLocaleString()}
          </span>
          <button onClick={onClose} className="px-2 py-0.5 text-xs border border-app-border-medium rounded" data-testid="close-disambiguator">
            Back to the workbench
          </button>
        </div>
        <div className="px-3 py-2 border-b border-app-border-light">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search names…"
            aria-label="Search names"
            dir="rtl"
            className="w-full px-2 py-1 font-arabic text-base border border-app-border-medium rounded"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto" data-testid="name-list">
          {shownForms.map((f) => (
            <button
              key={f.form_norm}
              onClick={() => pick(f)}
              aria-current={selected === f.form_norm ? 'true' : undefined}
              className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-right border-b border-app-border-light hover:bg-app-surface-variant ${
                selected === f.form_norm ? 'bg-app-accent-light' : ''
              }`}
              data-testid={`name-${f.form_norm}`}
            >
              <span className="flex-1 min-w-0">
                <span className="block font-arabic text-base leading-snug truncate" dir="rtl">
                  {f.raw}
                </span>
                {f.person_name && (
                  <span className="block text-xs text-app-accent font-arabic truncate" dir="rtl" title="Already linked">
                    → {f.person_name}
                  </span>
                )}
              </span>
              <span className="text-xs text-app-text-secondary tabular-nums shrink-0">{f.count}</span>
            </button>
          ))}
          {shownForms.length === 0 && <p className="px-3 py-4 text-xs text-app-text-secondary">No names. Extract some isnāds first.</p>}
        </div>
      </section>

      {/* ------------------------------------------------- the candidates --- */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        {!selected ? (
          <p className="p-6 text-sm text-app-text-secondary">Choose a name to see who else it might be.</p>
        ) : (
          <>
            <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-2 flex-wrap text-xs">
              <span className="font-arabic text-base" dir="rtl">
                {named.get(selected)?.raw ?? selected}
              </span>
              <span className="text-app-text-secondary">
                {busy
                  ? 'ranking…'
                  : `${likely.length} possible ${likely.length === 1 ? 'match' : 'matches'}${
                      confused.length > 0 ? `, ${confused.length} commonly confused` : ''
                    }`}
              </span>
              <span className="ltr:ml-auto flex items-center gap-1">
                <button
                  onClick={() => void samePerson()}
                  disabled={chosen.length < 2 || busy}
                  className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
                  data-testid="same-person"
                >
                  Same person
                </button>
                <button
                  onClick={() => void notSame()}
                  disabled={chosen.length < 2 || busy}
                  className="px-2 py-1 border border-app-border-medium rounded disabled:opacity-40"
                  data-testid="not-the-same"
                >
                  Not the same
                </button>
              </span>
            </div>

            {/* The selection, as a group, so what the buttons act on is plain. */}
            <div className="px-3 py-1.5 border-b border-app-border-light bg-app-surface-variant flex items-center gap-2 flex-wrap text-xs" data-testid="selection-group">
              <span className="text-app-text-secondary">Selected:</span>
              {chosen.map((f) => (
                <span key={f} className="px-2 py-0.5 rounded-full bg-app-surface border border-app-border-medium font-arabic text-sm" dir="rtl">
                  {named.get(f)?.raw ?? f}
                </span>
              ))}
              {chosen.length < 2 && <span className="text-app-text-secondary">pick one or more below</span>}
            </div>

            <Notice error={error} message={message} />

            <div className="flex-1 min-h-0 overflow-y-auto" data-testid="candidate-list">
              {likely.map((c) => (
                <CandidateRow
                  key={c.form_norm}
                  c={c}
                  labels={labels}
                  picked={group.has(c.form_norm)}
                  open={expanded.has(c.form_norm)}
                  onToggleOpen={() => toggleOpen(c.form_norm)}
                  onPick={() => toggle(c.form_norm)}
                  onOpen={onOpen}
                />
              ))}
              {!busy && likely.length === 0 && (
                <p className="p-4 text-sm text-app-text-secondary">
                  No other name in this text agrees with this one part for part.
                </p>
              )}

              {confused.length > 0 && (
                <>
                  <div className="px-3 py-1.5 border-y border-app-border-light bg-app-surface-variant" data-testid="confused-heading">
                    <span className="text-xs font-semibold uppercase tracking-wide text-app-text-secondary">Commonly confused</span>
                    <p className="text-xs text-app-text-secondary mt-0.5">
                      These agree everywhere except a name that is often mistaken for another. They are as likely to be
                      two men as one.
                    </p>
                  </div>
                  {confused.map((c) => (
                    <CandidateRow
                      key={c.form_norm}
                      c={c}
                      labels={labels}
                      picked={group.has(c.form_norm)}
                      open={expanded.has(c.form_norm)}
                      onToggleOpen={() => toggleOpen(c.form_norm)}
                      onPick={() => toggle(c.form_norm)}
                      onOpen={onOpen}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function CandidateRow({
  c,
  labels,
  picked,
  open,
  onToggleOpen,
  onPick,
  onOpen,
}: {
  c: NameCandidate;
  labels: Pages;
  picked: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onPick: () => void;
  onOpen: (isnadId: number, transmitterId: number) => void;
}) {
  // A handful of occurrences is a list; a hundred is a summary.
  const many = c.count > 3;
  const shown = open || !many ? c.occurrences : c.occurrences.slice(0, 1);

  return (
    <div
      className={`border-b border-app-border-light ${picked ? 'bg-app-accent-light' : ''}`}
      data-testid={`candidate-${c.form_norm}`}
      data-picked={picked ? 'true' : undefined}
    >
      <div className="flex items-baseline gap-3 px-3 py-2">
        <button onClick={onPick} className="flex-1 min-w-0 text-right" aria-pressed={picked}>
          <span className="block font-arabic text-lg leading-snug truncate" dir="rtl">
            {c.raw}
          </span>
          {c.person_name && (
            <span className="block text-xs text-app-accent font-arabic truncate" dir="rtl">
              → {c.person_name}
            </span>
          )}
        </button>

        <span className="text-xs text-app-text-secondary tabular-nums shrink-0" title="Occurrences in this text">
          ×{c.count}
        </span>

        {/* What the two names have in common, part by part, and how much
            company they keep. The first is why the pair is here at all; the
            second is why it is this far up the list. */}
        <span className="shrink-0 text-xs tabular-nums" data-testid={`score-${c.form_norm}`}>
          <span className="font-semibold">company {c.score.toFixed(2)}</span>
          <span className="text-app-text-secondary"> · {c.matched.length > 0 ? c.matched.join(', ') : 'nothing'} agree</span>
        </span>
      </div>

      <div className="px-3 pb-2 text-xs text-app-text-secondary">
        {c.confusable && (
          <div className="mb-1 text-app-text-primary" data-testid={`confusable-${c.form_norm}`}>
            Rests on <span className="font-arabic">{c.confusable}</span>, which are often confused.
          </div>
        )}
        <span data-testid={`shared-${c.form_norm}`}>
          {c.shared_from + c.shared_to === 0
            ? 'No transmitter in common'
            : `Shares ${c.shared_from} source${c.shared_from === 1 ? '' : 's'} and ${c.shared_to} recipient${c.shared_to === 1 ? '' : 's'}`}
        </span>
        {many && (
          <button onClick={onToggleOpen} className="ltr:ml-2 rtl:mr-2 underline">
            {open ? 'fewer' : `all ${Math.min(c.count, c.occurrences.length)} shown`}
          </button>
        )}
        <ul className="mt-1 space-y-0.5">
          {shown.map((o, i) => (
            <li key={`${o.transmitter_id}-${i}`} className="flex items-baseline gap-2">
              <button
                onClick={() => onOpen(o.isnad_id, o.transmitter_id)}
                className="text-app-accent underline tabular-nums shrink-0"
                data-testid={`open-${o.transmitter_id}`}
              >
                {labels.label(o.part_index, o.page_id)}
              </button>
              <span className="font-arabic text-sm truncate" dir="rtl">
                {side(o)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Who stood on either side of this occurrence, read right to left. */
function side(o: NameOccurrence): string {
  const from = o.from ?? '—';
  const to = o.to ?? '—';
  return `${from} ← … → ${to}`;
}
