/**
 * The isnād workbench's slice of the bridge (spec §4.2, §6.2, §6.3, §7.4).
 *
 * Every mutation is an `Op` applied through `isnadApi.apply`, which returns
 * the op that undoes it — the session undo/redo stack (`useOps`) is a stack
 * of those inverses. Suggestions are read, never written, until the user
 * links.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type TokenClass = 'formula' | 'verb' | 'connect' | 'name' | 'other' | 'boundary';
export type IsnadStatus = 'candidate' | 'confirmed' | 'rejected' | 'orphaned';
export type Group = 'core' | 'history' | 'written' | 'citation';

export interface Params {
  min_links: number;
  lookahead: number;
  min_confidence: number;
  groups: Group[];
}

export const DEFAULT_PARAMS: Params = { min_links: 2, lookahead: 3, min_confidence: 0.2, groups: ['core', 'history', 'written', 'citation'] };

export interface Confidence {
  links: number;
  noun_prop: number;
  terminal: number;
  clean: number;
  total: number;
}

export interface TransmitterRow {
  id: number;
  isnad_id: number;
  position: number;
  /** Stream offsets from the isnād's start page (spec 1.4, §6.2). */
  tok_start: number;
  tok_end: number;
  /** The page the span starts on; null = the isnād's start page. */
  part_index: number | null;
  page_id: number | null;
  /** A place tag after the name (بالكوفة). */
  place: string | null;
  raw: string;
  kunya: string | null;
  ism: string | null;
  nasab: string | null;
  nisba: string | null;
  laqab: string | null;
  verb_before: string | null;
  person_id: number | null;
  form_norm: string;
  suggested_person_id: number | null;
}

export interface IsnadRow {
  id: number;
  book_id: number;
  part_index: number;
  page_id: number;
  /** Stream offsets from the start page's token 0; they may run past its end. */
  tok_start: number;
  tok_end: number;
  /** The page tok_end − 1 falls on; null = the start page. */
  end_part_index: number | null;
  end_page_id: number | null;
  kind: 'isnad' | 'citation';
  matn_tok_start: number | null;
  matn_tok_end: number | null;
  matn_end_part_index: number | null;
  matn_end_page_id: number | null;
  links: number;
  confidence: number;
  /** JSON of `Confidence`. */
  confidence_json: string;
  status: IsnadStatus;
  created_at: string;
  updated_at: string;
  overrides: Record<string, TokenClass>;
  transmitters: TransmitterRow[];
}

export interface TransmitterListRow extends TransmitterRow {
  part_index: number;
  page_id: number;
  isnad_status: IsnadStatus;
  form_count: number;
  person_name: string | null;
  suggested_person_name: string | null;
}

export interface NameFormRow {
  id: number;
  person_id: number;
  form: string;
  form_norm: string;
  source: 'user' | 'auto';
}

export interface PersonRow {
  id: number;
  canonical_name: string;
  death_ah: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  forms: NameFormRow[];
  linked: number;
}

export interface IsnadFilter {
  status?: IsnadStatus | null;
  kind?: 'isnad' | 'citation' | null;
  min_confidence?: number | null;
  min_links?: number | null;
  page_from?: number | null;
  page_to?: number | null;
}

export interface RunProgress {
  done: number;
  total: number;
  found: number;
  estimate_ms: number | null;
}

export interface RunSummary {
  book_id: number;
  pages: number;
  candidates: number;
  kept_confirmed: number;
  elapsed_ms: number;
  lexicon_hash: string;
}

export interface LexiconEntry {
  id: number | null;
  kind: 'transmission' | 'formula' | 'banal' | 'stopword';
  grp: string | null;
  tokens: string[];
  enabled: boolean;
  source: 'shipped' | 'user';
}

/** Mirrors `commands::isnad::Op` (serde: `{ op: "...", ...fields }`). */
export type Op =
  | { op: 'set_status'; isnad_id: number; status: IsnadStatus }
  | { op: 'set_matn'; isnad_id: number; start: number | null; end: number | null }
  | { op: 'split_transmitter'; transmitter_id: number; at: number }
  | { op: 'merge_transmitters'; left_id: number; right_id: number }
  | { op: 'retag'; isnad_id: number; tok: number; class: TokenClass | null }
  | { op: 'link'; transmitter_id: number; person_id: number }
  | { op: 'unlink'; transmitter_id: number }
  | { op: 'link_new'; transmitter_id: number; canonical_name: string | null }
  | { op: 'delete_person'; person_id: number }
  | { op: 'merge_persons'; into: number; from: number }
  | { op: 'split_person'; person_id: number; transmitter_ids: number[]; canonical_name: string }
  | { op: 'rename_person'; person_id: number; canonical_name: string }
  | { op: 'set_death'; person_id: number; death_ah: number | null }
  | { op: 'set_notes'; person_id: number; notes: string | null }
  | { op: 'add_manual'; book_id: number; part_index: number; page_id: number; tok_start: number; tok_end: number }
  | { op: 'delete_isnad'; isnad_id: number }
  | { op: 'batch'; ops: Op[] }
  | { op: 'split_form_off'; person_id: number; form_norm: string }
  | { op: 'restore_person'; person: PersonRow; transmitter_ids: number[] }
  | { op: 'restore_isnad'; [k: string]: unknown }
  | { op: 'restore_transmitter'; row: TransmitterRow };

export interface Applied {
  log_id: number;
  inverse: Op;
}

export const isnadApi = {
  run: (bookId: number, params?: Params) => invoke<RunSummary>('isnad_run', { bookId, params: params ?? null }),
  onRunProgress: (fn: (p: RunProgress) => void) => listen<RunProgress>('isnad-progress', (e) => fn(e.payload)),
  list: (bookId: number, filter?: IsnadFilter) => invoke<IsnadRow[]>('isnad_list', { bookId, filter: filter ?? null }),
  get: (id: number) => invoke<IsnadRow>('isnad_get', { id }),
  classes: (id: number) => invoke<[number, TokenClass][]>('isnad_classes', { id }),
  apply: (op: Op) => invoke<Applied>('isnad_apply', { op }),
  transmitters: (bookId: number, confirmedOnly: boolean) =>
    invoke<TransmitterListRow[]>('transmitters_list', { bookId, confirmedOnly }),
  persons: () => invoke<PersonRow[]>('persons_list'),
  suggestionsForPage: (bookId: number, partIndex: number, pageId: number) =>
    invoke<Op[]>('suggestions_for_page', { bookId, partIndex, pageId }),
  retagCounts: (bookId: number) => invoke<[string, TokenClass, number][]>('retag_counts', { bookId }),
  lexiconList: (kind?: string) => invoke<LexiconEntry[]>('lexicon_list', { kind: kind ?? null }),
  lexiconAdd: (kind: string, grp: string | null, tokens: string[]) => invoke<number>('lexicon_add', { kind, grp, tokens }),
  lexiconSetEnabled: (id: number, enabled: boolean) => invoke<void>('lexicon_set_enabled', { id, enabled }),
  lexiconDelete: (id: number) => invoke<boolean>('lexicon_delete', { id }),
  exportIsnads: (bookId: number, format: 'csv' | 'json', shape: 'flat' | 'nested', status?: IsnadStatus | null) =>
    invoke<string>('isnad_export', { bookId, format, shape, status: status ?? null }),
  exportAuthority: (format: 'csv' | 'json') => invoke<string>('authority_export', { format }),
};

/**
 * The session undo/redo stack (spec §7.4). Every applied op pushes its
 * inverse; undo applies the inverse and pushes *its* inverse onto redo.
 */
export interface OpStack {
  undo: Op[];
  redo: Op[];
}

export function emptyStack(): OpStack {
  return { undo: [], redo: [] };
}

export async function applyTracked(stack: OpStack, op: Op): Promise<Applied> {
  const r = await isnadApi.apply(op);
  stack.undo.push(r.inverse);
  stack.redo.length = 0;
  return r;
}

export async function undoTracked(stack: OpStack): Promise<boolean> {
  const inv = stack.undo.pop();
  if (!inv) return false;
  const r = await isnadApi.apply(inv);
  stack.redo.push(r.inverse);
  return true;
}

export async function redoTracked(stack: OpStack): Promise<boolean> {
  const op = stack.redo.pop();
  if (!op) return false;
  const r = await isnadApi.apply(op);
  stack.undo.push(r.inverse);
  return true;
}

/** Tokens of one isnād's page, coloured (spec §7.4): the four layers. */
export type Layer = 'transmitter' | 'verb' | 'matn' | 'chain';

/**
 * The layer of each token, keyed by *page-local* index for the page that
 * starts at stream offset `offset` (0 = the start page). A span that crosses
 * a page break is drawn on each of its pages with the same call and a
 * different offset (spec 1.4, §7.4).
 */
export function layersFor(row: IsnadRow, classes: [number, TokenClass][], offset = 0): Map<number, Layer> {
  const m = new Map<number, Layer>();
  for (let t = row.tok_start; t < row.tok_end; t++) m.set(t - offset, 'chain');
  for (const [t, c] of classes) {
    if (t >= row.tok_start && t < row.tok_end && c === 'verb') m.set(t - offset, 'verb');
  }
  for (const tr of row.transmitters) {
    for (let t = tr.tok_start; t < tr.tok_end; t++) m.set(t - offset, 'transmitter');
  }
  if (row.matn_tok_start != null && row.matn_tok_end != null) {
    for (let t = row.matn_tok_start; t < row.matn_tok_end; t++) m.set(t - offset, 'matn');
  }
  return m;
}

/** Whether a row runs past its start page. */
export function spansPages(row: IsnadRow): boolean {
  const notStart = (p: number | null, g: number | null) => p != null && g != null && (p !== row.part_index || g !== row.page_id);
  return notStart(row.end_part_index, row.end_page_id) || notStart(row.matn_end_part_index, row.matn_end_page_id);
}

/** `vol:page`, or just the page for a single-part book (fix 10b). */
export function pageLabel(partIndex: number, pageId: number, parts: number | null | undefined): string {
  return parts != null && parts <= 1 ? String(pageId) : `${partIndex}:${pageId}`;
}

/**
 * The name-search normalization (Kashshaf's `namePatterns.normalizeArabic`,
 * widened to the engine's folds): tashkil off, hamza carriers and alif
 * maqṣūra/yāʾ unified, ابن → بن and the kunya heads to ابو — the same rules
 * `names::form_norm` applies on the backend, so a search here matches what
 * the table holds.
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ٰٟٱ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[ئى]/g, 'ي')
    .trim()
    .split(/\s+/)
    .map((w) => (w === 'ابا' || w === 'ابي' ? 'ابو' : w === 'ابن' ? 'بن' : w))
    .join(' ');
}
