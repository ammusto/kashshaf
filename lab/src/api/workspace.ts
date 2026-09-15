/**
 * The workspace, the table of contents and annotations (spec 1.5 §A, §B2, §C4).
 */

import { invoke } from '@tauri-apps/api/core';
import type { BookMetadata } from '@kashshaf/shared';

// --------------------------------------------------------------- workspace ---

export interface WorkspaceEntry {
  book_id: number;
  title: string;
  author: string | null;
  death_ah: number | null;
  /** RFC 3339; the list's Accessed column. */
  accessed: string;
  added: string;
  confirmed_isnads: number;
  notes: number;
}

export interface WorkspaceState {
  last_page: [number, number] | null;
  panels: Record<string, unknown>;
}

export interface ImportReport {
  book_id: number;
  isnads: number;
  transmitters: number;
  reuse: number;
  quran: number;
  notes: number;
  skipped: number;
  reanchored: number;
  orphaned: number;
}

export interface ExportReport {
  book_id: number;
  confirmed_isnads: number;
  transmitters: number;
  rejected_isnads: number;
  reuse_verdicts: number;
  quran_verdicts: number;
  notes: number;
  dir: string;
}

export interface Opened {
  state: WorkspaceState;
  imported: ImportReport | null;
}

export const workspaceApi = {
  list: () => invoke<WorkspaceEntry[]>('workspace_list'),
  add: (bookId: number, author: string | null) => invoke<WorkspaceEntry>('workspace_add', { bookId, author }),
  remove: (bookId: number) => invoke<void>('workspace_remove', { bookId }),
  open: (bookId: number) => invoke<Opened>('workspace_open', { bookId }),
  export: (bookId: number) => invoke<ExportReport | null>('workspace_export', { bookId }),
  saveState: (bookId: number, state: WorkspaceState) => invoke<void>('workspace_save_state', { bookId, state }),
  openFolder: () => invoke<string>('workspace_open_folder'),
};

/** What the list shows in its Accessed column. */
export function whenAccessed(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return then.toLocaleDateString();
}

// --------------------------------------------------------------------- toc ---

export interface TocNode {
  id: number;
  parent: number;
  title: string;
  part_index: number;
  page_id: number;
  page_number: string;
  depth: number;
  children: TocNode[];
}

export interface TocRow {
  id: number;
  parent: number;
  title: string;
  part_index: number;
  page_id: number;
  page_number: string;
}

export interface SectionRange {
  id: number;
  title: string;
  start: [number, number];
  end: [number, number] | null;
}

export const tocApi = {
  tree: (bookId: number) => invoke<TocNode[]>('get_toc', { bookId }),
  rows: (bookId: number) => invoke<TocRow[]>('get_toc_rows', { bookId }),
  sectionRange: (bookId: number, id: number) => invoke<SectionRange | null>('toc_section_range', { bookId, id }),
};

/** The entry a page sits under: the last one at or before it (spec §B2). */
export function entryForPage(rows: TocRow[], partIndex: number, pageId: number): TocRow | null {
  let best: TocRow | null = null;
  for (const r of rows) {
    if (r.part_index < partIndex || (r.part_index === partIndex && r.page_id <= pageId)) best = r;
    else break;
  }
  return best;
}

/** Every entry of a tree, flat and in order — for a select of sections. */
export function flattenToc(nodes: TocNode[]): TocNode[] {
  const out: TocNode[] = [];
  const walk = (ns: TocNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// ------------------------------------------------------------------- notes ---

export interface Note {
  id: number;
  book_id: number;
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
  text: string;
  snapshot: string;
  created_at: string;
  updated_at: string;
  corpus_version: string;
}

export interface NoteArgs {
  book_id: number;
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
  text: string;
}

export const notesApi = {
  list: (bookId: number) => invoke<Note[]>('notes_list', { bookId }),
  save: (args: NoteArgs) => invoke<Note>('note_save', { args }),
  update: (id: number, text: string) => invoke<Note>('note_update', { id, text }),
  delete: (id: number) => invoke<void>('note_delete', { id }),
};

/** A book's metadata as `metadata.json` stores it — the same shape the corpus returns. */
export type WorkspaceMetadata = BookMetadata;
