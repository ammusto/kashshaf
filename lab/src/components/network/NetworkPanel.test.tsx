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
    sources: vi.fn(),
    export: vi.fn(async () => 'C:/lab/exports/book527-network-edges.csv'),
  };
  const isnad = {
    transmitters: vi.fn(),
  };
  return { network, isnad };
});

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

const graph = {
  chains: 3,
  dropped_nodes: 0,
  dropped_edges: 0,
  nodes: [
    { person_id: 1, name: 'أبو داود', occurrences: 3, degree: 3, as_source: 3 },
    { person_id: 2, name: 'مالك', occurrences: 2, degree: 4, as_source: 0 },
    { person_id: 3, name: 'نافع', occurrences: 2, degree: 2, as_source: 0 },
  ],
  edges: [
    { from: 2, to: 1, weight: 2 },
    { from: 3, to: 2, weight: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.network.graph.mockResolvedValue(graph);
  api.network.sources.mockResolvedValue([{ person_id: 1, name: 'أبو داود', chains: 3 }]);
  api.network.ego.mockResolvedValue({ ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1), dropped_nodes: 1, dropped_edges: 1 });
  api.isnad.transmitters.mockResolvedValue([
    { id: 11, isnad_id: 1, position: 1, tok_start: 5, tok_end: 6, raw: 'مالك', kunya: null, ism: 'مالك', nasab: null, nisba: null, laqab: null, verb_before: 'نا', person_id: 2, form_norm: 'مالك', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 2, person_name: 'مالك', suggested_person_name: null },
    { id: 12, isnad_id: 1, position: 0, tok_start: 1, tok_end: 3, raw: 'ابو داود', kunya: 'ابو داود', ism: null, nasab: null, nisba: null, laqab: null, verb_before: 'حدثنا', person_id: 1, form_norm: 'ابو داود', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 3, person_name: 'أبو داود', suggested_person_name: null },
  ]);
});

describe('NetworkPanel', () => {
  it('asks for a book first', () => {
    render(<NetworkPanel book={null} />);
    expect(screen.getByText(/Choose a book/)).toBeInTheDocument();
  });

  it('draws the graph with the view controls and lists the direct sources', async () => {
    render(<NetworkPanel book={book} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledWith(527, 1, 300));
    expect(await screen.findByTestId('network-summary')).toHaveTextContent('3 confirmed chains · 3 persons · 2 edges');
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
    fireEvent.click(screen.getByTestId('node-2'));
    await waitFor(() => expect(api.network.ego).toHaveBeenCalledWith(527, 2, 1));
    await waitFor(() => expect(screen.getByTestId('network-canvas').querySelectorAll('circle').length).toBe(2));
    await waitFor(() => expect(screen.getByTestId('network-rows')).toHaveTextContent('مالك'));
    expect(screen.getByTestId('network-rows')).not.toHaveTextContent('ابو داود');
    expect(screen.getByRole('button', { name: '← whole book' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GraphML' }));
    await waitFor(() => expect(api.network.export).toHaveBeenCalledWith(527, 'graphml', 1, 300));
    expect(await screen.findByRole('status')).toHaveTextContent('Exported to');
  });

  it('says what to do when there are no confirmed linked chains', async () => {
    api.network.graph.mockResolvedValue({ chains: 0, dropped_nodes: 0, dropped_edges: 0, nodes: [], edges: [] });
    api.network.sources.mockResolvedValue([]);
    render(<NetworkPanel book={book} />);
    expect(await screen.findByText(/No confirmed isnāds with linked transmitters yet/)).toBeInTheDocument();
  });
});
