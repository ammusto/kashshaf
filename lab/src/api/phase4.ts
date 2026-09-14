/**
 * The Phase 4 panels' slice of the bridge: the transmission network (spec
 * §4.5, §7.7) and poetry extraction (§4.6, experimental).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ------------------------------------------------------------ network ---

export interface NetNode {
  person_id: number;
  name: string;
  occurrences: number;
  degree: number;
  as_source: number;
}

export interface NetEdge {
  /** The earlier transmitter (nearer the source). */
  from: number;
  /** The later one, who transmitted from `from`. */
  to: number;
  weight: number;
}

export interface Graph {
  nodes: NetNode[];
  edges: NetEdge[];
  dropped_nodes: number;
  dropped_edges: number;
  chains: number;
}

export interface Source {
  person_id: number;
  name: string;
  chains: number;
}

export const networkApi = {
  graph: (bookId: number, minWeight: number, nodeCap: number) => invoke<Graph>('network_graph', { bookId, minWeight, nodeCap }),
  ego: (bookId: number, personId: number, minWeight: number) => invoke<Graph>('network_ego', { bookId, personId, minWeight }),
  sources: (bookId: number) => invoke<Source[]>('network_sources', { bookId }),
  export: (bookId: number, format: 'csv' | 'graphml', minWeight: number, nodeCap: number) =>
    invoke<string>('network_export', { bookId, format, minWeight, nodeCap }),
};

// ------------------------------------------------------------- poetry ---

export interface VerseRow {
  part_index: number;
  page_id: number;
  line: number;
  tok_start: number;
  tok_end: number;
  h1: [number, number];
  h2: [number, number] | null;
  h1_text: string;
  h2_text: string;
  marker: string;
  vowelled: number;
  meters: string[];
  pattern: string;
}

export interface PoetryScan {
  book_id: number;
  pages: number;
  pages_done: number;
  verses: VerseRow[];
  with_meter: number;
  vowelled: number;
  elapsed_ms: number;
  cancelled: boolean;
  extractor_version: string;
}

export interface PoetryProgress {
  done: number;
  total: number;
  found: number;
}

export const poetryApi = {
  scan: (bookId: number) => invoke<PoetryScan>('poetry_scan', { bookId }),
  export: (bookId: number, rows: VerseRow[]) => invoke<string>('poetry_export', { bookId, rows }),
  onProgress: (fn: (p: PoetryProgress) => void) => listen<PoetryProgress>('poetry-progress', (e) => fn(e.payload)),
};

/** The meter to show for a verse: one name, "ambiguous" for several, "unknown" for none. */
export function meterLabel(v: VerseRow): string {
  if (v.meters.length === 0) return 'unknown';
  if (v.meters.length === 1) return v.meters[0];
  return `ambiguous (${v.meters.join(' / ')})`;
}
