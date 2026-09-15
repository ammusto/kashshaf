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
  /** Whether this corpus has a table of contents (spec 1.5 B1). */
  toc: boolean;
  toc_error: string | null;
  min_toc_corpus_version: string;
  lab_dir: string | null;
  lab_version: string;
  /** Why local mode was not used, when it was not. */
  local_error: string | null;
  /** Why api mode was not used, when it was not. */
  api_error: string | null;
}

/** A row of `metadata.db`'s author or genre table (spec 1.5 A1). */
export interface NamedId {
  id: number;
  name: string;
}

export interface PageRef {
  book_id: number;
  part_index: number;
  page_id: number;
}

/**
 * A page of the reader's list: coordinates plus the labels the book prints
 * on it, which every page label is built from (spec 1.5 C1).
 */
export interface PageEntry extends PageRef {
  page_number: string;
  part_label: string;
}

/** A run's scope as page coordinates, `end` exclusive (spec 1.5 G, H3). */
export interface PageSpan {
  start: [number, number];
  end: [number, number] | null;
}

/** What a run is about to read (spec 1.5 F4). */
export interface RunSize {
  book_id: number;
  pages: number;
  book_pages: number;
  /** Estimated from the book's totals, not counted. */
  tokens: number;
  book_tokens: number;
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

// ------------------------------------------------------------ stats (§4.1) ---

export type Layer = 'surface' | 'lemma' | 'root';

/** The common arguments of every statistic. */
export interface Scope {
  book_id: number;
  layer: Layer;
  /** Apply the stop list. */
  stop: boolean;
  /** Restrict to one section (its id). */
  section?: number | null;
}

/** Progress of a batch operation (`stats-progress`). */
export interface Progress {
  stage: 'load' | 'reference' | 'freq' | string;
  done: number;
  total: number;
  estimate_ms: number | null;
}

export interface LoadSummary {
  book_id: number;
  pages: number;
  tokens: number;
  sections: number;
  load_ms: number;
  cached: boolean;
}

export interface PageLabel {
  index: number;
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  tokens: number;
}

export interface FreqRow {
  key: string;
  count: number;
  per_million: number;
  corpus_count: number | null;
  corpus_rank: number | null;
  corpus_per_million: number | null;
}

export interface FreqList {
  total: number;
  distinct: number;
  rows: FreqRow[];
}

export interface FreqResponse {
  list: FreqList;
  /** Why the corpus columns are empty, when they are. */
  corpus_note: string | null;
}

export type SortBy = 'position' | 'left' | 'right';

export interface ConcordanceArgs {
  scope: Scope;
  query: string;
  clitics: boolean;
  context?: number;
  sort?: SortBy;
  offset?: number;
  limit?: number;
}

export interface ConcordanceLine {
  page: number;
  part_index: number;
  page_id: number;
  part_label: string;
  page_number: string;
  tok_start: number;
  tok_end: number;
  global: number;
  left: string[];
  node: string[];
  right: string[];
}

export interface ConcordanceResponse {
  total: number;
  offset: number;
  lines: ConcordanceLine[];
}

export type RefSpec =
  | { kind: 'corpus' }
  | { kind: 'author' }
  | { kind: 'genre' }
  | { kind: 'century' }
  | { kind: 'books'; ids: number[] };

export interface KeynessArgs {
  scope: Scope;
  reference: RefSpec;
  min_freq?: number;
  min_bic?: number;
}

export interface KeyItem {
  key: string;
  book_count: number;
  ref_count: number;
  book_per_million: number;
  ref_per_million: number;
  g2: number;
  bic: number;
  log_ratio: number;
  direction: 'positive' | 'negative';
}

export interface KeynessResponse {
  book_total: number;
  ref_total: number;
  ref_books: number;
  reference: RefSpec;
  items: KeyItem[];
}

export interface Pos {
  page: number;
  idx: number;
}

export interface Dispersion {
  key: string;
  occurrences: number;
  total: number;
  dp: number;
  dp_norm: number;
  per_page: number[];
  positions: Pos[];
}

export interface Section {
  id: number;
  parent: number;
  depth: number;
  title: string;
  page: number;
  tok_start_on_page: number;
  start: number;
  end: number;
  tokens: number;
}

export interface DispersionResponse {
  dispersion: Dispersion;
  pages: PageLabel[];
  by_section: [Section, number][];
}

export interface NgramArgs {
  scope: Scope;
  n: number;
  span_aware: boolean;
  min_count?: number;
}

export interface NgramRow {
  gram: string[];
  count: number;
  per_million: number;
}

export interface CollocationArgs {
  scope: Scope;
  node: string;
  left?: number;
  right?: number;
  span_aware: boolean;
  min_freq?: number;
}

export interface Collocate {
  key: string;
  observed: number;
  expected: number;
  freq: number;
  mi: number;
  log_likelihood: number;
  t_score: number;
}

export interface Collocations {
  node: string;
  node_freq: number;
  window: [number, number];
  rows: Collocate[];
}

export interface SectionsResponse {
  sections: Section[];
  pages: PageLabel[];
  longest: number | null;
  shortest: number | null;
}

/** A Rust `Result<usize, String>` as serde emits it. */
export type RustResult<T> = { Ok: T } | { Err: string };

export interface FreqStatus {
  lemma: RustResult<number>;
  root: RustResult<number>;
}

export function rustOk<T>(r: RustResult<T>): T | null {
  return 'Ok' in r ? r.Ok : null;
}

export function rustErr<T>(r: RustResult<T>): string | null {
  return 'Err' in r ? r.Err : null;
}

export const labApi = {
  status: () => invoke<LabStatus>('lab_status'),
  reloadSource: () => invoke<LabStatus>('reload_source'),
  dirs: () => invoke<LabDirs>('lab_dirs'),
  openLabDirectory: () => invoke<void>('open_lab_directory'),

  listBooks: () => invoke<BookMetadata[]>('list_books'),
  getBook: (id: number) => invoke<BookMetadata | null>('get_book', { id }),
  /** Author and genre names, for the text browser's search and filters. */
  listAuthors: () => invoke<NamedId[]>('list_authors'),
  listGenres: () => invoke<NamedId[]>('list_genres'),
  openBook: (id: number) => invoke<BookOpen>('open_book', { id }),
  listPageRefs: (id: number) => invoke<PageRef[]>('list_page_refs', { id }),
  /** The page list with printed numbers — what page labels need (spec 1.5 C1). */
  listPages: (id: number) => invoke<PageEntry[]>('list_pages', { id }),
  /** Pages and estimated tokens a run would read (spec 1.5 F4). */
  runSize: (id: number, span: PageSpan | null) => invoke<RunSize>('run_size', { id, span }),
  getPage: (id: number, partIndex: number, pageId: number) =>
    invoke<Page | null>('get_page', { id, partIndex, pageId }),

  verifyAlignment: (bookId: number) => invoke<AlignmentReport>('verify_alignment', { bookId }),

  /** `(book_id, done, total)` while a whole-book check runs. */
  onVerifyProgress: (fn: (p: [number, number, number]) => void) =>
    listen<[number, number, number]>('verify-progress', (e) => fn(e.payload)),

  // --- stats ---
  statsLoadBook: (bookId: number) => invoke<LoadSummary>('stats_load_book', { bookId }),
  statsCancel: () => invoke<void>('stats_cancel'),
  /** Pause or resume the running operation (spec 1.5 F3). */
  statsPause: (paused: boolean) => invoke<void>('stats_pause', { paused }),
  onStatsProgress: (fn: (p: Progress) => void) =>
    listen<Progress>('stats-progress', (e) => fn(e.payload)),
  statsPageLabels: (bookId: number) => invoke<PageLabel[]>('stats_page_labels', { bookId }),
  statsFrequencies: (scope: Scope) => invoke<FreqResponse>('stats_frequencies', { scope }),
  statsConcordance: (args: ConcordanceArgs) => invoke<ConcordanceResponse>('stats_concordance', { args }),
  statsKeyness: (args: KeynessArgs) => invoke<KeynessResponse>('stats_keyness', { args }),
  statsDispersion: (scope: Scope, key: string) =>
    invoke<DispersionResponse>('stats_dispersion', { args: { scope, key } }),
  statsNgrams: (args: NgramArgs) => invoke<NgramRow[]>('stats_ngrams', { args }),
  statsCollocations: (args: CollocationArgs) => invoke<Collocations>('stats_collocations', { args }),
  statsSections: (bookId: number) => invoke<SectionsResponse>('stats_sections', { bookId }),
  statsFreqStatus: () => invoke<FreqStatus>('stats_freq_status'),
  statsBuildFreqTables: () => invoke<FreqStatus>('stats_build_freq_tables'),
  /** A panel's persisted parameters (`lab_setting`), as the JSON it stored. */
  getSetting: (key: string) => invoke<string | null>('lab_setting_get', { key }),
  setSetting: (key: string, value: string) => invoke<void>('lab_setting_set', { key, value }),
  getStopwords: () => invoke<string[]>('get_stopwords'),
  setStopwords: (words: string[]) => invoke<number>('set_stopwords', { words }),
  resetStopwords: () => invoke<string[]>('reset_stopwords'),
  /** Writes to `<lab dir>/exports/` and returns the path. */
  saveExport: (name: string, contents: string) => invoke<string>('save_export', { name, contents }),
};
