/**
 * The Phase 4 panels' slice of the bridge: the transmission network (spec
 * §4.5, §7.7) and poetry extraction (§4.6, experimental).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TransmitterListRow } from './isnad';

// ------------------------------------------------------------ network ---

/**
 * A node's identity (spec 1.5 §J2): a person when the transmitter is linked
 * to one, and otherwise the normalised name form itself. Serialised
 * untagged, so it arrives as `{ Person: 7 }` or `{ Form: "مالك" }`.
 */
export type NodeId = { Person: number } | { Form: string };

export function nodeKey(id: NodeId): string {
  return 'Person' in id ? `p${id.Person}` : `f:${id.Form}`;
}

export function sameNode(a: NodeId, b: NodeId): boolean {
  return nodeKey(a) === nodeKey(b);
}

export interface NetNode {
  id: NodeId;
  /** Set when the node is a person; absent for a bare name form. */
  person_id: number | null;
  /** Whether a person stands behind this node (spec §J2). */
  linked: boolean;
  name: string;
  occurrences: number;
  degree: number;
  as_source: number;
}

export interface NetEdge {
  /** The earlier transmitter (nearer the source). */
  from: NodeId;
  /** The later one, who transmitted from `from`. */
  to: NodeId;
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
  id: NodeId;
  person_id: number | null;
  linked: boolean;
  name: string;
  chains: number;
}

export const networkApi = {
  graph: (bookId: number, minWeight: number, nodeCap: number) => invoke<Graph>('network_graph', { bookId, minWeight, nodeCap }),
  ego: (bookId: number, node: NodeId, minWeight: number) => invoke<Graph>('network_ego', { bookId, node, minWeight }),
  /** The transmitter rows behind one node, linked or not (spec §J2). */
  nodeRows: (bookId: number, node: NodeId) => invoke<TransmitterListRow[]>('network_node_rows', { bookId, node }),
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
