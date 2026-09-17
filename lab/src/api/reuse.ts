/**
 * The reuse and Qurʾān panels' slice of the bridge (spec §4.3, §4.4, §6.4,
 * §7.5, §7.6).
 *
 * Every number shown comes from Rust: re-scoring after a slider change is
 * `reuseApi.rescore`, not a formula repeated here.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PageRef, PageSpan } from './lab';

export type MatchType = 'verbatim' | 'inflected' | 'paraphrase' | 'formulaic' | 'weak';
export type Zone = 'quran' | 'isnad';
export type Verdict = 'confirmed' | 'rejected';

/** §4.3's parameters, with the defaults the panel starts from. */
export interface ReuseParams {
  banality_rank: number;
  anchors: number;
  min_anchors: number;
  anchor_hits: number;
  small_passage: number;
  max_candidates: number;
  gap_open: number;
  gap_extend: number;
  match_lemma: number;
  match_root: number;
  mismatch: number;
  proximity: boolean;
  proximity_window: number;
  min_aligned: number;
  /** Length term on the part of the score above the threshold (0 = off). */
  w_length: number;
  w_lemma: number;
  w_root: number;
  w_surface: number;
  banality_scale: number;
  banality_baseline: number | null;
  threshold: number;
  exclude_zones_from_anchoring: boolean;
  window: number;
  stride: number;
  /**
   * The type table's four cutoffs, in the order they are asked: below
   * `type_formulaic` banality the match is formulaic, then `type_verbatim`
   * surface agreement, `type_inflected` lemma agreement, `type_paraphrase`
   * root agreement, else weak.
   */
  type_formulaic: number;
  type_verbatim: number;
  type_inflected: number;
  type_paraphrase: number;
  /** Extractor confidence at which a chain becomes an isnād zone. */
  isnad_zone_confidence: number;
  /**
   * How candidates are found. `corpus` chooses a handful of rare phrases and
   * looks them up; `exhaustive` reads the target book into memory and looks
   * up every n-gram of the window. Exhaustive needs a target text and is
   * refused above `exhaustive_max_books`.
   */
  retrieval: 'corpus' | 'exhaustive';
  exhaustive_max_books: number;
  /** Tokens the named texts may hold between them; the real ceiling. */
  exhaustive_max_tokens: number;
  exhaustive_grams: number[];
  exhaustive_max_candidates: number;
  /** Percentage of the target book's pages above which an n-gram is skipped. */
  exhaustive_book_ceiling_pct: number;
  /** alNaql's discard gate: top-p% of repeated n-grams are common; a span at
   *  least `discard_common_density` common is dropped, not typed. 0 is off. */
  discard_common_top_pct: number;
  discard_common_density: number;
  /** Re-score the assembled span after merging, as its own gate. */
  validate_merged: boolean;
  /** Hold surface and root beside lemma in the in-memory index; type on the agreement pattern. */
  exhaustive_three_layer: boolean;
  /** Share of a span's found n-grams that must be verbatim for the repetition rule to apply. */
  pattern_min_share: number;
  /** Pages-share above which an n-gram counts as one the target book repeats. */
  formulaic_book_pct: number;
  /** How much of a span must be such phrases before it is typed formulaic. */
  formulaic_span_share: number;
  /** The aligned floor in exhaustive mode, against `min_aligned` in corpus. */
  exhaustive_min_aligned: number;
  /** Books a run may match against; empty is the whole corpus. */
  target_books: number[];
  /** Pages either side of a candidate page the alignment may run over. */
  /** Selection mode: retrieve by the longest rare lemma phrase (set by the selection command in corpus mode). */
  phrase_retrieval: boolean;
  phrase_df_cap: number;
  phrase_min_len: number;
  phrase_min_pages: number;
  phrase_max_queries: number;
  phrase_descent: boolean;
  /** Aligned floor in selection mode: a five-gram that reached the page is a five-token run. */
  selection_min_aligned: number;
  /** Each third of the query contributes at least this many anchors per slot (0 = plain pick). */
  anchor_thirds_min: number;
  target_neighbours: number;
}

export const DEFAULT_REUSE_PARAMS: ReuseParams = {
  banality_rank: 300,
  anchors: 6,
  min_anchors: 3,
  anchor_hits: 2,
  small_passage: 40,
  max_candidates: 500,
  gap_open: -3,
  gap_extend: -1,
  match_lemma: 2,
  match_root: 1,
  mismatch: -2,
  proximity: true,
  proximity_window: 40,
  min_aligned: 6,
  w_length: 0.5,
  w_lemma: 0.5,
  w_root: 0.3,
  w_surface: 0.2,
  banality_scale: 0.5,
  banality_baseline: null,
  threshold: 0.35,
  exclude_zones_from_anchoring: true,
  window: 60,
  stride: 30,
  retrieval: 'corpus',
  exhaustive_max_books: 50,
  exhaustive_max_tokens: 4000000,
  exhaustive_grams: [2, 3],
  exhaustive_max_candidates: 100,
  exhaustive_book_ceiling_pct: 0,
  discard_common_top_pct: 5,
  discard_common_density: 0.8,
  validate_merged: true,
  exhaustive_three_layer: false,
  pattern_min_share: 0.5,
  formulaic_book_pct: 50,
  formulaic_span_share: 0.65,
  exhaustive_min_aligned: 4,
  type_formulaic: 0.3,
  type_verbatim: 0.9,
  type_inflected: 0.85,
  type_paraphrase: 0.7,
  isnad_zone_confidence: 0.5,
  target_books: [],
  phrase_retrieval: false,
  phrase_df_cap: 500,
  phrase_min_len: 5,
  phrase_min_pages: 20,
  phrase_max_queries: 150,
  phrase_descent: false,
  selection_min_aligned: 5,
  anchor_thirds_min: 0,
  target_neighbours: 1,
};

export interface Components {
  surface_agree: number;
  lemma_agree: number;
  root_agree: number;
  coverage: number;
  banal_share: number;
  banality_factor: number;
  aligned: number;
}

export interface Anchor {
  start: number;
  terms: string[];
  rank_sum: number;
}

export interface MatchRow {
  id: number;
  run_id: number;
  book_id: number;
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
  snapshot: string;
  target: PageRef;
  /**
   * Where the target span ends when it runs over a page break. `t_start`,
   * `t_end` and the target side of `pairs` are then offsets from `target`
   * that run past its last token, the way the isnād tables number a chain
   * that spans pages.
   */
  target_end: PageRef | null;
  /**
   * The page the query span ends on, when it runs over a break. Windows are
   * cut against the book's token stream, not per page, so `tok_start`,
   * `tok_end` and the query side of `pairs` are offsets from the page the
   * match starts on and may run past its last token.
   */
  query_end: PageRef | null;
  target_title: string | null;
  target_author: number | null;
  /** The author's name, for the row's hover card (Phase 7 C2). */
  target_author_name: string | null;
  target_death_ah: number | null;
  /** The target book's part count, for its page label (spec 1.5 C1). */
  target_parts: number | null;
  t_start: number;
  t_end: number;
  /** `[query idx, target idx]`, page-absolute. */
  pairs: [number, number][];
  components: Components;
  score: number;
  kind: MatchType;
  zone: Zone | null;
  anchor_hits: number;
  user_verdict: Verdict | null;
}

export interface PassageArgs {
  book_id: number;
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
  params?: ReuseParams;
  exclude_same_book?: boolean;
}

export interface PassageResult {
  run_id: number;
  params: ReuseParams;
  anchors: Anchor[];
  candidates: number;
  tokens: number;
  non_banal: number;
  zones: (Zone | null)[];
  matches: MatchRow[];
  elapsed_ms: number;
  cancelled: boolean;
}

export interface RunRow {
  id: number;
  corpus_version: string;
  book_id: number;
  mode: 'passage' | 'book';
  params: ReuseParams;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  matches: number;
}

export interface Estimate {
  book_id: number;
  pages: number;
  windows: number;
  sampled: number;
  sample_ms: number;
  estimate_ms: number;
  sample_matches: number;
}

export interface BookAggRow {
  book_id: number;
  matches: number;
  aligned_tokens: number;
  best_score: number;
  types: Record<string, number>;
  title: string | null;
  author_id: number | null;
  death_ah: number | null;
}

export interface BookRunSummary {
  run_id: number;
  book_id: number;
  pages: number;
  pages_done: number;
  windows: number;
  windows_done: number;
  matches: number;
  aggregates: BookAggRow[];
  elapsed_ms: number;
  cancelled: boolean;
  params: ReuseParams;
}

export interface LayerSpan {
  id: number;
  tok_start: number;
  tok_end: number;
  score: number;
  kind: MatchType;
  target: PageRef;
  user_verdict: Verdict | null;
}

export interface ReuseProgress {
  stage: 'candidates' | 'align' | 'book' | 'load' | string;
  done: number;
  total: number;
  found: number;
  estimate_ms: number | null;
}

export const reuseApi = {
  passage: (args: PassageArgs) => invoke<PassageResult>('reuse_passage', { args }),
  rescore: (runId: number, params: ReuseParams) => invoke<MatchRow[]>('reuse_rescore', { runId, params }),
  verdict: (matchId: number, verdict: Verdict | null) => invoke<MatchRow>('reuse_verdict', { matchId, verdict }),
  runs: (bookId: number) => invoke<RunRow[]>('reuse_runs', { bookId }),
  matches: (runId: number) => invoke<MatchRow[]>('reuse_matches', { runId }),
  /** `span` limits the run to a section or a page range (spec 1.5 H3). */
  estimate: (bookId: number, params?: ReuseParams, span?: PageSpan | null) =>
    invoke<Estimate>('reuse_estimate', { bookId, params, span: span ?? null }),
  book: (bookId: number, params?: ReuseParams, span?: PageSpan | null) =>
    invoke<BookRunSummary>('reuse_book', { bookId, params, span: span ?? null }),
  pageLayer: (runId: number, partIndex: number, pageId: number, threshold: number) =>
    invoke<LayerSpan[]>('reuse_page_layer', { runId, partIndex, pageId, threshold }),
  export: (runId: number, format: 'csv' | 'json') => invoke<string>('reuse_export', { runId, format }),
  onProgress: (fn: (p: ReuseProgress) => void) => listen<ReuseProgress>('reuse-progress', (e) => fn(e.payload)),
};

// ------------------------------------------------------------- Qurʾān ---

export interface QuranParams {
  min_tokens: number;
  min_lemma_agree: number;
  cued_min_tokens: number;
  cue_window: number;
  banality_rank: number;
  page_window: number;
}

export const DEFAULT_QURAN_PARAMS: QuranParams = {
  min_tokens: 4,
  min_lemma_agree: 0.8,
  cued_min_tokens: 3,
  cue_window: 3,
  banality_rank: 300,
  page_window: 40,
};

export interface QuranStatus {
  available: boolean;
  error: string | null;
  tokens: number;
  ayas: number;
  trigrams: number;
  fourgrams: number;
  fivegrams: number;
  ingest_version: string | null;
  detector_version: string;
}

export interface QuranRunSummary {
  book_id: number;
  pages: number;
  pages_done: number;
  hits: number;
  kept_judged: number;
  elapsed_ms: number;
  cancelled: boolean;
  detector_version: string;
}

export interface QuranMatchRow {
  id: number;
  book_id: number;
  part_index: number;
  page_id: number;
  tok_start: number;
  tok_end: number;
  snapshot: string;
  sura: number;
  sura_name: string;
  aya_start: number;
  aya_end: number;
  q_tok_start: number;
  q_tok_end: number;
  aya_text: string;
  lemma_agree: number;
  surface_agree: number;
  aligned: number;
  cue: string | null;
  user_verdict: Verdict | null;
  detector_version: string;
  /** Other āyāt an ambiguous hit aligns to equally (spec 1.4); empty when unique. */
  also: AyaRef[];
}

export interface AyaRef {
  sura: number;
  aya_start: number;
  aya_end: number;
  q_tok_start: number;
  q_tok_end: number;
}

export interface AyaText {
  sura: number;
  aya: number;
  text: string;
  text_uthmani: string;
}

export interface AyaContext {
  sura: number;
  sura_name: string;
  before: AyaText | null;
  ayas: AyaText[];
  after: AyaText | null;
}

export interface QuranProgress {
  done: number;
  total: number;
  found: number;
  estimate_ms: number | null;
}

export const quranApi = {
  status: () => invoke<QuranStatus>('quran_status'),
  run: (bookId: number, params?: QuranParams) => invoke<QuranRunSummary>('quran_run', { bookId, params }),
  list: (bookId: number) => invoke<QuranMatchRow[]>('quran_list', { bookId }),
  page: (bookId: number, partIndex: number, pageId: number) => invoke<QuranMatchRow[]>('quran_page', { bookId, partIndex, pageId }),
  verdict: (matchId: number, verdict: Verdict | null) => invoke<QuranMatchRow>('quran_verdict', { matchId, verdict }),
  context: (sura: number, ayaStart: number, ayaEnd: number) => invoke<AyaContext>('quran_context', { sura, ayaStart, ayaEnd }),
  export: (bookId: number, format: 'csv' | 'json') => invoke<string>('quran_export', { bookId, format }),
  onProgress: (fn: (p: QuranProgress) => void) => listen<QuranProgress>('quran-progress', (e) => fn(e.payload)),
};

/** Sort order of the types in tables: formulaic last (§4.3). */
export const TYPE_ORDER: MatchType[] = ['verbatim', 'inflected', 'paraphrase', 'weak', 'formulaic'];

export function typeRank(t: MatchType): number {
  const i = TYPE_ORDER.indexOf(t);
  return i < 0 ? TYPE_ORDER.length : i;
}

/** `mm:ss` for an estimate. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}
