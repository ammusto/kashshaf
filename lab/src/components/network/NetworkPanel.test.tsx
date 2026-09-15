import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The network panel against a mocked bridge (spec §4.5, §7.7): the graph
 * loads with the view controls, changing them reloads, a node click opens
 * its ego graph and its transmitter rows, the sources table lists
 * position-0 persons, and export goes through the backend.
 */

const api = vi.hoisted(() => {
  const network = {
    graph: vi.fn(),
    ego: vi.fn(),
    nodeRows: vi.fn(),
    sources: vi.fn(),
    export: vi.fn(async () => 'C:/lab/exports/book527-network-edges.csv'),
  };
  const isnad = {
    transmitters: vi.fn(),
  };
  const lab = {
    listPages: vi.fn(async (): Promise<unknown[]> => []),
    runSize: vi.fn(async () => ({ book_id: 0, pages: 1, book_pages: 1, tokens: 10, book_tokens: 10 })),
    statsPause: vi.fn(async () => {}),
  };
  return { network, isnad, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));

vi.mock('../../api/phase4', async () => {
  const real = await vi.importActual<typeof import('../../api/phase4')>('../../api/phase4');
  return { ...real, networkApi: api.network };
});
vi.mock('../../api/isnad', async () => {
  const real = await vi.importActual<typeof import('../../api/isnad')>('../../api/isnad');
  return { ...real, isnadApi: api.isnad };
});

import { NetworkPanel } from './NetworkPanel';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };

// Two linked persons and one transmitter nobody has linked yet, which is a
// node of its own keyed by its normalised form (spec 1.5 J2).
const P = (n: number) => ({ Person: n });
const F = (f: string) => ({ Form: f });

const graph = {
  chains: 3,
  dropped_nodes: 0,
  dropped_edges: 0,
  nodes: [
    { id: P(1), person_id: 1, linked: true, name: 'أبو داود', occurrences: 3, degree: 3, as_source: 3 },
    { id: P(2), person_id: 2, linked: true, name: 'مالك', occurrences: 2, degree: 4, as_source: 0 },
    { id: F('نافع'), person_id: null, linked: false, name: 'نافع', occurrences: 2, degree: 2, as_source: 0 },
  ],
  edges: [
    { from: P(2), to: P(1), weight: 2 },
    { from: F('نافع'), to: P(2), weight: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.network.graph.mockResolvedValue(graph);
  api.network.sources.mockResolvedValue([{ id: P(1), person_id: 1, linked: true, name: 'أبو داود', chains: 3 }]);
  api.network.ego.mockResolvedValue({ ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1), dropped_nodes: 1, dropped_edges: 1 });
  api.network.nodeRows.mockImplementation(async (_b: number, node: { Person?: number; Form?: string }) =>
    'Person' in node && node.Person === 2 ? [rows[0]] : 'Form' in node ? [rows[2]] : [rows[1]]
  );
  api.isnad.transmitters.mockResolvedValue(rows);
});

const rows = [
    { id: 11, isnad_id: 1, position: 1, tok_start: 5, tok_end: 6, raw: 'مالك', kunya: null, ism: 'مالك', nasab: null, nisba: null, laqab: null, verb_before: 'نا', person_id: 2, form_norm: 'مالك', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 2, person_name: 'مالك', suggested_person_name: null },
  { id: 12, isnad_id: 1, position: 0, tok_start: 1, tok_end: 3, raw: 'ابو داود', kunya: 'ابو داود', ism: null, nasab: null, nisba: null, laqab: null, verb_before: 'حدثنا', person_id: 1, form_norm: 'ابو داود', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 3, person_name: 'أبو داود', suggested_person_name: null },
  { id: 13, isnad_id: 1, position: 2, tok_start: 8, tok_end: 9, raw: 'نافع', kunya: null, ism: 'نافع', nasab: null, nisba: null, laqab: null, verb_before: 'عن', person_id: null, form_norm: 'نافع', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 2, person_name: null, suggested_person_name: null },
];

describe('NetworkPanel', () => {
  it('asks for a text first', () => {
    render(<NetworkPanel book={null} />);
    expect(screen.getByText(/Open a text from the workspace/)).toBeInTheDocument();
  });

  it('draws the graph with the view controls and lists the direct sources', async () => {
    render(<NetworkPanel book={book} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledWith(527, 1, 300));
    expect(await screen.findByTestId('network-summary')).toHaveTextContent('3 confirmed chains · 3 transmitters (2 linked) · 2 edges');
    const canvas = await screen.findByTestId('network-canvas');
    expect(canvas.querySelectorAll('line').length).toBe(2);
    expect(canvas.querySelectorAll('circle').length).toBe(3);
    expect(screen.getByTestId('network-sources')).toHaveTextContent('أبو داود');
    // The controls reload the graph.
    fireEvent.change(screen.getByLabelText('Min edge weight'), { target: { value: '2' } });
    await waitFor(() => expect(api.network.graph).toHaveBeenLastCalledWith(527, 2, 300));
    fireEvent.change(screen.getByLabelText('Node cap'), { target: { value: '50' } });
    await waitFor(() => expect(api.network.graph).toHaveBeenLastCalledWith(527, 2, 50));
  });

  it('a node click opens the ego graph and the transmitter rows; export goes through the backend', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    await waitFor(() => expect(canvas.querySelectorAll('circle').length).toBe(3));
    // An unlinked transmitter is a node like any other, drawn apart (J2).
    expect(screen.getByTestId('node-f:نافع')).toHaveAttribute('data-linked', 'false');
    expect(screen.getByTestId('node-p1')).toHaveAttribute('data-linked', 'true');

    fireEvent.click(screen.getByTestId('node-p2'));
    await waitFor(() => expect(api.network.ego).toHaveBeenCalledWith(527, { Person: 2 }, 1));
    await waitFor(() => expect(screen.getByTestId('network-canvas').querySelectorAll('circle').length).toBe(2));
    await waitFor(() => expect(screen.getByTestId('network-rows')).toHaveTextContent('مالك'));
    expect(screen.getByTestId('network-rows')).not.toHaveTextContent('ابو داود');
    expect(screen.getByRole('button', { name: '← whole text' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GraphML' }));
    await waitFor(() => expect(api.network.export).toHaveBeenCalledWith(527, 'graphml', 1, 300));
    expect(await screen.findByRole('status')).toHaveTextContent('Exported to');
  });

  it('shows one sentence and nothing else when nothing is confirmed (spec 1.5 J3)', async () => {
    api.network.graph.mockResolvedValue({ chains: 0, dropped_nodes: 0, dropped_edges: 0, nodes: [], edges: [] });
    api.network.sources.mockResolvedValue([]);
    render(<NetworkPanel book={book} />);
    expect(await screen.findByTestId('network-empty')).toHaveTextContent('Confirm at least one isnād to build a network.');
    // No controls over an empty canvas.
    expect(screen.queryByLabelText('Min edge weight')).toBeNull();
    expect(screen.queryByTestId('network-canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'GraphML' })).toBeNull();
  });

  it('redraws when the workbench says something was confirmed (spec 1.5 J1)', async () => {
    const { rerender } = render(<NetworkPanel book={book} version={0} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledTimes(1));
    rerender(<NetworkPanel book={book} version={1} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledTimes(2));
  });
});
