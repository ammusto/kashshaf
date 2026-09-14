/**
 * The Tauri bridge.
 *
 * Every backend call the frontend makes goes through this module, so the
 * panels can be tested by mocking one file (spec §9, "Frontend").
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BookMetadata, Token } from '@kashshaf/shared';

export type LabMode = 'local' | 'api' | 'unavailable';

/** What the mode badge renders (spec §7.1). */
export interface LabStatus {
  mode: LabMode;
  corpus_version: string | null;
  corpus_dir: string | null;
  api_base: string | null;
  /** Whether the server implements the bulk token fetch (spec §5.1). */
  bulk_tokens: boolean;
  lab_dir: string | null;
  lab_version: string;
  /** Why local mode was not used, when it was not. */
  local_error: string | null;
  /** Why api mode was not used, when it was not. */
  api_error: string | null;
}

export interface PageRef {
  book_id: number;
  part_index: number;
  page_id: number;
}

export interface Page extends PageRef {
  part_label: string;
  page_number: string;
  /** Display text with <title> tags, as stored. */
  body: string;
  tokens: Token[];
}

export interface BookOpen {
  book: BookMetadata;
  pages: PageRef[];
  first: Page | null;
}

export interface LabDirs {
  lab_dir: string | null;
  analysis_db: string | null;
  analysis_db_bytes: number;
  schema_version: number | null;
}

export interface Divergence {
  book_id: number;
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  backend_tokens: number;
  display_tokens: number;
  body_head: string;
}

export interface AlignmentReport {
  book_id: number;
  pages_checked: number;
  divergences: Divergence[];
  elapsed_ms: number;
}

export const labApi = {
  status: () => invoke<LabStatus>('lab_status'),
  reloadSource: () => invoke<LabStatus>('reload_source'),
  dirs: () => invoke<LabDirs>('lab_dirs'),
  openLabDirectory: () => invoke<void>('open_lab_directory'),

  listBooks: () => invoke<BookMetadata[]>('list_books'),
  getBook: (id: number) => invoke<BookMetadata | null>('get_book', { id }),
  openBook: (id: number) => invoke<BookOpen>('open_book', { id }),
  listPageRefs: (id: number) => invoke<PageRef[]>('list_page_refs', { id }),
  getPage: (id: number, partIndex: number, pageId: number) =>
    invoke<Page | null>('get_page', { id, partIndex, pageId }),

  verifyAlignment: (bookId: number) => invoke<AlignmentReport>('verify_alignment', { bookId }),

  /** `(book_id, done, total)` while a whole-book check runs. */
  onVerifyProgress: (fn: (p: [number, number, number]) => void) =>
    listen<[number, number, number]>('verify-progress', (e) => fn(e.payload)),
};
